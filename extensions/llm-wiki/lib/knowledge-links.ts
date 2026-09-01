import type { Definition, Link, LinkReference, Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import { slugify } from "./utils.js";
import { compareCodePoint } from "./vault-format.js";

export interface ExtractedLink {
  target: string;
  offset: number;
}

export interface KnowledgeLinks {
  markdown: ExtractedLink[];
  wikilinks: ExtractedLink[];
}

export interface UnresolvedKnowledgeLink {
  target: string;
  syntax: "markdown" | "wikilink";
}

export interface ResolvedBacklinks {
  targets: string[];
  unresolved: UnresolvedKnowledgeLink[];
  diagnostics: KnowledgeDiagnostic[];
}

function diag(
  severity: "warning" | "error",
  code: KnowledgeDiagnostic["code"],
  path: string,
  message: string,
): KnowledgeDiagnostic {
  return { severity, code, path, message };
}

function normalizeWikilinkTarget(target: string): string {
  return target.trim().replace(/\\$/, "");
}

export function extractKnowledgeLinks(body: string): KnowledgeLinks {
  const markdown: ExtractedLink[] = [];
  const wikilinks: ExtractedLink[] = [];

  // Extract legacy wikilinks. A table-safe alias uses an escaped pipe: [[target\\|alias]].
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    wikilinks.push({ target: normalizeWikilinkTarget(match[1]), offset: match.index ?? 0 });
  }

  // Parse with CommonMark AST
  let tree: Root;
  try {
    tree = fromMarkdown(body);
  } catch {
    return { markdown, wikilinks };
  }

  // Build definition map (case-insensitive)
  const defs = new Map<string, Definition>();
  function collectDefs(node: Nodes) {
    if (node.type === "definition") {
      defs.set(node.identifier.toLowerCase(), node);
    }
    if ("children" in node && Array.isArray((node as { children?: Nodes[] }).children)) {
      for (const child of (node as { children: Nodes[] }).children) {
        collectDefs(child);
      }
    }
  }
  collectDefs(tree);

  // Track used definitions
  const usedDefs = new Set<string>();

  // Visit nodes for links
  function visit(node: Nodes) {
    // Skip code spans, fenced/indented code blocks, and raw HTML
    if (node.type === "inlineCode" || node.type === "code" || node.type === "html") return;

    if (node.type === "link") {
      const link = node as Link;
      // Skip autolinks (source starts with <)
      if (link.url && link.position) {
        const source = body.slice(link.position.start.offset, link.position.end.offset);
        if (!source.startsWith("<")) {
          markdown.push({ target: link.url, offset: link.position.start.offset ?? 0 });
        }
      }
    }

    if (node.type === "linkReference") {
      const ref = node as LinkReference;
      const ident = (ref.identifier ?? "").toLowerCase();
      const def = defs.get(ident);
      if (def && !usedDefs.has(ident)) {
        usedDefs.add(ident);
        if (ref.position) {
          markdown.push({ target: def.url, offset: ref.position.start.offset ?? 0 });
        }
      }
    }

    // Recurse into children
    if ("children" in node && Array.isArray((node as { children?: Nodes[] }).children)) {
      for (const child of (node as { children: Nodes[] }).children) {
        visit(child);
      }
    }
  }

  visit(tree);

  return { markdown, wikilinks };
}

export function extractLegacyWikilinks(body: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    links.push({ target: normalizeWikilinkTarget(match[1]), offset: match.index ?? 0 });
  }
  return links;
}

// ── Wikilink normalization ──────────────────────────────────────────

export interface WikilinkIndex {
  /** NFC-normalized id → canonical id. */
  byExact: Map<string, string>;
  /** Slugified full path → matching canonical ids. */
  byNormPath: Map<string, string[]>;
  /** Slugified basename (no folder) → matching canonical ids. */
  byNormSlug: Map<string, string[]>;
}

export function buildWikilinkIndex(ids: Iterable<string>): WikilinkIndex {
  const byExact = new Map<string, string>();
  const byNormPath = new Map<string, string[]>();
  const byNormSlug = new Map<string, string[]>();

  function push<K>(map: Map<K, string[]>, key: K, value: string): void {
    const existing = map.get(key);
    if (existing) existing.push(value);
    else map.set(key, [value]);
  }

  for (const id of ids) {
    byExact.set(id.normalize("NFC"), id);
    const segments = id.split("/");
    const normFull = segments.map((s) => slugify(s)).join("/");
    const normBase = slugify(segments[segments.length - 1]);
    push(byNormPath, normFull, id);
    push(byNormSlug, normBase, id);
  }

  return { byExact, byNormPath, byNormSlug };
}

export type WikilinkResolution =
  | { kind: "resolved"; id: string }
  | { kind: "ambiguous"; target: string; candidates: string[] }
  | { kind: "missing"; target: string };

