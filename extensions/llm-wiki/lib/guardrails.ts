import { resolve, sep } from "node:path";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { scheduleReindex } from "./indexing.js";
import { rebuildMetadataLight } from "./metadata.js";
import type { Runtime } from "./runtime.js";
import { isProtectedPath, resolveVaultPaths } from "./utils.js";

/**
 * Guardrails and auto-rebuild hooks for the LLM Wiki extension.
 */

let pendingRebuild = false;

const APPLY_PATCH_PATH_NOISE =
  /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;
const PATCH_INPUT_KEYS: Record<string, true> = { input: true, _input: true, patch: true };

interface MutationScan {
  paths: string[];
  complete: boolean;
}

function normalizePatchTarget(target: string): string {
  const stripped = target.trim().replace(APPLY_PATCH_PATH_NOISE, "");
  if (stripped.length < 2) return stripped;
  const first = stripped[0];
  const last = stripped[stripped.length - 1];
  return (first === '"' || first === "'") && first === last ? stripped.slice(1, -1) : stripped;
}

function parsePatchHeader(line: string): string | undefined {
  const trimmed = line.replace(/\r$/, "").trimEnd();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;

  const body = trimmed.slice(1, -1).trim().replace(APPLY_PATCH_PATH_NOISE, "");
  const tag = /#[0-9A-Fa-f]{4}\s*$/.exec(body);
  const rawTarget = tag ? body.slice(0, tag.index) : body.replace(/\s+$/, "");
  if (!rawTarget || rawTarget.includes("#")) return undefined;

  return normalizePatchTarget(rawTarget) || undefined;
}

function scanPatchString(input: string): MutationScan {
  const paths: string[] = [];
  let sawHeader = false;
  let complete = true;
  const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;

  for (const line of stripped.split("\n")) {
    if (!line.replace(/\r$/, "").trimEnd().startsWith("[")) continue;
    sawHeader = true;
    const path = parsePatchHeader(line);
    if (path) paths.push(path);
    else complete = false;
  }

  return { paths, complete: sawHeader && complete };
}

function mergeMutationScans(target: MutationScan, source: MutationScan): void {
  target.paths.push(...source.paths);
  target.complete &&= source.complete;
}

function collectMutationPaths(
  input: unknown,
  seen: WeakSet<object>,
  stringsArePatches = false,
): MutationScan {
  if (typeof input === "string") {
    return stringsArePatches ? scanPatchString(input) : { paths: [], complete: true };
  }
  if (!input || typeof input !== "object" || seen.has(input)) {
    return { paths: [], complete: true };
  }

  seen.add(input);
  const scan: MutationScan = { paths: [], complete: true };
  if (Array.isArray(input)) {
    for (const value of input) {
      mergeMutationScans(scan, collectMutationPaths(value, seen, stringsArePatches));
    }
    return scan;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.path === "string" && record.path.length > 0) {
    scan.paths.push(record.path);
  }
  const eventPaths = Array.isArray(record.paths) ? record.paths : [record.paths];
  for (const path of eventPaths) {
    if (typeof path === "string" && path.length > 0) scan.paths.push(path);
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "path" || key === "paths") continue;
    const childStringsArePatches = stringsArePatches || PATCH_INPUT_KEYS[key] === true;
    if (typeof value !== "string" && (!value || typeof value !== "object")) continue;
    mergeMutationScans(scan, collectMutationPaths(value, seen, childStringsArePatches));
  }
  return scan;
}

function inspectMutationPaths(input: unknown): MutationScan {
  const stringsArePatches = typeof input === "string" || Array.isArray(input);
  const scan = collectMutationPaths(input, new WeakSet(), stringsArePatches);
  return { paths: [...new Set(scan.paths)], complete: scan.complete };
}

/** Return every file path targeted by a write or patch-shaped edit input. */
export function extractMutationPaths(input: unknown): string[] {
  return inspectMutationPaths(input).paths;
}

/** True when a write or patch-shaped edit targets a page in the wiki directory. */
export function hasWikiMutation(input: unknown, wikiPath: string): boolean {
  const resolvedWikiPath = resolve(wikiPath);
  return extractMutationPaths(input).some((path) => {
    const resolvedPath = resolve(path);
    return (
      resolvedPath === resolvedWikiPath || resolvedPath.startsWith(`${resolvedWikiPath}${sep}`)
    );
  });
}

/** Install guardrails on the extension API. */
export function installGuardrails(pi: ExtensionAPI, runtime?: Runtime): void {
  // Block direct edits to raw/ and meta/
  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("write", event)) {
      const path = event.input.path as string;
      const paths = resolveVaultPaths(process.cwd());
      const check = isProtectedPath(path, paths);
      if (check.protected) {
        return { block: true, reason: check.reason };
      }
    }

    if (isToolCallEventType("edit", event)) {
      const mutation = inspectMutationPaths(event.input);
      const targetPaths = mutation.paths;
      if (!mutation.complete || targetPaths.length === 0) {
        return { block: true, reason: "Cannot determine the files targeted by this edit." };
      }

      const paths = resolveVaultPaths(process.cwd());
      for (const path of targetPaths) {
        const check = isProtectedPath(path, paths);
        if (check.protected) {
          return { block: true, reason: check.reason };
        }
      }
    }
  });

  // Track wiki edits for auto-rebuild
  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const paths = resolveVaultPaths(process.cwd());
      if (hasWikiMutation(event.input, paths.wiki)) {
        pendingRebuild = true;
      }
    }
  });

  // Rebuild metadata at end of turn if wiki was modified, then refresh
  // semantic embeddings in the background (#66) so manual page edits get
  // re-embedded. Both are best-effort no-ops when nothing is configured.
  pi.on("turn_end", async (_event, ctx) => {
    if (pendingRebuild) {
      pendingRebuild = false;
      try {
        const paths = resolveVaultPaths(process.cwd());
        // Manual page edits also rebuild off the critical path. Without a
        // runtime (shouldn't happen in normal wiring) fall back to inline.
        if (runtime) {
          const launchCtx = ctx ? { hasUI: ctx.hasUI, ui: ctx.ui } : { hasUI: false as const };
          scheduleReindex(runtime, launchCtx, paths);
        } else {
          rebuildMetadataLight(paths);
        }
      } catch {
        // Silently fail — metadata rebuild is best-effort
      }
    }
  });
}
