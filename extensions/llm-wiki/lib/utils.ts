import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Vault utility functions for the LLM Wiki extension.
 */

export interface VaultPaths {
  root: string;
  raw: string;
  rawSources: string;
  rawTrajectories: string;
  wiki: string;
  meta: string;
  dotWiki: string;
  outputs: string;
  discoveries: string;
}

/** Detect whether a vault root uses new (.llm-wiki) or legacy (.wiki) layout. */
export type VaultFormat = "new" | "legacy" | "none";

/**
 * Detect the vault format at a given directory.
 * Returns "new" if .llm-wiki/config.json exists,
 * "legacy" if .wiki/config.json exists,
 * "none" otherwise.
 */
export function detectVaultFormat(dir: string): VaultFormat {
  if (existsSync(join(dir, ".llm-wiki", "config.json"))) return "new";
  if (existsSync(join(dir, ".wiki", "config.json"))) return "legacy";
  return "none";
}

/**
 * Get the personal wiki root directory.
 *
 * The "root" follows the same contract as project wikis: it is the directory
 * that *contains* the `.llm-wiki/` dot-dir, NOT the dot-dir itself.
 * So the personal vault lives at `<root>/.llm-wiki/`.
 *
 * Default root: `homedir()` → personal vault at `~/.llm-wiki/`.
 * Override:     `WIKI_HOME` env var → personal vault at `$WIKI_HOME/.llm-wiki/`.
 *
 * NOTE: Previously this returned `~/.llm-wiki` (the dot-dir itself), which
 * caused `getVaultPaths()` to compose paths like `~/.llm-wiki/.llm-wiki/raw`.
 * See `migrateDoubledPersonalVault()` for the one-shot recovery.
 */
export function getPersonalWikiRoot(): string {
  const envWiki = process.env.WIKI_HOME;
  if (envWiki) return envWiki;
  return homedir();
}

/** Get VaultPaths for the personal wiki. */
export function getPersonalWikiPaths(): VaultPaths {
  return getVaultPaths(getPersonalWikiRoot());
}

/**
 * One-shot, idempotent migration for vaults that were created with the broken
 * `getPersonalWikiRoot()` (returned the dot-dir itself, so `getVaultPaths()`
 * composed `<root>/.llm-wiki/.llm-wiki/...`).
 *
 * Detects a doubled layout at `<root>/.llm-wiki/.llm-wiki/config.json` and
 * flattens it up by one level. Safe to call on every session start: if the
 * doubled sentinel is absent, this is a no-op.
 *
 * Returns a description of the action taken (or `null` if no migration was
 * needed) so callers can surface a one-line status message.
 */
export function migrateDoubledPersonalVault(
  parentRoot: string = getPersonalWikiRoot(),
): { moved: string[]; from: string; to: string; skipped: string[] } | null {
  const outerDotWiki = join(parentRoot, ".llm-wiki");
  const innerDotWiki = join(outerDotWiki, ".llm-wiki");
  const innerSentinel = join(innerDotWiki, "config.json");

  if (!existsSync(innerSentinel)) return null;

  const moved: string[] = [];
  const skipped: string[] = [];

  for (const entry of readdirSync(innerDotWiki)) {
    const src = join(innerDotWiki, entry);
    const dest = join(outerDotWiki, entry);
    if (existsSync(dest)) {
      // Collision — leave the inner copy in place rather than clobber.
      skipped.push(entry);
      continue;
    }
    renameSync(src, dest);
    moved.push(entry);
  }

  // Only remove the inner dir if it is fully drained.
  if (skipped.length === 0) {
    try {
      rmdirSync(innerDotWiki);
    } catch {
      // Leave behind if something raced us; harmless.
    }
  }

  return { moved, from: innerDotWiki, to: outerDotWiki, skipped };
}

/**
 * Check if a vault is the personal wiki location.
 * Used in layered recall to avoid double-counting.
 */
export function isPersonalVault(paths: VaultPaths): boolean {
  return paths.root === getPersonalWikiRoot();
}

/**
 * Resolve vault root from cwd with personal fallback.
 *
 * Priority:
 * 1. cwd has .llm-wiki/ → project wiki (explicit)
 * 2. Walk up from cwd → parent project wiki
 * 3. ~/.llm-wiki/ exists → personal wiki
 * 4. Fallback: ~/.llm-wiki/ (create personal wiki)
 */
export function resolveVaultRoot(cwd: string): string {
  // Check for any vault format at cwd
  if (detectVaultFormat(cwd) !== "none") return cwd;

  // Walk up looking for a vault sentinel (new or legacy)
  let dir = cwd;
  while (dir !== dirname(dir)) {
    dir = dirname(dir);
    if (detectVaultFormat(dir) !== "none") return dir;
  }

  // Check personal wiki at ~/.llm-wiki/
  const personalRoot = getPersonalWikiRoot();
  if (detectVaultFormat(personalRoot) !== "none") return personalRoot;

  // Fallback: personal wiki
  return personalRoot;
}

/** Get all vault paths for the new (.llm-wiki) layout. */
export function getVaultPaths(root: string): VaultPaths {
  return {
    root,
    raw: join(root, ".llm-wiki", "raw"),
    rawSources: join(root, ".llm-wiki", "raw", "sources"),
    rawTrajectories: join(root, ".llm-wiki", "raw", "trajectories"),
    wiki: join(root, ".llm-wiki", "wiki"),
    meta: join(root, ".llm-wiki", "meta"),
    dotWiki: join(root, ".llm-wiki"),
    outputs: join(root, ".llm-wiki", "outputs"),
    discoveries: join(root, ".llm-wiki", ".discoveries"),
  };
}

