import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import type { Runtime } from "./runtime.js";
import {
  loadTaskConfig,
  loadTaskConfigSources,
  parseModelRef,
  persistSetting,
  type SettingScope,
  trajectoriesEnabled,
} from "./task-config.js";

/**
 * Settings TUI for LLM Wiki.
 *
 * /wiki-settings renders the whole screen as ONE persistent pi-tui
 * SettingsList (the same component pi's own /settings uses), shown through
 * ui.custom():
 *
 *   - booleans cycle OFF/ON in place (Enter/Space) — no screen reset,
 *     the cursor stays where it is
 *   - strings/numbers/model open an inline input submenu; closing it
 *     restores the cursor to the same item
 *   - every change persists immediately to the chosen scope
 *     (project or global) and the display normalizes in place
 *
 * Flow:
 *   1. cwd inside ~/ → global scope; outside ~/ → scope picker first
 *   2. persistent settings screen (Esc closes)
 */

interface Ui {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Hosts that can render a focused custom component (pi ≥ 0.70 interactive). */
  custom?(
    factory: (
      tui: unknown,
      theme: Theme,
      keybindings: unknown,
      done: (result?: unknown) => void,
    ) => unknown,
    options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
  ): Promise<unknown>;
}

/** Setting definition — drives both the menu and its edit menu. */
interface SettingDef {
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

const SETTINGS: SettingDef[] = [
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

function isInsideHome(cwd: string): boolean {
  return cwd.startsWith(homedir());
}

/**
 * Map effective settings + sources to pi-tui SettingItems.
 *
 * Exported for tests. `notify` is used by edit menus to report invalid input
 * without closing the menu.
 */
export function buildSettingItems(
  sources: Record<string, { value: unknown; source: string }>,
  notify: (message: string, type?: "error") => void,
): SettingItem[] {
  return SETTINGS.map((def) => {
    const entry = sources[def.key];
    const value = entry?.value;
    const source = entry?.source ?? "default";

    const item: SettingItem = {
      id: def.key,
      label: def.label,
      currentValue: def.format(value),
      description: describeSetting(def, source),
    };

    if (def.type === "boolean") {
      item.values = ["OFF", "ON"];
      return item;
    }

    item.submenu = (_display, done) => {
      const sub = new InputSubmenu(def.menuLabel ?? `Set ${def.label}`, def.toEdit(value));
      sub.input.onSubmit = (raw) => {
        const trimmed = raw.trim();
        if (def.type === "model") {
          if (!trimmed) {
            done(""); // clear → back to session model
            return;
          }
          const ref = parseModelRef(trimmed);
          if (!ref) {
            notify(`LLM Wiki: could not parse "${trimmed}". Use provider/id.`, "error");
            return; // stay in the menu
          }
          done(`${ref.provider}/${ref.id}`);
          return;
        }
        if (!trimmed) {
          done(); // empty = no change
          return;
        }
        const parsed = def.parse(trimmed);
        if (parsed === undefined) {
          notify(`LLM Wiki: invalid value "${trimmed}" for ${def.label}`, "error");
          return; // stay in the menu
        }
        done(String(parsed));
      };
      sub.input.onEscape = () => done();
      return sub;
    };
    return item;
  });
}

function describeSetting(def: SettingDef, source: string): string {
  const where = source === "default" ? "Not set — using default." : `Set in ${source} settings.`;
  return `${def.hint}\n${where}`;
}

/**
 * Parse the display string a SettingItem cycled/edited into back into the
 * typed value to persist.
 */
function parseDisplay(def: SettingDef, display: string): unknown {
  if (def.type === "boolean") return display === "ON";
  if (def.type === "model") return display ? parseModelRef(display) : undefined;
  return def.parse(display);
}

function buildSettingsListTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
}

/** Title + single-line input. SettingsList forwards all key input here. */
class InputSubmenu extends Container {
  readonly input: Input;

