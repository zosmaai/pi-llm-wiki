import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

  /**
   * Weight of the semantic (cosine) signal when blending with lexical score in
   * hybrid recall (issue #67). 0 = pure lexical, 1 = pure semantic boost.
   * Default 0.5. Only takes effect when embeddings exist AND an embedder is
   * configured; otherwise recall stays 100% lexical.
   */
  semanticWeight?: number;

  /**
   * Two-stage recall gate (issue #68). When the vault's registered page count
   * is STRICTLY GREATER THAN this threshold, recall switches to "links-first"
   * mode: it returns a ranked list of links (id, title, type, score, 1-line
   * snippet) instead of inline content previews, and the agent expands chosen
   * links on demand via `read`. At or below the threshold, the current
   * preview-inline behavior is preserved (no regression for small vaults).
   *
   * Page-count (not token-budget) was chosen deliberately: it is derived from
   * `meta/registry.json` in O(1) with zero extra file I/O, so the gate itself
   * never reads page bodies — token estimation would require touching every
   * page, defeating the "cheap recall" goal. Default 50. Set to 0 to force
   * links-first for any non-empty vault, or a very large number to always keep
   * previews inline. Clamped to a non-negative integer.
   */
  recallLinksThreshold?: number;

  /**
   * Surface wiki activity in the UI (issue #77). When enabled (the default),
   * the status line reflects recall hits and the periodic observe/retro
   * reminder is shown to the user (`display: true`) instead of being injected
   * silently. Set to `false` to restore the previous quiet behavior — a static
   * status line and a hidden (`display: false`) reminder — for users who do
   * not want any chat-level wiki notices.
   */
  notices?: boolean;

  /**
   * Agent-trajectory working-memory (capture → distill → recall), issue #80.
   * OPT-IN, default OFF: only an explicit `trajectories: true` enables it.
   * When off, the trajectory tools are never registered (see index.ts), so
   * they cost nothing in the system prompt for the ~95% who don't use them.
   */
  trajectories?: boolean;
}

export const TASK_DEFAULTS: TaskConfig = {};

/**
 * Resolve whether user-facing wiki notices are enabled (issue #77). Defaults
 * to `true`; only an explicit `notices: false` disables them.
 */
export function noticesEnabled(config: TaskConfig | undefined): boolean {
  return config?.notices !== false;
}

/**
 * Resolve whether agent-trajectory working-memory is enabled (issue #80).
 * INVERSE polarity of `noticesEnabled`: defaults to `false`; only an explicit
 * `trajectories: true` turns it on.
 */
export function trajectoriesEnabled(config: TaskConfig | undefined): boolean {
  return config?.trajectories === true;
}

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
  try {
    const raw = readSettingsObject(path);
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

    const weight = section.semanticWeight;
    if (typeof weight === "number" && Number.isFinite(weight)) {
      out.semanticWeight = Math.min(1, Math.max(0, weight));
    }

    const threshold = section.recallLinksThreshold;
    if (typeof threshold === "number" && Number.isFinite(threshold)) {
      out.recallLinksThreshold = Math.max(0, Math.floor(threshold));
    }

    if (typeof section.notices === "boolean") {
      out.notices = section.notices;
    }

    if (typeof section.trajectories === "boolean") {
      out.trajectories = section.trajectories;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Parse a `"provider/id"` model reference (issue #69). Splits on the FIRST
 * slash so model ids that themselves contain slashes (e.g.
 * `openrouter/meta/llama-3`) are preserved. Returns `undefined` for empty,
 * slashless, or partial (`provider/` / `/id`) refs so callers can reject bad
 * input. Whitespace is trimmed.
 */
export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();
  if (!provider || !id) return undefined;
  return { provider, id };
}

/**
 * Read a settings JSON file as a plain object, or `{}` when it is absent or
 * corrupt. Reads directly (no `existsSync` pre-check) so there is no
 * check-then-use race: a missing file throws ENOENT, which the catch treats
 * the same as an empty file.
 */
function readSettingsObject(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Missing or corrupt settings file: start from an empty object.
  }
  return {};
}

/**
 * Persist (or clear) the wiki background `taskModel` in the PROJECT settings
 * file `<cwd>/.pi/settings.json` under the namespaced `llm-wiki` key (issue
 * #69). Project settings win over global in `loadTaskConfig`, so this takes
 * effect immediately on the next config load. Other top-level keys and other
 * `llm-wiki` settings are preserved; passing `undefined` removes the key
 * (reverting to the session model).
 */
export function persistTaskModel(
  cwd: string,
  model: { provider: string; id: string } | undefined,
): void {
  const settingsPath = join(cwd, ".pi", "settings.json");
  const raw = readSettingsObject(settingsPath);

  const existing = raw[SETTINGS_KEY];
  const section: Record<string, unknown> =
    existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};

  if (model) {
    section.taskModel = { provider: model.provider, id: model.id };
  } else {
    // biome-ignore lint/performance/noDelete: one-off settings rewrite, not a hot path; removing the key (vs setting undefined) keeps the JSON clean
    delete section.taskModel;
  }
  raw[SETTINGS_KEY] = section;

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}

/**
 * Persist the agent-trajectory flag in the PROJECT settings file
 * `<cwd>/.pi/settings.json` under the namespaced `llm-wiki` key (issue #80).
 * Mirrors `persistTaskModel`: project settings win in `loadTaskConfig`, other
 * keys are preserved. `true` writes `trajectories: true`; `false` removes the
 * key (reverting to the default-off behavior).
 */
export function persistTrajectoriesEnabled(cwd: string, enabled: boolean): void {
  const settingsPath = join(cwd, ".pi", "settings.json");
  const raw = readSettingsObject(settingsPath);

  const existing = raw[SETTINGS_KEY];
  const section: Record<string, unknown> =
    existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};

  if (enabled) {
    section.trajectories = true;
  } else {
    // biome-ignore lint/performance/noDelete: one-off settings rewrite, not a hot path; removing the key keeps the JSON clean (default is off)
    delete section.trajectories;
  }
  raw[SETTINGS_KEY] = section;

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
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
