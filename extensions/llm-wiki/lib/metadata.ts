import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { KnowledgeDiagnostic, KnowledgeDocument } from "./knowledge-document.js";
import {
  buildResolvedBacklinks,
  buildWikilinkIndex,
  type WikilinkIndex,
} from "./knowledge-links.js";
import { isPathWithin, readJson, type VaultPaths } from "./utils.js";
import {
  assertWritableVault,
  compareCodePoint,
  discoverKnowledgeDocuments,
  inspectVaultFormat,
} from "./vault-format.js";

/**
 * Metadata generation for the LLM Wiki.
 *
 * Rebuilds registry.json, backlinks.json, index.md, log.md deterministically
 * from the current state of wiki/ and raw/. In OKF mode, also generates
 * wiki/index.md and wiki/log.md projections.
 *
 * Fail-closed: computes all outputs in memory before writing any file.
 * Blocking diagnostics prevent any writes.
 */

export interface RegistryEntry {
  type: string;
  title: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface Registry {
  version: string;
  last_updated: string;
  pages: Record<string, RegistryEntry>;
}

export interface Backlinks {
  [pageId: string]: string[];
}

export interface WikiEvent {
  timestamp: string;
  kind: string;
  [key: string]: unknown;
}

export interface ProjectionResult {
  ok: boolean;
  diagnostics: KnowledgeDiagnostic[];
  registry?: Registry;
  backlinks?: Backlinks;
}

/** Rebuild the complete metadata layer with fail-closed semantics. */
export function rebuildMetadata(paths: VaultPaths): ProjectionResult {
  // Step 1: Validate vault format and mode
  const vaultState = inspectVaultFormat(paths);
  if (vaultState.blocking) {
    return { ok: false, diagnostics: vaultState.diagnostics };
  }

  // Step 2: Discover all knowledge documents
  const discovery = discoverKnowledgeDocuments(paths);
  if (discovery.blocking) {
    return { ok: false, diagnostics: discovery.diagnostics };
  }

  const documents = discovery.documents;
  const allDiagnostics: KnowledgeDiagnostic[] = [
    ...vaultState.diagnostics,
    ...discovery.diagnostics,
  ];

  // Step 3: Build registry from documents + raw fallbacks
  const registry = buildRegistry(paths, documents);

  // Step 4: Build backlinks from discovered documents
  const wikilinkIndex = buildWikilinkIndex(documents.map((d) => d.id));
  const backlinks = buildBacklinks(documents, wikilinkIndex, allDiagnostics);

  const eventSource = readEventSource(join(paths.meta, "events.jsonl"));
  const eventLogResult = eventSource.available ? buildOkfLog(eventSource.content) : undefined;
  if (eventLogResult) allDiagnostics.push(...eventLogResult.diagnostics);
  else if (!eventSource.available) allDiagnostics.push(eventSource.diagnostic);

  // Step 5: Build meta/index.md
  const metaIndex = buildIndexMarkdown(registry);

  // Step 6: Build meta/log.md (existing rich format)
  const metaLog = eventSource.available ? buildLogMarkdown(eventSource.content) : undefined;

  // Step 7: Build OKF projections if in okf-0.2 mode
  const okfIndexes: Map<string, string> | null =
    vaultState.knowledgeFormat === "okf-0.2"
      ? buildDirectoryIndexes(documents, readJson(join(paths.dotWiki, "config.json"), {}))
      : null;

  const okfLog: string | undefined =
    vaultState.knowledgeFormat === "okf-0.2" ? eventLogResult?.markdown : undefined;

  // Step 8: Atomic write all projections
  mkdirSync(paths.meta, { recursive: true });

  const registryJson = `${JSON.stringify(registry, null, 2)}\n`;
  const backlinksJson = `${JSON.stringify(backlinks, null, 2)}\n`;

  atomicWriteFile(join(paths.meta, "registry.json"), registryJson);
  atomicWriteFile(join(paths.meta, "backlinks.json"), backlinksJson);
  atomicWriteFile(join(paths.meta, "index.md"), metaIndex);
  if (metaLog !== undefined) atomicWriteFile(join(paths.meta, "log.md"), metaLog);

  // Step 9: Write OKF projections if applicable
  if (okfIndexes && okfIndexes.size > 0) {
    mkdirSync(paths.wiki, { recursive: true });
    for (const [indexPath, content] of okfIndexes) {
      atomicWriteFile(join(paths.wiki, indexPath), content);
    }
    // Prune obsolete generated indexes
    pruneObsoleteIndexes(paths, okfIndexes);
  }

  if (okfLog !== undefined) {
    mkdirSync(paths.wiki, { recursive: true });
    atomicWriteFile(join(paths.wiki, "log.md"), okfLog);
  }

  return {
    ok: true,
    diagnostics: allDiagnostics,
    registry,
    backlinks,
  };
}

/** Lightweight rebuild is the same as full rebuild. */
export const rebuildMetadataLight = rebuildMetadata;

/** Build registry from discovered documents and raw fallbacks. */
function buildRegistry(paths: VaultPaths, documents: KnowledgeDocument[]): Registry {
  const pages: Record<string, RegistryEntry> = {};

  // Add discovered documents
  for (const doc of documents) {
    const title = getSemanticTitle(doc);
    const entry: RegistryEntry = {
      type: doc.frontmatter.type,
      title,
    };
    // Copy known frontmatter fields (excluding type which is already set)
    for (const key of [
      "description",
      "tags",
      "category",
      "domain",
      "aliases",
      "recall_triggers",
      "status",
      "stale_after",
      "resource",
      "generated",
      "verified",
      "summary",
      "raw_path",
      "source_id",
    ] as const) {
      if (doc.frontmatter[key] !== undefined) {
        entry[key] = doc.frontmatter[key];
      }
    }
    // Copy extension fields
    for (const [key, value] of Object.entries(doc.extensions)) {
      if (!(key in entry)) {
        entry[key] = value;
      }
    }
    // Only include created/updated if they are non-empty strings
    if (typeof doc.frontmatter.created === "string" && doc.frontmatter.created.trim()) {
      entry.created = doc.frontmatter.created;
    }
    if (typeof doc.frontmatter.updated === "string" && doc.frontmatter.updated.trim()) {
      entry.updated = doc.frontmatter.updated;
    }
    pages[doc.id] = entry;
  }

  // Raw source/trajectory fallback entries (registry-only compatibility)
  addRawFallbacks(paths, pages, "sources", "source");
  addRawFallbacks(paths, pages, "trajectories", "trajectory");

  return {
    version: "1.0",
    last_updated: new Date().toISOString(),
    pages,
  };
}

function addRawFallbacks(
  paths: VaultPaths,
  pages: Record<string, RegistryEntry>,
  dirName: "sources" | "trajectories",
  type: string,
): void {
  const rawDir = dirName === "sources" ? paths.rawSources : paths.rawTrajectories;
  if (!existsSync(rawDir)) return;

  for (const entry of readdirSync(rawDir)) {
    const manifestPath = join(rawDir, entry, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = readJson<Record<string, unknown>>(manifestPath, {});
    const id = String(manifest.id || entry);
    const pageKey = `${dirName}/${id}`;

    // Don't overwrite a parsed document
    if (pages[pageKey]) continue;

    const captured = String(manifest.captured || "");
    pages[pageKey] = {
      type,
      title: String(manifest.title || id),
      ...(captured ? { created: captured, updated: captured } : {}),
      ...manifest,
    };
  }
}

function getSemanticTitle(doc: KnowledgeDocument): string {
  if (typeof doc.frontmatter.title === "string" && doc.frontmatter.title.trim()) {
    return doc.frontmatter.title.trim();
  }
  return doc.id.split("/").pop() || "Untitled";
}

/** Build backlinks from discovered documents using shared link resolution. */
function buildBacklinks(
  documents: KnowledgeDocument[],
  index: WikilinkIndex,
  diagnostics: KnowledgeDiagnostic[],
): Backlinks {
  const inbound: Backlinks = {};

  // Initialize parsed concept IDs with empty arrays
  for (const doc of documents) {
    inbound[doc.id] = [];
  }

  // Resolve links for each document
  for (const doc of documents) {
    const result = buildResolvedBacklinks(doc.id, doc.body, index);
    diagnostics.push(...result.diagnostics);
    for (const target of result.targets) {
      if (inbound[target] && !inbound[target].includes(doc.id)) {
        inbound[target].push(doc.id);
      }
    }
  }

  // Sort targets for determinism
  for (const [id, targets] of Object.entries(inbound)) {
    inbound[id] = [...targets].sort(compareCodePoint);
  }

  return inbound;
}

/** Build meta/index.md in existing rich format. */
function buildIndexMarkdown(registry: Registry): string {
  const byType: Record<string, Array<{ id: string; entry: RegistryEntry }>> = {};

  for (const [id, entry] of Object.entries(registry.pages)) {
    const t = entry.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push({ id, entry });
  }

  const sections: string[] = [];
  sections.push(
    "# Wiki Index\n\n> Auto-generated from meta/registry.json. Do not edit manually.\n",
  );

  for (const [type, items] of Object.entries(byType).sort()) {
    const label = `${type.charAt(0).toUpperCase() + type.slice(1)}s`;
    sections.push(`## ${label}\n`);
    for (const { id, entry } of items.sort((a, b) => a.id.localeCompare(b.id))) {
      sections.push(`- [[${id}]] — ${entry.title} *(created: ${entry.created || "unknown"})*`);
    }
    sections.push("");
  }

  sections.push(
    `---\n*Last updated: ${registry.last_updated}* | *Total pages: ${Object.keys(registry.pages).length}*`,
  );
  return `${sections.join("\n")}\n`;
}

function buildLogMarkdown(eventsJsonl: string): string {
  const events: WikiEvent[] = [];
  const raw = eventsJsonl.trim();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const candidate: unknown = JSON.parse(line);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        events.push(candidate as WikiEvent);
      }
    } catch {
      // Keep backward-compatible rich-log behavior: malformed lines are omitted.
    }
  }

  const lines: string[] = [];
  lines.push("# Activity Log\n\n> Auto-generated from meta/events.jsonl. Do not edit manually.\n");

  for (const ev of events) {
    const ts = ev.timestamp || "unknown";
    const kind = ev.kind || "event";
    const details = Object.entries(ev)
      .filter(([k]) => k !== "timestamp" && k !== "kind")
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");

    lines.push(`## [${ts}] ${kind}`);
    if (details) lines.push(`- ${details}`);
    lines.push("");
  }

  if (events.length === 0) lines.push("_No events recorded yet._\n");
  return `${lines.join("\n")}\n`;
}