/** Get all vault paths for the legacy (.wiki) layout. */
export function getLegacyVaultPaths(root: string): VaultPaths {
  return {
    root,
    raw: join(root, "raw"),
    rawSources: join(root, "raw", "sources"),
    rawTrajectories: join(root, "raw", "trajectories"),
    wiki: join(root, "wiki"),
    meta: join(root, "meta"),
    dotWiki: join(root, ".wiki"),
    outputs: join(root, "outputs"),
    discoveries: join(root, ".discoveries"),
  };
}

/**
 * Resolve vault paths, auto-detecting new vs legacy layout.
 * This is the main entry point: use this instead of resolveVaultRoot + getVaultPaths.
 */
export function resolveVaultPaths(cwd: string): VaultPaths {
  const root = resolveVaultRoot(cwd);
  const format = detectVaultFormat(root);
  if (format === "legacy") return getLegacyVaultPaths(root);
  return getVaultPaths(root);
}

/** Ensure all vault directories exist. */
export function ensureVaultStructure(paths: VaultPaths): void {
  const dirs = [
    paths.rawSources,
    paths.rawTrajectories,
    join(paths.raw, "assets"),
    join(paths.wiki, "sources"),
    join(paths.wiki, "entities"),
    join(paths.wiki, "concepts"),
    join(paths.wiki, "syntheses"),
    join(paths.wiki, "analyses"),
    join(paths.wiki, "requirements"),
    join(paths.wiki, "skills"),
    join(paths.wiki, "cases"),
    paths.meta,
    paths.dotWiki,
    paths.outputs,
    paths.discoveries,
    join(paths.dotWiki, "templates"),
    join(paths.dotWiki, "templates", "pages"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });
}

/** Read JSON file or return default. */
export function readJson<T>(path: string, defaultValue: T): T {
  try {
    if (!existsSync(path)) return defaultValue;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return defaultValue;
  }
}

/** Write JSON file atomically. */
export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** Read text file or return empty string. */
export function readText(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Generate the next source ID. */
export function nextSourceId(paths: VaultPaths): string {
  return nextSequentialId(paths.rawSources, "SRC");
}

/** Generate the next trajectory ID. */
export function nextTrajectoryId(paths: VaultPaths): string {
  return nextSequentialId(paths.rawTrajectories, "TRJ");
}

/** Generate the next sequential, date-stamped packet ID for a raw subdir. */
function nextSequentialId(dir: string, kind: string): string {
  const today = new Date().toISOString().split("T")[0];
  const prefix = `${kind}-${today}`;

  if (!existsSync(dir)) return `${prefix}-001`;

  const dirs = readdirSync(dir)
    .filter((d) => d.startsWith(prefix))
    .sort();

  if (dirs.length === 0) return `${prefix}-001`;

  const last = dirs[dirs.length - 1];
  const num = Number.parseInt(last.slice(-3), 10);
  return `${prefix}-${String(num + 1).padStart(3, "0")}`;
}

/** Parse a small, dependency-free YAML scalar/inline-array value. */
function parseFrontmatterValue(raw: string, unquote = false): unknown {
  const trimmed = raw.trim();
  const unquoted = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2").trim();

  if (!trimmed) return "";

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => unquoted(item.trim()));
  }

  return unquote ? unquoted(trimmed) : trimmed;
}

/** Extract frontmatter from markdown. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentListKey: string | null = null;

  for (const line of lines) {
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentListKey) {
      const current = frontmatter[currentListKey];
      const list = Array.isArray(current) ? current : [];
      list.push(parseFrontmatterValue(listMatch[1], true));
      frontmatter[currentListKey] = list;
      continue;
    }

    const idx = line.indexOf(":");
    if (idx <= 0) {
      currentListKey = null;
      continue;
    }

    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();

    if (!val) {
      frontmatter[key] = [];
      currentListKey = key;
    } else {
      frontmatter[key] = parseFrontmatterValue(val);
      currentListKey = null;
    }
  }
  return { frontmatter, body: match[2] };
}

/** Find all wiki pages recursively. */
export function findWikiPages(
  wikiDir: string,
): Array<{ path: string; relative: string; content: string }> {
  const results: Array<{ path: string; relative: string; content: string }> = [];

  function walk(dir: string, rel: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, rel ? `${rel}/${entry}` : entry);
      } else if (entry.endsWith(".md")) {
        results.push({
          path: full,
          relative: rel ? `${rel}/${entry.slice(0, -3)}` : entry.slice(0, -3),
          content: readFileSync(full, "utf-8"),
        });
      }
    }
  }

  walk(wikiDir, "");
  return results;
}

/** Extract all [[wikilinks]] from content. */
export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null = regex.exec(content);
  while (m !== null) {
    links.push(m[1]);
    m = regex.exec(content);
  }
  return links;
}

/** Slugify a title. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/** Format date as YYYY-MM-DD. */
export function fmtDate(d = new Date()): string {
  return d.toISOString().split("T")[0];
}

/** Run a shell command via pi.exec. */
export async function exec(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await pi.exec(command, args, options ?? {});
  return result;
}

/** Check if a path is inside a protected directory. */
export function isProtectedPath(
  absPath: string,
  paths: VaultPaths,
): { protected: boolean; reason?: string } {
  const rawPath = resolve(paths.raw);
  const metaPath = resolve(paths.meta);
  const norm = resolve(absPath);

  if (norm.startsWith(`${rawPath}/`) || norm === rawPath) {
    return {
      protected: true,
      reason: "Raw sources are immutable. Use wiki_capture_source to add sources.",
    };
  }
  if (norm.startsWith(`${metaPath}/`) || norm === metaPath) {
    return {
      protected: true,
      reason: "Metadata is auto-generated. Use wiki_rebuild_meta or wiki_log_event instead.",
    };
  }

  return { protected: false };
}
