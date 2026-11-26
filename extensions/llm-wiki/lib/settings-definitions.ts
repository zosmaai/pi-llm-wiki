import { parseModelRef } from "./task-config.js";

/** Setting definition — drives both the menu and its edit menu. */
export interface SettingDef {
  key: string;
  label: string;
  type: "boolean" | "number" | "string" | "model";
  /** Shown with the item when it is selected. */
  hint: string;
  /** Edit-menu title override (defaults to `Set <label>`). */
  menuLabel?: string;
  /** Raw text to prefill the edit input with when the value is unset. */
  defaultText?: string;
  /** Pretty-print a value for display. */
  format: (v: unknown) => string;
  /** Raw text used to prefill the edit input. */
  toEdit: (v: unknown) => string;
  /** Parse user input into a typed value. undefined = invalid. */
  parse: (input: string) => unknown | undefined;
}

export const SETTINGS: SettingDef[] = [
  {
    key: "taskModel",
    label: "Model",
    type: "model",
    hint: "Model for background wiki tasks (provider/id).",
    menuLabel: "Task model — provider/id, empty = session model",
    format: (v) => {
      const m = v as { provider: string; id: string } | undefined;
      return m ? `${m.provider}/${m.id}` : "(session model)";
    },
    toEdit: (v) => {
      const m = v as { provider: string; id: string } | undefined;
      return m ? `${m.provider}/${m.id}` : "";
    },
    parse: (input) => parseModelRef(input),
  },
  {
    key: "synthesisMaxTokens",
    label: "Synthesis Tokens",
    type: "number",
    hint: "Max output tokens for wiki synthesis runs.",
    defaultText: "16384",
    format: (v) => (v != null ? String(v) : "16384 (default)"),
    toEdit: (v) => (v != null ? String(v) : "16384"),
    parse: (input) => {
      const n = Number(input);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      return Math.floor(n);
    },
  },
  {
    key: "trajectories",
    label: "Trajectories",
    type: "boolean",
    hint: "Capture agent trajectories into the vault.",
    format: (v) => (v ? "ON" : "OFF"),
    toEdit: () => "",
    parse: (input) => Boolean(Boolean(input) && /on|true|1/i.test(input)),
  },
  {
    key: "notices",
    label: "Notices",
    type: "boolean",
    hint: "Show wiki recall/observation notice lines in chat.",
    format: (v) => (v != null ? (v ? "ON" : "OFF") : "ON (default)"),
    toEdit: () => "",
    parse: (input) => Boolean(Boolean(input) && /on|true|1/i.test(input)),
  },
  {
    key: "ambientPersonalVault",
    label: "Ambient Personal",
    type: "boolean",
    hint: "Include the personal vault in ambient session context.",
    format: (v) => (v != null ? (v ? "ON" : "OFF") : "host-dependent"),
    toEdit: () => "",
    parse: (input) => Boolean(Boolean(input) && /on|true|1/i.test(input)),
  },
  {
    key: "synthesisLanguage",
    label: "Synthesis Language",
    type: "string",
    hint: "Language for synthesized wiki content.",
    defaultText: "en",
    format: (v) => (v ? String(v) : "en (default)"),
    toEdit: (v) => (v ? String(v) : "en"),
    parse: (input) => {
      const trimmed = input.trim();
      return trimmed || undefined;
    },
  },
  {
    key: "semanticWeight",
    label: "Semantic Weight",
    type: "number",
    hint: "0–1 weight for embedding (semantic) recall.",
    defaultText: "0.5",
    format: (v) => (v != null ? String(v) : "0.5 (default)"),
    toEdit: (v) => (v != null ? String(v) : "0.5"),
    parse: (input) => {
      const n = Number(input);
      if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
      return n;
    },
  },
  {
    key: "recallLinksThreshold",
    label: "Recall Links",
    type: "number",
    hint: "Max recall links shown when the vault is large.",
    defaultText: "50",
    format: (v) => (v != null ? String(v) : "50 (default)"),
    toEdit: (v) => (v != null ? String(v) : "50"),
    parse: (input) => {
      const n = Number(input);
      if (!Number.isFinite(n) || n < 0) return undefined;
      return Math.floor(n);
    },
  },
  {
    key: "recallSkillInlineMax",
    label: "Skill Inline Max",
    type: "number",
    hint: "Max characters inlined from recall into skill prompts.",
    defaultText: "1600",
    format: (v) => (v != null ? String(v) : "1600 (default)"),
    toEdit: (v) => (v != null ? String(v) : "1600"),
    parse: (input) => {
      const n = Number(input);
      if (!Number.isFinite(n) || n < 0) return undefined;
      return Math.floor(n);
    },
  },
  {
    key: "embeddingProvider",
    label: "Embedding Provider",
    type: "string",
    hint: "Embedding provider (e.g. openai). Empty = embeddings disabled.",
    format: (v) => (v ? String(v) : "(disabled)"),
    toEdit: (v) => (v ? String(v) : ""),
    parse: (input) => input.trim() || undefined,
  },
  {
    key: "embeddingModel",
    label: "Embedding Model",
    type: "string",
    hint: "Embedding model id.",
    defaultText: "text-embedding-3-small",
    format: (v) => (v ? String(v) : "text-embedding-3-small (default)"),
    toEdit: (v) => (v ? String(v) : "text-embedding-3-small"),
    parse: (input) => input.trim() || undefined,
  },
  {
    key: "embeddingBaseUrl",
    label: "Embedding Base URL",
    type: "string",
    hint: "Custom embeddings API base URL (optional).",
    format: (v) => (v ? String(v) : "—"),
    toEdit: (v) => (v ? String(v) : ""),
    parse: (input) => input.trim() || undefined,
  },
  {
    key: "embeddingApiKeyEnv",
    label: "Embedding API Key Env",
    type: "string",
    hint: "Environment variable name holding the embeddings API key.",
    defaultText: "OPENAI_API_KEY",
    format: (v) => (v ? String(v) : "OPENAI_API_KEY (default)"),
    toEdit: (v) => (v ? String(v) : "OPENAI_API_KEY"),
    parse: (input) => input.trim() || undefined,
  },
];

export function describeSetting(def: SettingDef, source: string): string {
  const where = source === "default" ? "Not set — using default." : `Set in ${source} settings.`;
  return `${def.hint}\n${where}`;
}