  constructor(label: string, initialValue: string) {
    super();
    this.addChild(new Text(label, 0, 0));
    this.input = new Input();
    // Type the prefill instead of setValue(): setValue keeps the cursor at 0,
    // which makes backspace no-op and typed input land before the prefill.
    if (initialValue) this.input.handleInput(initialValue);
    this.addChild(this.input);
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

/** Header + settings list. ui.custom gives this component focus. */
class SettingsScreen extends Container {
  private list: SettingsList;
  private titleText: Text;

  constructor(title: string, list: SettingsList) {
    super();
    this.list = list;
    this.titleText = new Text(title, 0, 0);
    this.addChild(this.titleText);
    this.addChild(new Spacer(1));
    this.addChild(list);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  /** Update the header line in place (scope changes re-target it live). */
  setTitle(title: string): void {
    this.titleText.setText(title);
  }
}

/** Build the header title for the scope currently being written to. */
function scopeTitle(scope: SettingScope): string {
  return `\u{1F9E0} LLM Wiki Settings \u2014 ${scope === "global" ? "Global" : "Project"} (Esc to close)`;
}

// ponytail: overlay options matching pi-blackhole's config modal style
const OVERLAY_OPTS = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "92%", maxHeight: "95%" },
};

async function showSettingsTui(ui: Ui, cwd: string, scope: SettingScope): Promise<void> {
  if (typeof ui.custom !== "function") {
    ui.notify(
      "LLM Wiki: this host does not support the settings screen. Edit settings.json directly.",
      "warning",
    );
    return;
  }

  // The editable Scope row re-targets where subsequent writes land; the
  // picker / inside-home heuristic only chooses the starting value.
  let writeScope = scope;
  const scopeItem: SettingItem = {
    id: "scope",
    label: "Scope",
    currentValue: writeScope === "global" ? "Global" : "Project",
    values: ["Global", "Project"],
    description:
      "Where edits are written. Global \u2192 ~/.pi/agent/settings.json \u00b7 Project \u2192 .pi/settings.json (this folder).",
  };
  const items = [scopeItem, ...buildSettingItems(loadTaskConfigSources(cwd), ui.notify.bind(ui))];
  // Tracks the effective value so the reload note fires on actual changes.
  let prevTrajectories = trajectoriesEnabled(loadTaskConfig(cwd));

  let list: SettingsList | undefined;
  let screenRef: SettingsScreen | undefined;

  await ui.custom((_tui, theme, _keybindings, close) => {
    list = new SettingsList(
      items,
      items.length,
      buildSettingsListTheme(theme),
      (id, display) => {
        if (!list) return;
        // Scope row: re-target writes; nothing is persisted for it.
        if (id === "scope") {
          writeScope = display === "Global" ? "global" : "project";
          list.updateValue("scope", display);
          screenRef?.setTitle(scopeTitle(writeScope));
          ui.notify(
            `LLM Wiki: writing to ${
              writeScope === "global"
                ? "Global (~/.pi/agent/settings.json)"
                : "Project (.pi/settings.json)"
            }`,
          );
          return;
        }
        const def = SETTINGS.find((d) => d.key === id);
        if (!def) return;
        const value = parseDisplay(def, display);
        // Non-model, non-boolean values are validated before done(); undefined
        // here is only expected for the model-clear case.
        if (value === undefined && def.type !== "model") return;
        try {
          persistSetting(cwd, writeScope, def.key, value);
        } catch (err) {
          ui.notify(
            `LLM Wiki: failed to save ${def.label}: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          return;
        }
        // Normalize the displayed value in place (e.g. cleared model shows
        // "(session model)"; "0.50" becomes "0.5").
        list.updateValue(id, def.format(value));
        // trajectories gates tool registration at startup, so a live toggle
        // cannot add/remove the 3 tools mid-session \u2014 say so on real changes.
        if (def.key === "trajectories") {
          const next = Boolean(value);
          if (next !== prevTrajectories) {
            prevTrajectories = next;
            ui.notify(
              "LLM Wiki: trajectory tools register at startup \u2014 new value applies after a reload",
            );
          }
        }
      },
      () => close(),
    );
    screenRef = new SettingsScreen(scopeTitle(writeScope), list);
    return screenRef;
  }, OVERLAY_OPTS);
}

/**
 * Register the /wiki-settings command.
 */
export function registerWikiSettingsCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("wiki-settings", {
    description: "View and edit LLM Wiki settings (model, tokens, behaviors, embeddings)",
    handler: async (_args: string, ctx: { cwd: string; hasUI: boolean; ui: Ui }) => {
      runtime.ensureConfig(ctx.cwd);

      if (!ctx.hasUI) {
        ctx.ui.notify(
          "LLM Wiki: /wiki-settings requires an interactive UI. Edit settings.json directly instead.",
          "warning",
        );
        return;
      }

      let scope: SettingScope;
      if (isInsideHome(ctx.cwd)) {
        scope = "global";
      } else {
        const pick = await ctx.ui.select("LLM Wiki \u2014 Settings scope?", [
          `Project (${ctx.cwd}/.pi/settings.json)`,
          "Global (~/.pi/agent/settings.json)",
        ]);
        if (pick === undefined) return;
        scope = pick.startsWith("Project") ? "project" : "global";
      }

      await showSettingsTui(ctx.ui, ctx.cwd, scope);
    },
  });
}
