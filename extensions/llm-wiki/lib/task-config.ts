import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/**
 * Configuration for the background-task lane (issue #64, part of #63).
 *
 * The wiki's intelligent work (ingest synthesis, embeddings, topic inference)
 * can run off the main agent thread on a model of the user's choosing. This
 * module resolves that configuration from pi's namespaced settings, mirroring
 * the approach used by pi-observational-memory.
 *
 * Resolution order (later wins):
 *   1. built-in DEFAULTS
 *   2. global settings:  <agentDir>/settings.json  → { "llm-wiki": { ... } }
 *   3. project settings: <cwd>/.pi/settings.json    → { "llm-wiki": { ... } }
 *
 * When `taskModel` is unset, the background lane falls back to the session
 * model (see Runtime.resolveModel), so the feature is zero-config by default.
 */
export interface TaskConfig {
  /**
   * Model used for background wiki tasks. When undefined, the session model
   * is used. The surface for setting this (config field, /command, per-call
   * override) is built in issue #69; this module only reads it.
   */
  taskModel?: { provider: string; id: string };

  /**
   * Embedding provider for background write-time embeddings (issue #66).
   * Only "openai" / "openai-compatible" are supported. When undefined,
   * embeddings are disabled entirely (silent no-op) — this is the default,
   * so the feature is strictly opt-in.
   */
  embeddingProvider?: string;
  /** Embedding model id (default: text-embedding-3-small). */
  embeddingModel?: string;
  /** OpenAI-compatible base URL (default: https://api.openai.com or OPENAI_BASE_URL). */
  embeddingBaseUrl?: string;
  /**
   * Embedding API key. Prefer `embeddingApiKeyEnv` to avoid storing secrets in
   * settings files; this direct field exists for parity but is discouraged.
   */
  embeddingApiKey?: string;
  /** Env var name to read the embedding API key from (default: OPENAI_API_KEY). */
  embeddingApiKeyEnv?: string;
}

export const TASK_DEFAULTS: TaskConfig = {};

const SETTINGS_KEY = "llm-wiki";

function readModelSpec(value: unknown): { provider: string; id: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.provider === "string" && typeof v.id === "string" && v.provider && v.id) {
    return { provider: v.provider, id: v.id };
  }
  return undefined;
}

function readNamespacedConfig(path: string): Partial<TaskConfig> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const nested = raw[SETTINGS_KEY];
    if (!nested || typeof nested !== "object") return {};
    const section = nested as Record<string, unknown>;
    const out: Partial<TaskConfig> = {};
    const taskModel = readModelSpec(section.taskModel);
    if (taskModel) out.taskModel = taskModel;

    for (const key of [
      "embeddingProvider",
      "embeddingModel",
      "embeddingBaseUrl",
      "embeddingApiKey",
      "embeddingApiKeyEnv",
    ] as const) {
      const value = section[key];
      if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function loadTaskConfig(cwd: string): TaskConfig {
  let globalPath: string;
  try {
    globalPath = join(getAgentDir(), "settings.json");
  } catch {
    globalPath = "";
  }
  const projectPath = join(cwd, ".pi", "settings.json");

  return {
    ...TASK_DEFAULTS,
    ...(globalPath ? readNamespacedConfig(globalPath) : {}),
    ...readNamespacedConfig(projectPath),
  };
}
