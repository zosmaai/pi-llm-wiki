import { MODEL_STATUS_KEY, formatActiveModelLabel } from "./model-command.js";
import type { Runtime } from "./runtime.js";
import { noticesEnabled } from "./task-config.js";

/**
 * Minimal sink for the two status keys this helper writes. Mirrors the slice
 * of `ctx.ui` the extension uses; kept narrow so tests don't need to fake the
 * whole pi UI surface.
 */
export interface StatusSink {
  setStatus(key: string, value: string): void;
}

/**
 * Apply the two post-session-start visible status lines (issue #77,
 * regression-fixed in #83, comments + tests hardened in #84):
 *
 *   1. `🧠 LLM Wiki (… tools, … active)`     — the "wiki is loaded" badge
 *   2. `🧠 wiki model: <label>`              — the active background task model
 *
 * Both are user-facing chat noise and are gated by `llm-wiki.notices`
 * (default `true`). When `notices: false`, neither status is set — that's the
 * contract the regression in #83 was about.
 *
 * Extracted from `index.ts` so the gating contract is unit-testable without
 * faking the entire pi extension factory; see `test/visible-activity.test.ts`.
 *
 * Pure modulo `ui.setStatus`. Callers MUST run `runtime.ensureConfig(...)` for
 * the current cwd before invoking this so `noticesEnabled(runtime.config)`
 * sees the loaded project settings.
 */
export function applySessionStartStatus(opts: {
  ui: StatusSink;
  runtime: Runtime;
  trajectoriesOn: boolean;
  sessionModelId: string | undefined;
}): void {
  // Single gate for BOTH status lines (#83 added two adjacent guards; #84
  // collapses them — same condition, same scope).
  if (!noticesEnabled(opts.runtime.config)) return;

  opts.ui.setStatus(
    "llm-wiki",
    opts.trajectoriesOn
      ? "🧠 LLM Wiki (16 tools, trajectory + observe + recall active)"
      : "🧠 LLM Wiki (13 tools, observe + recall active)",
  );

  const modelLabel = formatActiveModelLabel(opts.runtime.config, opts.sessionModelId);
  opts.ui.setStatus(MODEL_STATUS_KEY, `🧠 wiki model: ${modelLabel}`);
}
