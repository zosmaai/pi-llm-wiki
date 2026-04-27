import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type VaultPaths,
  extractWikilinks,
  findWikiPages,
  fmtDate,
  parseFrontmatter,
  readJson,
  readText,
  writeJson,
} from "./utils.js";

/**
 * Metadata generation for the LLM Wiki.
 *
 * Rebuilds registry.json, backlinks.json, index.md, log.md, and lint-report.md
 * deterministically from the current state of raw/ and wiki/.
 */

export interface RegistryEntry {
  type: "source" | "entity" | "concept" | "synthesis" | "analysis";
  title: string;
  created: string;
  updated: string;
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

/** Rebuild the complete metadata layer. */
export function rebuildMetadata(paths: VaultPaths): void {
  mkdirSync(paths.meta, { recursive: true });

  const registry = buildRegistry(paths);
  const backlinks = buildBacklinks(paths, registry);

  writeJson(join(paths.meta, "registry.json"), registry);
  writeJson(join(paths.meta, "backlinks.json"), backlinks);
  writeFileSync(join(paths.meta, "index.md"), buildIndexMarkdown(registry), "utf-8");

  const log = buildLogMarkdown(paths);
  writeFileSync(join(paths.meta, "log.md"), log, "utf-8");
}

/** Build registry from wiki/ and raw/ state. */
export function buildRegistry(paths: VaultPaths): Registry {
  const pages: Record<string, RegistryEntry> = {};

  // Scan wiki pages
  for (const page of findWikiPages(paths.wiki)) {
    const { frontmatter } = parseFrontmatter(page.content);
    const type = String(frontmatter.type || "page") as RegistryEntry["type"];
    const title = String(frontmatter.title || page.relative.split("/").pop() || "Untitled");

    pages[page.relative] = {
      type,
      title,
      created: String(frontmatter.created || fmtDate()),
      updated: String(frontmatter.updated || frontmatter.created || fmtDate()),
      ...frontmatter,
    };
  }

  // Scan raw source packets
  if (existsSync(paths.rawSources)) {
    for (const entry of readdirSync(paths.rawSources)) {
      const manifestPath = join(paths.rawSources, entry, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = readJson<Record<string, unknown>>(manifestPath, {});
      const id = String(manifest.id || entry);
      const sourcePage = `sources/${id}`;

      if (!pages[sourcePage]) {
        pages[sourcePage] = {
          type: "source",
          title: String(manifest.title || id),
          created: String(manifest.captured || fmtDate()),
          updated: String(manifest.captured || fmtDate()),
          ...manifest,
        };
      }
    }
  }

  return {
    version: "1.0",
    last_updated: new Date().toISOString(),
    pages,
  };
}

/** Build backlinks map from all wiki pages. */
export function buildBacklinks(paths: VaultPaths, registry: Registry): Backlinks {
  const inbound: Backlinks = {};

  // Initialize all pages with empty arrays
  for (const id of Object.keys(registry.pages)) {
    inbound[id] = [];
  }

  // Count inbound links
  for (const page of findWikiPages(paths.wiki)) {
    const links = extractWikilinks(page.content);
    for (const link of links) {
      if (inbound[link] && !inbound[link].includes(page.relative)) {
        inbound[link].push(page.relative);
      }
    }
  }

  return inbound;
}

/** Build index markdown from registry. */
export function buildIndexMarkdown(registry: Registry): string {
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
      sections.push(`- [[${id}]] — ${entry.title} *(created: ${entry.created})*`);
    }
    sections.push("");
  }

  sections.push(
    `---\n*Last updated: ${registry.last_updated}* | *Total pages: ${Object.keys(registry.pages).length}*`,
  );
  return `${sections.join("\n")}\n`;
}

/** Build log markdown from events.jsonl. */
export function buildLogMarkdown(paths: VaultPaths): string {
  const eventsPath = join(paths.meta, "events.jsonl");
  const events: WikiEvent[] = [];

  if (existsSync(eventsPath)) {
    const raw = readFileSync(eventsPath, "utf-8").trim();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as WikiEvent);
      } catch {
        // skip malformed
      }
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

  if (events.length === 0) {
    lines.push("_No events recorded yet._\n");
  }

  return `${lines.join("\n")}\n`;
}

/** Append an event to events.jsonl. */
export function appendEvent(paths: VaultPaths, event: Omit<WikiEvent, "timestamp">): void {
  mkdirSync(paths.meta, { recursive: true });
  const eventsPath = join(paths.meta, "events.jsonl");
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  writeFileSync(eventsPath, `${line}\n`, { flag: "a", encoding: "utf-8" });
}

/** Quick lightweight metadata rebuild (backlinks + index + log only). */
export function rebuildMetadataLight(paths: VaultPaths): void {
  const registry = buildRegistry(paths);
  const backlinks = buildBacklinks(paths, registry);
  writeJson(join(paths.meta, "registry.json"), registry);
  writeJson(join(paths.meta, "backlinks.json"), backlinks);
  writeFileSync(join(paths.meta, "index.md"), buildIndexMarkdown(registry), "utf-8");

  const log = buildLogMarkdown(paths);
  writeFileSync(join(paths.meta, "log.md"), log, "utf-8");
}
