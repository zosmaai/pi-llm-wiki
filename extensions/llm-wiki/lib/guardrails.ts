import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { launchReindex } from "./embeddings.js";
import { rebuildMetadataLight } from "./metadata.js";
import type { Runtime } from "./runtime.js";
import { isProtectedPath, resolveVaultPaths } from "./utils.js";

/**
 * Guardrails and auto-rebuild hooks for the LLM Wiki extension.
 */

let pendingRebuild = false;

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
      const path = event.input.path as string;
      const paths = resolveVaultPaths(process.cwd());
      const check = isProtectedPath(path, paths);
      if (check.protected) {
        return { block: true, reason: check.reason };
      }
    }
  });

  // Track wiki edits for auto-rebuild
  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = event.input.path as string;
      const paths = resolveVaultPaths(process.cwd());
      const wikiPath = `${paths.wiki}/`;
      if (path?.startsWith(wikiPath)) {
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
        rebuildMetadataLight(paths);
        if (runtime) {
          const launchCtx = ctx ? { hasUI: ctx.hasUI, ui: ctx.ui } : { hasUI: false as const };
          launchReindex(runtime, launchCtx, paths);
        }
      } catch {
        // Silently fail — metadata rebuild is best-effort
      }
    }
  });
}