/** Append an event to events.jsonl. */
export function appendEvent(paths: VaultPaths, event: Omit<WikiEvent, "timestamp">): void {
  assertWritableVault(paths);
  const { timestamp: _ignored, kind: rawKind, ...details } = event as WikiEvent;
  const kind = typeof rawKind === "string" ? rawKind.trim() : "";
  if (!kind) throw new Error("Event kind must be a non-empty string");
  mkdirSync(paths.meta, { recursive: true });
  const eventsPath = join(paths.meta, "events.jsonl");
  const line = JSON.stringify({ ...details, timestamp: new Date().toISOString(), kind });
  writeFileSync(eventsPath, `${line}\n`, { flag: "a", encoding: "utf-8" });
}

/** Atomic write: temp file + rename. */
function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

type EventSourceRead =
  | { available: true; content: string }
  | { available: false; diagnostic: KnowledgeDiagnostic };

function readEventSource(filePath: string, diagnosticPath = "meta/events.jsonl"): EventSourceRead {
  try {
    return { available: true, content: readFileSync(filePath, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT = missing; ENOTDIR/EISDIR = not a regular file (FreeBSD dir hazard); else unreadable
    const diagnosticCode = code === "ENOENT" ? "event_source_missing" : "event_source_unreadable";
    const message =
      diagnosticCode === "event_source_missing"
        ? "Authoritative event source is missing; existing log projections were preserved"
        : "Authoritative event source is unreadable; existing log projections were preserved";
    return {
      available: false,
      diagnostic: okfDiag("warning", diagnosticCode, diagnosticPath, message),
    };
  }
}

/** Prune obsolete generated indexes in OKF mode. */
function pruneObsoleteIndexes(paths: VaultPaths, currentIndexes: Map<string, string>): void {
  const currentPaths = new Set(currentIndexes.keys());

  function walkDir(dir: string, relative: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      const relPath = relative ? `${relative}/${entry}` : entry;
      if (entry.toLowerCase() === "index.md") {
        results.push(relPath);
      } else if (stat.isDirectory()) {
        results.push(...walkDir(fullPath, relPath));
      }
    }
    return results;
  }

  const allIndexes = walkDir(paths.wiki, "");
  for (const indexPath of allIndexes) {
    // Never prune root index.md
    if (indexPath === "index.md") continue;
    if (!currentPaths.has(indexPath)) {
      const fullPath = join(paths.wiki, indexPath);
      try {
        if (lstatSync(fullPath).isSymbolicLink() || !isPathWithin(paths.wiki, fullPath)) continue;
        rmSync(fullPath);
        // Try to remove parent dir if empty
        const parentDir = dirname(fullPath);
        if (
          !lstatSync(parentDir).isSymbolicLink() &&
          isPathWithin(paths.wiki, parentDir) &&
          existsSync(parentDir) &&
          readdirSync(parentDir).length === 0
        ) {
          rmSync(parentDir);
        }
      } catch {
        // Ignore errors during pruning
      }
    }
  }
}

// ===== OKF Projection Renderers =====

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function encodeRelativePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function compactDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact || undefined;
}

