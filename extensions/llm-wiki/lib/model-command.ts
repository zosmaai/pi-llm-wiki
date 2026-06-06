import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Runtime } from "./runtime.js";
import { type TaskConfig, parseModelRef, persistTaskModel } from "./task-config.js";

/**
 * Model selection surface for the wiki background lane (issue #69, epic #63).
 *
 * The `taskModel` config field (read by `Runtime.resolveModel`) already exists;
 * this module adds the user-facing *surface* to view and set it:
 *   - the `/wiki-model` slash command (interactive picker + scriptable arg),
 *   - a status-bar label of the active task model,
 *   - the per-call override is wired on heavy tools (e.g. `wiki_ingest`).
 *
 * The default is always the session model: when no `taskModel` is configured
 * and no override is passed, background work runs on the current session model.
 */

/** A minimal view of a registry model (provider + id, optional display name). */
interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

/** Words that clear the override and revert to the session model. */
const CLEAR_WORDS = new Set(["session", "default", "reset", "clear", "none", "unset"]);

/** The status-bar key for the active-model label (so we can update it in place). */
export const MODEL_STATUS_KEY = "llm-wiki-model";

/**
 * Human-readable label for the active background task model. Shows the
 * configured `provider/id` when set, otherwise the session model (with its id
 * when known). Pure — safe to unit test and reuse for the status line.
 */
export function formatActiveModelLabel(config: TaskConfig, sessionModelId?: string): string {
  if (config.taskModel) return `${config.taskModel.provider}/${config.taskModel.id}`;
  return sessionModelId ? `session model (${sessionModelId})` : "session model";
}

/** "provider/id" ref for a model. */
function modelRef(m: ModelLike): string {
  return `${m.provider}/${m.id}`;
}

/**
 * Register the `/wiki-model` slash command. Lets the user view the active
 * background task model and choose another (or revert to the session model).
 * The choice is persisted to project settings and applied immediately.
 *
 *   /wiki-model                 → interactive picker (lists available models)
 *   /wiki-model provider/id     → set directly (scriptable / no UI needed)
 *   /wiki-model session|clear   → clear the override, use the session model
 */
export function registerWikiModelCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("wiki-model", {
    description:
      "View or set the model used for LLM Wiki background tasks (default: session model)",
    handler: async (args, ctx) => {
      runtime.ensureConfig(ctx.cwd);
      const sessionId = (ctx.model as ModelLike | undefined)?.id;

      const apply = (model: { provider: string; id: string } | undefined): void => {
        persistTaskModel(ctx.cwd, model);
        runtime.config = { ...runtime.config, taskModel: model };
        runtime.configLoaded = true;
        const label = formatActiveModelLabel(runtime.config, sessionId);
        ctx.ui.setStatus(MODEL_STATUS_KEY, `🧠 wiki model: ${label}`);
        ctx.ui.notify(`LLM Wiki: background tasks now use ${label}`, "info");
      };

      const trimmed = args.trim();

      // Explicit clear → session model.
      if (trimmed && CLEAR_WORDS.has(trimmed.toLowerCase())) {
        apply(undefined);
        return;
      }

      // Direct "provider/id" set (works without UI).
      if (trimmed) {
        const ref = parseModelRef(trimmed);
        if (!ref) {
          ctx.ui.notify(
            `LLM Wiki: could not parse "${trimmed}". Use provider/id (e.g. anthropic/claude-haiku) or "session".`,
            "error",
          );
          return;
        }
        const found = ctx.modelRegistry.find(ref.provider, ref.id) as ModelLike | undefined;
        if (!found) {
          ctx.ui.notify(
            `LLM Wiki: model ${ref.provider}/${ref.id} is not in the registry (run /wiki-model with no argument to pick from available models).`,
            "error",
          );
          return;
        }
        apply({ provider: found.provider, id: found.id });
        return;
      }

      // No argument: interactive picker.
      const current = formatActiveModelLabel(runtime.config, sessionId);
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `LLM Wiki: active background model is ${current}. Pass provider/id to change it (no interactive UI here).`,
          "info",
        );
        return;
      }

      const available = (ctx.modelRegistry.getAvailable() as ModelLike[]) ?? [];
      const pool = available.length > 0 ? available : (ctx.modelRegistry.getAll() as ModelLike[]);
      const sessionOption = "↩ Use session model (clear override)";
      const options = [sessionOption, ...pool.map(modelRef)];

      const picked = await ctx.ui.select(`Wiki background model (current: ${current})`, options);
      if (picked === undefined) return; // cancelled

      if (picked === sessionOption) {
        apply(undefined);
        return;
      }
      const ref = parseModelRef(picked);
      if (ref) apply(ref);
    },
  });
}