export function resolveWikilink(target: string, index: WikilinkIndex): WikilinkResolution {
  const cleaned = target.trim().replace(/\\$/, "");
  if (!cleaned) return { kind: "missing", target: "" };

  // Fast path: exact NFC match
  const exact = index.byExact.get(cleaned.normalize("NFC"));
  if (exact) return { kind: "resolved", id: exact };

  // Normalized full path (fixes case/space/slug drift in folder-qualified links)
  const normFull = cleaned
    .split("/")
    .map((s) => slugify(s))
    .join("/");
  const pathHits = index.byNormPath.get(normFull);
  if (pathHits && pathHits.length === 1) return { kind: "resolved", id: pathHits[0] };
  if (pathHits && pathHits.length > 1)
    return { kind: "ambiguous", target: cleaned, candidates: pathHits };

  // Bare title: match by slugified basename (handles [[zosma harness]] → entities/zosma-harness)
  if (!cleaned.includes("/")) {
    const baseHits = index.byNormSlug.get(slugify(cleaned));
    if (baseHits && baseHits.length === 1) return { kind: "resolved", id: baseHits[0] };
    if (baseHits && baseHits.length > 1)
      return { kind: "ambiguous", target: cleaned, candidates: baseHits };
  }

  return { kind: "missing", target: cleaned };
}

function resolveMarkdownTarget(
  target: string,
  sourceId: string,
):
  | { kind: "concept"; id: string }
  | { kind: "escape" }
  | { kind: "external" }
  | { kind: "empty" }
  | { kind: "invalid" } {
  // Strip query and fragment (earliest delimiter)
  const qIndex = target.indexOf("?");
  const fIndex = target.indexOf("#");
  let clean = target;
  let cut = -1;
  if (qIndex !== -1 && (fIndex === -1 || qIndex < fIndex)) cut = qIndex;
  else if (fIndex !== -1) cut = fIndex;
  if (cut !== -1) clean = target.slice(0, cut);

  // Ignore empty fragment-only targets
  if (!clean || clean === "#") return { kind: "empty" };

  // Ignore external URI schemes
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return { kind: "external" };

  // Percent-decode each segment once, but never let malformed user input escape
  // the link diagnostics boundary.
  let decoded: string[];
  try {
    decoded = clean.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return { kind: "invalid" };
  }

  // Convert decoded backslashes to /
  const normalized = decoded.map((s) => s.replace(/\\/g, "/")).join("/");

  const sourceDir = sourceId.replace(/[^/]*$/, ""); // directory of source
  const parts = normalized.split("/");
  const isRootRelative = normalized.startsWith("/");

  if (isRootRelative) {
    // Root-relative: resolve with explicit stack
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "") continue;
      if (part === ".") continue;
      if (part === "..") {
        if (stack.length === 0) return { kind: "escape" };
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    const resolved = stack.join("/");
    if (!resolved.endsWith(".md")) return { kind: "empty" };
    return { kind: "concept", id: resolved.slice(0, -3) };
  }

  // For file-relative paths, resolve against source directory
  const baseParts = sourceDir.split("/").filter(Boolean);
  const allParts = [...baseParts];

  for (const part of parts) {
    if (part === "" || part === ".") {
    } else if (part === "..") {
      if (allParts.length === 0) {
        return { kind: "escape" };
      }
      allParts.pop();
    } else {
      allParts.push(part);
    }
  }

  const resolved = allParts.join("/");

  // Require .md suffix for Markdown links
  if (resolved.endsWith(".md")) {
    return { kind: "concept", id: resolved.slice(0, -3) };
  }

  return { kind: "empty" };
}

export function buildResolvedBacklinks(
  sourceId: string,
  body: string,
  index: WikilinkIndex,
): ResolvedBacklinks {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const unresolved: UnresolvedKnowledgeLink[] = [];
  const targets = new Set<string>();
  const allLinks = extractKnowledgeLinks(body);

  // Process Markdown links
  for (const link of allLinks.markdown) {
    const resolved = resolveMarkdownTarget(link.target, sourceId);
    if (resolved.kind === "escape") {
      diagnostics.push(
        diag(
          "warning",
          "link_path_escape",
          `${sourceId}.md`,
          `Link escapes bundle root: ${link.target}`,
        ),
      );
    } else if (resolved.kind === "invalid") {
      diagnostics.push(
        diag(
          "warning",
          "link_unresolved",
          `${sourceId}.md`,
          `Malformed percent-encoded link: ${link.target}`,
        ),
      );
    } else if (resolved.kind === "concept") {
      const canonical = index.byExact.get(resolved.id.normalize("NFC"));
      if (canonical) {
        targets.add(canonical);
      } else {
        unresolved.push({ target: resolved.id, syntax: "markdown" });
        diagnostics.push(
          diag("warning", "link_unresolved", `${sourceId}.md`, `Unresolved link: ${resolved.id}`),
        );
      }
    }
    // external and empty are silently ignored
  }

  // Process wikilinks (lenient: exact → normalized path → bare title)
  for (const link of allLinks.wikilinks) {
    const res = resolveWikilink(link.target, index);
    if (res.kind === "resolved") {
      targets.add(res.id);
    } else if (res.kind === "ambiguous") {
      diagnostics.push(
        diag(
          "warning",
          "link_ambiguous",
          `${sourceId}.md`,
          `Ambiguous wikilink: ${res.target} (candidates: ${res.candidates.join(", ")})`,
        ),
      );
    } else {
      unresolved.push({ target: res.target, syntax: "wikilink" });
      diagnostics.push(
        diag("warning", "link_unresolved", `${sourceId}.md`, `Unresolved wikilink: ${res.target}`),
      );
    }
  }

  // Sort and deduplicate
  const sorted = [...targets].sort(compareCodePoint);

  return { targets: sorted, unresolved, diagnostics };
}

