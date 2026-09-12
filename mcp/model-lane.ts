/**
 * Config-first model lane for hosts without pi's model registry (Claude Code,
 * Codex, ...). Builds a pi-ai ModelsStore from llm-wiki settings and exposes
 * the registry shim Runtime.resolveModel expects, so the exact resolution
 * precedence (per-call override -> taskModel -> none) lives in ONE place
 * (lib/runtime.ts) and is shared with the pi extension.
 *
 * The lane reads: taskModel (provider/id), taskModelBaseUrl, taskModelApiKey
 * (or taskModelApiKeyEnv, or the process env of that name). When unset,
 * resolveLaneModel returns ok:false and callers fall back to the
 * "synthesize yourself" path.
 */

import { createModels, createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import { streamSimple as openaiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  type ResolveCtx,
  type ResolveResult,
  Runtime,
} from "../extensions/llm-wiki/lib/runtime.js";
import type { TaskConfig } from "../extensions/llm-wiki/lib/task-config.js";

// Builtin pi-ai api id for OpenAI-compatible /v1/chat/completions servers
// (dist/compat.js lists: "anthropic-messages" | "openai-completions" | "openai-responses").
const LANE_API = "openai-completions";

/** Builds the provider object store.setProvider() receives. Injectable for tests. */
export type ProviderFactory = (config: TaskConfig) => unknown;

export function defaultProviderFactory(config: TaskConfig): unknown {
  if (!config.taskModel) return undefined;
  const baseUrl = config.taskModelBaseUrl ?? "";
  return createProvider({
    id: config.taskModel.provider,
    name: `LLM Wiki task model (${config.taskModel.provider}/${config.taskModel.id})`,
    ...(config.taskModelBaseUrl ? { baseUrl: config.taskModelBaseUrl } : {}),
    auth: {
      apiKey: config.taskModelApiKeyEnv
        ? envApiKeyAuth("Task model API key", [config.taskModelApiKeyEnv])
        : {
            name: "taskModelApiKey",
            resolve: async () => ({
              auth: { apiKey: config.taskModelApiKey ?? "" },
            }),
          },
    },
    models: [
      {
        id: config.taskModel.id,
        name: config.taskModel.id,
        provider: config.taskModel.provider,
        api: LANE_API,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
    api: openAICompletionsApi(),
  });
}

/**
 * Build the modelRegistry shim + a standalone Runtime for lane use.
 * `providerFactory` is swappable so tests can inject pi-ai's fauxProvider
 * (`fauxProvider({ provider, models, api }).provider` — the handle itself
 * is NOT setProvider-able).
 */
export function buildLane(
  config: TaskConfig,
  providerFactory: ProviderFactory = defaultProviderFactory,
): { runtime: Runtime; modelRegistry: NonNullable<ResolveCtx["modelRegistry"]> } {
  const store = createModels();
  const provider = providerFactory(config);
  if (provider) store.setProvider(provider as Provider);
  const runtime = new Runtime();
  runtime.config = config; // resolveModel reads this.config.taskModel
  const modelRegistry: NonNullable<ResolveCtx["modelRegistry"]> = {
    find: (providerId: string, id: string) => {
      const entry = store.getProvider(providerId);
      if (!entry) return undefined;
      try {
        const found = entry.getModels().find((m) => m.id === id);
        // A store-provider model has no `api` id; without it the runtime's
        // streamFn wiring (registered.api === model.api) never fires.
        return found ? { ...found, api: LANE_API } : undefined;
      } catch {
        return undefined;
      }
    },
    getRegisteredProviderConfig: (providerId: string) => {
      const entry = store.getProvider(providerId);
      if (!entry) return undefined;
      return { api: LANE_API, streamSimple: openaiStreamSimple };
    },
    getApiKeyAndHeaders: async () => {
      const key =
        config.taskModelApiKey ??
        (config.taskModelApiKeyEnv ? (process.env[config.taskModelApiKeyEnv] ?? "") : "");
      return {
        ok: typeof key === "string" && key.length > 0,
        ...(key.length > 0 ? { apiKey: key } : {}),
        ...(config.taskModelBaseUrl ? { baseUrl: config.taskModelBaseUrl } : {}),
      };
    },
  };
  return { runtime, modelRegistry };
}

/** Resolve the lane model, delegating precedence to Runtime.resolveModel. */
export async function resolveLaneModel(
  config: TaskConfig,
  providerFactory: ProviderFactory = defaultProviderFactory,
  override?: { provider: string; id: string },
): Promise<ResolveResult> {
  const effectiveConfig = override ? { ...config, taskModel: override } : config;
  const { runtime, modelRegistry } = buildLane(effectiveConfig, providerFactory);
  return runtime.resolveModel(
    { model: undefined, modelRegistry, hasUI: false } as ResolveCtx,
    override,
  );
}
