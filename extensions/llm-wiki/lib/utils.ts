import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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
  qmd: string;
  qmdCurrent: string;
  qmdDocuments: string;
  qmdManifest: string;
  qmdSwap: string;
}

/** Detect whether a vault root uses new (.llm-wiki) or legacy (.wiki) layout. */
export type VaultFormat = "new" | "legacy" | "none";

/**
 * Detect the vault format at a given directory.
 * Returns "new" if .llm-wiki exists, "legacy" if .wiki exists,
 * and "none" otherwise. A missing config is still a detected, damaged vault.
 */
export function detectVaultFormat(dir: string): VaultFormat {
  if (existsSync(join(dir, ".llm-wiki"))) return "new";
  if (existsSync(join(dir, ".wiki"))) return "legacy";
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
 *
 * Compares PHYSICAL paths, not strings. On image-based ("atomic") Linux
 * distributions `/home` is a symlink to `var/home`, so `homedir()` yields the
 * `$HOME` string (`/home/u`) while `process.cwd()` — and therefore the root
 * `resolveVaultRoot()` walks up to — yields `/var/home/u`. A string compare
 * calls the personal vault a project vault, which makes layered recall search
 * the same vault twice and `vaultPageCount()` double-count it.
 *
 * Exact equality, NOT containment: a vault nested under the home directory
 * (`~/projects/foo/.llm-wiki`) is a project vault and must stay one.
 */
export function isPersonalVault(paths: VaultPaths): boolean {
  const personalRoot = getPersonalWikiRoot();
  // Fast path: identical strings need no filesystem syscalls.
  if (paths.root === personalRoot) return true;
  try {
    return relativePhysicalPath(personalRoot, paths.root) === "";
  } catch {
    // Unresolvable path (permissions, symlink cycle): fall back to "not
    // personal" so layered recall degrades to searching both vaults rather
    // than silently dropping the personal layer.
    return false;
  }
}

/**
 * Resolve the vault root that belongs to THIS project, or `null` when the
 * project has none.
 *
 * Priority:
 * 1. cwd has `.llm-wiki/` (or legacy `.wiki/`) → project wiki (explicit)
 * 2. `WIKI_HOME` → user-selected root, explicit enough to count as the project's
 * 3. Walk up from cwd → parent project wiki (monorepo / nested workspace)
 *
 * Deliberately does NOT fall back to the personal wiki: callers that need the
 * fallback use {@link resolveVaultRoot}, callers that must distinguish "this
 * project has a wiki" from "some wiki exists somewhere" use this.
 */
export function resolveProjectVaultRoot(cwd: string): string | null {
  // A vault rooted at cwd is always the project-local choice.
  if (detectVaultFormat(cwd) !== "none") return cwd;

  // An explicit WIKI_HOME is a testable/user-selected fallback and must win
  // over an unrelated personal vault found while walking parent directories.
  if (process.env.WIKI_HOME) return process.env.WIKI_HOME;

  // Walk up looking for a vault sentinel (new or legacy).
  let dir = cwd;
  while (dir !== dirname(dir)) {
    dir = dirname(dir);
    if (detectVaultFormat(dir) === "none") continue;
    // Skip the personal vault: it is an ancestor of EVERY project under the
    // home directory (`~/projects/foo`, and on Windows even the temp dir), so
    // counting it here would report a project vault for directories that have
    // none. `resolveVaultRoot` still falls back to it explicitly.
    if (isPersonalVault(getVaultPaths(dir))) continue;
    return dir;
  }

  return null;
}

/**
 * Resolve vault root from cwd with personal fallback.
 *
 * Priority:
 * 1-3. {@link resolveProjectVaultRoot}
 * 4. Personal wiki root (`~`, or `WIKI_HOME`) — used whether or not it already
 *    holds a vault, so first-run bootstrap has somewhere to write.
 */
export function resolveVaultRoot(cwd: string): string {
  // Realpath the personal fallback so a symlinked `$HOME` (atomic-OS layouts)
  // yields the PHYSICAL root the ancestor walk used to return — the #145
  // regression guard pins that. `realpathWithMissingTail` also covers first-run
  // bootstrap, where the personal root does not exist on disk yet.
  return resolveProjectVaultRoot(cwd) ?? realpathWithMissingTail(getPersonalWikiRoot());
}

/** Get all vault paths for the new (.llm-wiki) layout. */
export function getVaultPaths(root: string): VaultPaths {
  const meta = join(root, ".llm-wiki", "meta");
  const qmd = join(meta, "qmd");
  return {
    root,
    raw: join(root, ".llm-wiki", "raw"),
    rawSources: join(root, ".llm-wiki", "raw", "sources"),
    rawTrajectories: join(root, ".llm-wiki", "raw", "trajectories"),
    wiki: join(root, ".llm-wiki", "wiki"),
    meta,
    dotWiki: join(root, ".llm-wiki"),
    outputs: join(root, ".llm-wiki", "outputs"),
    discoveries: join(root, ".llm-wiki", ".discoveries"),
    qmd,
    qmdCurrent: join(qmd, "current"),
    qmdDocuments: join(qmd, "documents"),
    qmdManifest: join(qmd, "manifest.json"),
    qmdSwap: join(qmd, "swap.json"),
  };
}

/** Get all vault paths for the legacy (.wiki) layout. */
export function getLegacyVaultPaths(root: string): VaultPaths {
  const meta = join(root, "meta");
  const qmd = join(meta, "qmd");
  return {
    root,
    raw: join(root, "raw"),
    rawSources: join(root, "raw", "sources"),
    rawTrajectories: join(root, "raw", "trajectories"),
    wiki: join(root, "wiki"),
    meta,
    dotWiki: join(root, ".wiki"),
    outputs: join(root, "outputs"),
    discoveries: join(root, ".discoveries"),
    qmd,
    qmdCurrent: join(qmd, "current"),
    qmdDocuments: join(qmd, "documents"),
    qmdManifest: join(qmd, "manifest.json"),
    qmdSwap: join(qmd, "swap.json"),
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
  // NOTE: the agent-trajectory dirs (raw/trajectories, wiki/skills, wiki/cases)
  // are intentionally NOT created here — they are created lazily on first
  // capture/distill (issue #80), so a vault with the feature off carries no
  // trace of it. All readers of these paths are existsSync-guarded.
  const dirs = [
    paths.rawSources,
    join(paths.raw, "assets"),
    join(paths.wiki, "sources"),
    join(paths.wiki, "entities"),
    join(paths.wiki, "concepts"),
    join(paths.wiki, "syntheses"),
    join(paths.wiki, "analyses"),
    join(paths.wiki, "requirements"),
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

/**
 * Slugify a title to a kebab-case page slug.
 *
 * - Folds full-width ASCII forms and ideographic spaces without changing
 *   unrelated Unicode compatibility characters.
 * - Collapses whitespace AND existing hyphens into a single `-`.
 * - Trims leading/trailing hyphens.
 * - Prefixes Windows reserved device names (CON, PRN, AUX, NUL, COM1-9,
 *   LPT1-9, including superscript 1-3 forms) with `_`.
 * - Appends `-page` to `index`/`log` slugs to avoid colliding with the
 *   special INDEX/LOG wiki pages.
 */
export function slugify(title: string): string {
  const slug =
    title
      .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, " ")
      .toLowerCase()
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/[\s-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/[\uD800-\uDBFF]$/, "")
      .replace(/^-+|-+$/g, "") || "untitled";

  if (/^(?:con|prn|aux|nul|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))$/.test(slug)) {
    return `_${slug}`;
  }
  return slug === "index" || slug === "log" ? `${slug}-page` : slug;
}

/** Format date as YYYY-MM-DD. */
export function fmtDate(d = new Date()): string {
  return d.toISOString().split("T")[0];
}

/** Narrow exec-only interface shared by Pi and MCP. */
export type ExecApi = Pick<ExtensionAPI, "exec">;

/** Run a shell command via pi.exec and reject failed or cancelled commands. */
export async function exec(
  pi: ExecApi,
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
  const result = await pi.exec(command, args, options ?? {});
  if (result.killed) throw new Error(`Command timed out or was aborted: ${command}`);
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `Command failed (${command} exited ${result.code})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

function appendPath(base: string, ...parts: string[]): string {
  if (parts.length === 0) return base;
  return `${base}${base.endsWith(sep) ? "" : sep}${parts.join(sep)}`;
}

function realpathWithMissingTail(path: string, seen = new Set<string>()): string {
  let current = path;
  const tail: string[] = [];

  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const symlinkPath = appendPath(realpathSync.native(dirname(current)), basename(current));
        if (seen.has(symlinkPath)) throw new Error(`Cannot resolve symlink cycle: ${path}`);
        seen.add(symlinkPath);
        const target = readlinkSync(current).toString();
        const resolvedTarget = isAbsolute(target) ? target : appendPath(dirname(current), target);
        return realpathWithMissingTail(appendPath(resolvedTarget, ...tail.reverse()), seen);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    try {
      return appendPath(realpathSync.native(current), ...tail.reverse());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Return the candidate path relative to the physical root. */
export function relativePhysicalPath(rootPath: string, candidatePath: string): string {
  return relative(realpathWithMissingTail(rootPath), realpathWithMissingTail(candidatePath));
}

/** Check physical containment, resolving existing symlink ancestors. */
export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relation = relativePhysicalPath(rootPath, candidatePath);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

/** Check if a path is inside a protected directory. */
export function isProtectedPath(
  absPath: string,
  paths: VaultPaths,
): { protected: boolean; reason?: string } {
  try {
    if (isPathWithin(paths.raw, absPath)) {
      return {
        protected: true,
        reason: "Raw sources are immutable. Use wiki_capture_source to add sources.",
      };
    }
    if (relativePhysicalPath(paths.meta, absPath) === "events.jsonl") {
      return {
        protected: true,
        reason:
          "Event history is append-only authoritative state. Use wiki_log_event or an owning wiki operation instead.",
      };
    }
    if (isPathWithin(paths.meta, absPath)) {
      return {
        protected: true,
        reason: "Metadata is auto-generated. Use wiki_rebuild_meta or wiki_log_event instead.",
      };
    }

    return { protected: false };
  } catch {
    return { protected: true, reason: "Cannot safely resolve mutation path." };
  }
}