/**
 * Pre-write wikilink gate mode (issue #172). Two independent behaviors, not a
 * severity ladder:
 *   1. resolvable-but-drifted links (target exists): leave vs. rewrite-to-canonical
 *   2. unresolvable links (target absent — a forward reference / gap): ignore vs. report vs. reject
 *
 *   off       = leave + ignore   (opt-out; zero behavior change)
 *   warn      = leave + report   (default; non-mutating, non-blocking, surfaces issues)
 *   normalize = rewrite + report (fixes resolvable links; still reports gaps)
 *   strict    = leave + reject   (blocks the write with the bad links named; agent retry signal)
 *
 * A link that RESOLVES is never flagged — only normalized. Only missing/ambiguous targets
 * produce diagnostics.
 */
export type WikilinkValidationMode = "off" | "warn" | "strict" | "normalize";

// ── Pre-write validation & normalization (issue #172, Layer 2) ─────────

export interface WikilinkAuditResult {
  /** Unresolved / ambiguous link diagnostics (empty for "off" / clean bodies). */
  diagnostics: KnowledgeDiagnostic[];
  /** The body after normalization (identical to input unless normalize rewrote links). */
  body: string;
  /** True only when normalize changed the body. */
  changed: boolean;
}

const WIKILINK_REPLACE_RE = /\[\[([^\]|]+)(\|[^\]]*)?\]\]/g;

/**
 * Audit a markdown body's wikilinks against the page index.
 *
 * - Collects `link_unresolved` / `link_ambiguous` diagnostics for every link
 *   that does not resolve to exactly one page (skipped for "off").
 * - In "normalize" mode, additionally rewrites each link that DOES resolve to
 *   its canonical page id. Only the target token is replaced (the parser's own
 *   regex is reused), so `|alias`, escaping, and surrounding text are preserved.
 *
 * Pure: no I/O. The caller supplies the index (typically `buildWikilinkIndex`
 * over existing page ids plus the ids created by the same commit).
 */
export function auditWikilinks(
  body: string,
  index: WikilinkIndex,
  sourceId: string,
  mode: WikilinkValidationMode,
): WikilinkAuditResult {
  if (mode === "off") return { diagnostics: [], body, changed: false };

  const diagnostics: KnowledgeDiagnostic[] = [];
  for (const { target } of extractKnowledgeLinks(body).wikilinks) {
    const resolved = resolveWikilink(target, index);
    if (resolved.kind === "ambiguous") {
      diagnostics.push({
        severity: "warning",
        code: "link_ambiguous",
        path: sourceId,
        message: `Wikilink target "${target}" matches multiple pages (${resolved.candidates.join(", ")}).`,
      });
    } else if (resolved.kind === "missing") {
      diagnostics.push({
        severity: "warning",
        code: "link_unresolved",
        path: sourceId,
        message: `Wikilink target "${target}" does not match any page.`,
      });
    }
  }

  let out = body;
  if (mode === "normalize") {
    out = body.replace(WIKILINK_REPLACE_RE, (full, raw: string, alias: string | undefined) => {
      const resolved = resolveWikilink(normalizeWikilinkTarget(raw), index);
      return resolved.kind === "resolved" ? `[[${resolved.id}${alias ?? ""}]]` : full;
    });
  }

  return { diagnostics, body: out, changed: out !== body };
}
export interface WikilinkGateResult {
  /** false only when mode === "strict" AND there are unresolvable/ambiguous links. */
  ok: boolean;
  /** The body to write (normalized when mode === "normalize", else the input). */
  body: string;
  /** Unresolved / ambiguous link diagnostics (empty for "off" / clean bodies). */
  diagnostics: KnowledgeDiagnostic[];
}

/**
 * Apply the pre-write wikilink gate to a body. Wraps {@link auditWikilinks}:
 * blocks (ok:false) only in strict mode with issues, rewrites in normalize mode,
 * and always returns the diagnostics so callers can surface them (warn/normalize).
 */
export function applyWikilinkGate(
  body: string,
  index: WikilinkIndex,
  sourceId: string,
  mode: WikilinkValidationMode,
): WikilinkGateResult {
  if (mode === "off") return { ok: true, body, diagnostics: [] };
  const audit = auditWikilinks(body, index, sourceId, mode);
  return {
    ok: !(mode === "strict" && audit.diagnostics.length > 0),
    body: mode === "normalize" ? audit.body : body,
    diagnostics: audit.diagnostics,
  };
}