export function buildDirectoryIndexes(
  documents: KnowledgeDocument[],
  config: { name?: unknown },
): Map<string, string> {
  const indexes = new Map<string, string>();

  // Build directory tree from concept documents only
  const directories = new Map<string, { dirs: Set<string>; concepts: KnowledgeDocument[] }>();

  for (const doc of documents) {
    const parts = doc.id.split("/");

    // Walk the path, tracking parent-child directory relationships
    for (let i = 0; i < parts.length; i++) {
      const parentPath = i === 0 ? "" : parts.slice(0, i).join("/");
      if (!directories.has(parentPath)) {
        directories.set(parentPath, { dirs: new Set(), concepts: [] });
      }

      if (i === parts.length - 1) {
        // Last part is the concept file
        directories.get(parentPath)!.concepts.push(doc);
      } else {
        // This is a subdirectory
        directories.get(parentPath)!.dirs.add(parts[i]);
      }
    }
  }

  // Always emit root index
  const vaultName =
    typeof config.name === "string" && config.name.trim() ? config.name.trim() : "Wiki";
  if (!directories.has("")) {
    directories.set("", { dirs: new Set(), concepts: [] });
  }

  // Render each index
  for (const [dirPath, { dirs, concepts }] of directories) {
    const indexPath = dirPath ? `${dirPath}/index.md` : "index.md";
    const lines: string[] = [];

    if (dirPath === "") {
      lines.push("---");
      lines.push('okf_version: "0.2"');
      lines.push("---");
      lines.push("");
      lines.push(`# ${escapeLabel(vaultName)}`);
    } else {
      const dirName = dirPath.split("/").pop()!;
      lines.push(`# ${escapeLabel(dirName)}`);
    }

    // List directories first
    if (dirs.size > 0) {
      lines.push("");
      lines.push("## Directories");
      lines.push("");
      for (const subDir of [...dirs].sort(compareCodePoint)) {
        const encoded = encodeRelativePath(`${subDir}/index.md`);
        lines.push(`- [${escapeLabel(subDir)}/](${encoded})`);
      }
    }

    // List concepts
    if (concepts.length > 0) {
      lines.push("");
      lines.push("## Concepts");
      lines.push("");
      const sorted = [...concepts].sort((a, b) => {
        const aRel = dirPath ? a.id.slice(dirPath.length + 1) : a.id;
        const bRel = dirPath ? b.id.slice(dirPath.length + 1) : b.id;
        return compareCodePoint(aRel, bRel);
      });
      for (const doc of sorted) {
        const relId = dirPath ? doc.id.slice(dirPath.length + 1) : doc.id;
        const title =
          typeof doc.frontmatter.title === "string" && doc.frontmatter.title.trim()
            ? doc.frontmatter.title.trim()
            : relId.split("/").pop()!;
        const desc = compactDescription(doc.frontmatter.description);
        const encoded = encodeRelativePath(`${relId}.md`);
        const descPart = desc ? ` — ${desc}` : "";
        lines.push(`- [${escapeLabel(title)}](${encoded})${descPart}`);
      }
    }

    indexes.set(indexPath, `${lines.join("\n")}\n`);
  }

  return indexes;
}

