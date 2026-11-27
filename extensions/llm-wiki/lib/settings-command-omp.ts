import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveGlobalSettingsPath, resolveProjectSettingsPath } from "./host.js";
import type { Runtime } from "./runtime.js";
import { describeSetting, SETTINGS, type SettingDef } from "./settings-definitions.js";
import { loadTaskConfigSources, persistSetting, type SettingScope } from "./task-config.js";

type Ui = ExtensionCommandContext["ui"];

async function selectScope(ui: Ui, cwd: string): Promise<SettingScope | undefined> {
  const project = `Project (${resolveProjectSettingsPath(cwd)})`;
  const global = `Global (${resolveGlobalSettingsPath()})`;
  const pick = await ui.select("LLM Wiki — Settings scope?", [project, global]);
  return pick === project ? "project" : pick === global ? "global" : undefined;
}

async function editSetting(
  ui: Ui,
  def: SettingDef,
  current: unknown,
  source: string,
): Promise<{ value: unknown } | undefined> {
  const detail = describeSetting(def, source);
  if (def.type === "boolean") {
    const pick = await ui.select(`${def.label}\n${detail}`, ["ON", "OFF"]);
    return pick === undefined ? undefined : { value: pick === "ON" };
  }
  if (def.type === "model") {
    const pick = await ui.select(`${def.label}\n${detail}`, ["Set model", "Use session model"]);
    if (pick === undefined) return undefined;
    if (pick === "Use session model") return { value: undefined };
  }
  const raw = await ui.input(
    `${def.label} (current: ${def.format(current)})\n${detail}`,
    def.toEdit(current),
  );
  const input = raw?.trim();
  if (!input) return undefined;
  const value = def.parse(input);
  if (value !== undefined) return { value };
  ui.notify(
    def.type === "model"
      ? `LLM Wiki: could not parse "${input}". Use provider/id.`
      : `LLM Wiki: invalid value "${input}" for ${def.label}`,
    "error",
  );
  return undefined;
}

export function registerOmpWikiSettingsCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("wiki-settings", {
    description: "View and edit LLM Wiki settings (model, tokens, behaviors, embeddings)",
    handler: async (_args, ctx) => {
      const { cwd, ui } = ctx;
      runtime.ensureConfig(cwd);
      if (!ctx.hasUI) {
        ui.notify(
          "LLM Wiki: /wiki-settings requires an interactive UI. Edit settings.json directly instead.",
          "warning",
        );
        return;
      }

      let scope = await selectScope(ui, cwd);
      if (!scope) return;
      for (;;) {
        const sources = loadTaskConfigSources(cwd);
        const scopeRow = `Scope: ${scope === "global" ? "Global" : "Project"}`;
        const labels = SETTINGS.map((def) => {
          const entry = sources[def.key];
          return `${def.label}: ${def.format(entry?.value)} [${entry?.source ?? "default"}]`;
        });
        const pick = await ui.select("LLM Wiki Settings (Esc to close)", [scopeRow, ...labels]);
        if (pick === undefined) return;
        if (pick === scopeRow) {
          scope = (await selectScope(ui, cwd)) ?? scope;
          continue;
        }
        const def = SETTINGS[labels.indexOf(pick)];
        if (!def) return;
        const entry = sources[def.key];
        const edit = await editSetting(ui, def, entry?.value, entry?.source ?? "default");
        if (!edit) continue;
        try {
          persistSetting(cwd, scope, def.key, edit.value);
        } catch (err) {
          ui.notify(
            `LLM Wiki: failed to save ${def.label}: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          continue;
        }
        if (
          def.key === "trajectories" &&
          entry?.value !== loadTaskConfigSources(cwd).trajectories?.value
        ) {
          ui.notify(
            "LLM Wiki: trajectory tools register at startup — new value applies after a reload",
          );
        }
      }
    },
  });
}
