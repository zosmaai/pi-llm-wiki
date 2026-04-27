import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Vault utility functions for the LLM Wiki extension.
 */

export interface VaultPaths {
  root: string;
  raw: string;
  rawSources: string;
  wiki: string;
  meta: string;
  dotWiki: string;
  outputs: string;
  discoveries: string;
}

/** Resolve vault root from cwd or find nearest wiki root. */
export function resolveVaultRoot(cwd: string): string {
  // If cwd has .wiki/config.json, it's the root
  if (existsSync(join(cwd, ".wiki", "config.json"))) return cwd;

  // Walk up looking for .wiki/config.json
  let dir = cwd;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, ".wiki", "config.json"))) return dir;
    dir = dirname(dir);
  }

  // Fallback: cwd itself
  return cwd;
}

/** Get all vault paths. */
export function getVaultPaths(root: string): VaultPaths {
  return {
    root,
    raw: join(root, "raw"),
    rawSources: join(root, "raw", "sources"),
    wiki: join(root, "wiki"),
    meta: join(root, "meta"),
    dotWiki: join(root, ".wiki"),
    outputs: join(root, "outputs"),
    discoveries: join(root, ".discoveries"),
  };
}

/** Ensure all vault directories exist. */
export function ensureVaultStructure(paths: VaultPaths): void {
  const dirs = [
    paths.rawSources,
    join(paths.raw, "assets"),
    join(paths.wiki, "sources"),
    join(paths.wiki, "entities"),
    join(paths.wiki, "concepts"),
    join(paths.wiki, "syntheses"),
    join(paths.wiki, "analyses"),
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
  const today = new Date().toISOString().split("T")[0];
  const prefix = `SRC-${today}`;

  if (!existsSync(paths.rawSources)) return `${prefix}-001`;

  const dirs = readdirSync(paths.rawSources)
    .filter((d) => d.startsWith(prefix))
    .sort();

  if (dirs.length === 0) return `${prefix}-001`;

  const last = dirs[dirs.length - 1];
  const num = Number.parseInt(last.slice(-3), 10);
  return `${prefix}-${String(num + 1).padStart(3, "0")}`;
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
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      frontmatter[key] = val;
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
  root: string,
): { protected: boolean; reason?: string } {
  const rawPath = resolve(root, "raw");
  const metaPath = resolve(root, "meta");
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
