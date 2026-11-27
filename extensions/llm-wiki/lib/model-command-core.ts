import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.js";
import { parseModelRef, persistTaskModel, type TaskConfig } from "./task-config.js";

interface ModelRef {
  provider: string;
  id: string;
}

interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

type PickModel = (
  ui: ExtensionCommandContext["ui"],
  current: string,
  items: ModelOption[],
  selectedIndex: number,
) => Promise<string | undefined>;

const CLEAR_WORDS = ["session", "default", "reset", "clear", "none", "unset"];
const SESSION_VALUE = "__session__";

export const MODEL_STATUS_KEY = "llm-wiki-model";

function modelRef(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

export function formatActiveModelLabel(config: TaskConfig, sessionModelId?: string): string {
  if (config.taskModel) return modelRef(config.taskModel);
  return sessionModelId ? `session model (${sessionModelId})` : "session model";
}

function buildPickerItems(pool: ModelRef[], currentRef?: string) {
  const items: ModelOption[] = [
    {
      value: SESSION_VALUE,
      label: "↩ Use session model (clear override)",
      description: currentRef ? undefined : "current",
    },
  ];
  let selectedIndex = 0;
  for (const model of pool) {
    const ref = modelRef(model);
    const isCurrent = ref === currentRef;
    if (isCurrent) selectedIndex = items.length;
    items.push({ value: ref, label: ref, description: isCurrent ? "current" : undefined });
  }
  return { items, selectedIndex };
}

export function registerModelCommand(
  pi: ExtensionAPI,
  runtime: Runtime,
  pickModel: PickModel,
): void {
  pi.registerCommand("wiki-model", {
    description:
      "View or set the model used for LLM Wiki background tasks (default: session model)",
    handler: async (args, ctx) => {
      runtime.ensureConfig(ctx.cwd);
      const sessionId = ctx.model?.id;

      function apply(model: ModelRef | undefined): void {
        persistTaskModel(ctx.cwd, model);
        runtime.config = { ...runtime.config, taskModel: model };
        const label = formatActiveModelLabel(runtime.config, sessionId);
        ctx.ui.setStatus(MODEL_STATUS_KEY, `🧠 wiki model: ${label}`);
        ctx.ui.notify(`LLM Wiki: background tasks now use ${label}`, "info");
      }

      const trimmed = args.trim();
      if (trimmed && CLEAR_WORDS.includes(trimmed.toLowerCase())) {
        apply(undefined);
        return;
      }
      if (trimmed) {
        const ref = parseModelRef(trimmed);
        if (!ref) {
          ctx.ui.notify(
            `LLM Wiki: could not parse "${trimmed}". Use provider/id (e.g. anthropic/claude-haiku) or "session".`,
            "error",
          );
          return;
        }
        const found = ctx.modelRegistry.find(ref.provider, ref.id);
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

      const current = formatActiveModelLabel(runtime.config, sessionId);
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `LLM Wiki: active background model is ${current}. Pass provider/id to change it (no interactive UI here).`,
          "info",
        );
        return;
      }

      const available = ctx.modelRegistry.getAvailable();
      const pool = available?.length ? available : ctx.modelRegistry.getAll();
      const currentRef = runtime.config.taskModel ? modelRef(runtime.config.taskModel) : undefined;
      const { items, selectedIndex } = buildPickerItems(pool, currentRef);
      const picked = await pickModel(ctx.ui, current, items, selectedIndex);
      if (picked === SESSION_VALUE) {
        apply(undefined);
      } else if (picked !== undefined) {
        const ref = parseModelRef(picked);
        if (ref) apply(ref);
      }
    },
  });
}