export interface OkfLogResult {
  markdown: string;
  diagnostics: KnowledgeDiagnostic[];
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodePoint(a, b))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

function okfDiag(
  severity: "warning" | "error",
  code: KnowledgeDiagnostic["code"],
  path: string,
  message: string,
): KnowledgeDiagnostic {
  return { severity, code, path, message };
}

export function buildOkfLog(eventsJsonl: string, path = "meta/events.jsonl"): OkfLogResult {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const events: Array<{
    seq: number;
    timestamp: string;
    epoch: number;
    date: string;
    kind: string;
    details: string;
  }> = [];

  const lines = eventsJsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      const candidate: unknown = JSON.parse(line);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("event must be a JSON object");
      }
      parsed = candidate as Record<string, unknown>;
    } catch {
      diagnostics.push(
        okfDiag("warning", "event_invalid_json", path, `Invalid JSON at line ${i + 1}`),
      );
      continue;
    }

    const rawTs = parsed.timestamp;
    if (typeof rawTs !== "string" || Number.isNaN(Date.parse(rawTs))) {
      diagnostics.push(
        okfDiag("warning", "event_invalid_timestamp", path, `Invalid timestamp at line ${i + 1}`),
      );
      continue;
    }

    const rawKind = parsed.kind;
    if (typeof rawKind !== "string" || !rawKind.trim()) {
      diagnostics.push(
        okfDiag("warning", "event_missing_kind", path, `Missing kind at line ${i + 1}`),
      );
      continue;
    }

    const ts = new Date(rawTs);
    const date = ts.toISOString().split("T")[0];
    const kind = rawKind.trim();

    const detailEntries: [string, unknown][] = Object.entries(parsed).filter(
      ([k]) => k !== "timestamp" && k !== "kind",
    );
    const details =
      detailEntries.length > 0
        ? JSON.stringify(canonicalJsonValue(Object.fromEntries(detailEntries)))
        : "";

    events.push({ seq: i, timestamp: rawTs, epoch: ts.getTime(), date, kind, details });
  }

  // Group by date
  const byDate = new Map<string, typeof events>();
  for (const ev of events) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date)!.push(ev);
  }

  const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

  const outLines: string[] = ["# Wiki Update Log"];

  for (const date of sortedDates) {
    const dayEvents = byDate.get(date)!;
    dayEvents.sort((a, b) => b.epoch - a.epoch || b.seq - a.seq);

    outLines.push("");
    outLines.push(`## ${date}`);
    outLines.push("");

    for (const ev of dayEvents) {
      const escapedKind = ev.kind
        .replace(/\\/g, "\\\\")
        .replace(/\*/g, "\\*")
        .replace(/_/g, "\\_")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\s+/g, " ");

      if (ev.details) {
        outLines.push(`- **${escapedKind}**: ${ev.details}`);
      } else {
        outLines.push(`- **${escapedKind}**`);
      }
    }
  }

  return {
    markdown: `${outLines.join("\n")}\n`,
    diagnostics,
  };
}
