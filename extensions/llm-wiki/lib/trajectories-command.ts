import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadTaskConfig, persistTrajectoriesEnabled, trajectoriesEnabled } from "./task-config.js";

/**
 * Activation surface for agent-trajectory working-memory (issue #80).
 *
 * The feature is opt-in / default-off. The trajectory tools
 * (`wiki_capture_trajectory`, `wiki_distill_skills`, `wiki_recall_skill`) are
 * registered conditionally at extension-load time (see index.ts) based on the
 * `llm-wiki.trajectories` setting. Because pi has no runtime add/remove-tool
 * API — the extension factory runs once at load — flipping the flag can only
 * change the registered tool set by RELOADING extensions. This command does
 * exactly that: persist the setting, then `ctx.reload()` so the gate
 * re-evaluates and the tools appear (or disappear) immediately.
 *
 *   /wiki-trajectories            → show current state
 *   /wiki-trajectories on         → enable + reload
 *   /wiki-trajectories off        → disable + reload
 */

const ON_WORDS = new Set(["on", "true", "enable", "enabled", "yes", "1"]);
const OFF_WORDS = new Set(["off", "false", "disable", "disabled", "no", "0"]);

export function registerWikiTrajectoriesCommand(pi: ExtensionAPI): void {
  pi.registerCommand("wiki-trajectories", {
    description:
      "Enable or disable agent-trajectory working-memory (capture/distill/recall). Off by default.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const current = trajectoriesEnabled(loadTaskConfig(ctx.cwd));

      if (!arg) {
        ctx.ui.notify(
          `LLM Wiki trajectories are ${current ? "ON" : "OFF"}. Use \`/wiki-trajectories on\` or \`off\`.`,
          "info",
        );
        return;
      }

      let next: boolean;
      if (ON_WORDS.has(arg)) next = true;
      else if (OFF_WORDS.has(arg)) next = false;
      else {
        ctx.ui.notify(
          `LLM Wiki: could not parse "${args.trim()}". Use \`on\` or \`off\`.`,
          "error",
        );
        return;
      }

      if (next === current) {
        ctx.ui.notify(`LLM Wiki trajectories already ${current ? "ON" : "OFF"}.`, "info");
        return;
      }

      persistTrajectoriesEnabled(ctx.cwd, next);
      ctx.ui.notify(
        `LLM Wiki: trajectory tools ${next ? "enabled" : "disabled"} — reloading extensions…`,
        "info",
      );
      // pi has no runtime register/unregister-tool API: reload re-runs the
      // extension factory so the conditional registration re-evaluates and the
      // tool set (and status line) reflect the new state.
      await ctx.reload();
    },
  });
}
