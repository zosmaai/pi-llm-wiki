import type { ExtensionAPI, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { registerWikiExtension } from "./extension.js";
import { registerDashboardCommand } from "./lib/dashboard-command-core.js";
import { registerModelCommand } from "./lib/model-command-core.js";
import { registerOmpWikiSettingsCommand } from "./lib/settings-command-omp.js";

// omp 19 rejects upstream pi-tui imports anywhere in an extension's runtime graph.
// Use native dialogs and the host's documented render/handleInput contract instead.
export default function (pi: ExtensionAPI): void {
  registerWikiExtension(pi, (api, runtime) => {
    registerModelCommand(api, runtime, async (ui, current, items, selectedIndex) => {
      const options: ExtensionUIDialogOptions & { initialIndex: number } = {
        initialIndex: selectedIndex,
      };
      const picked = await ui.select(
        `Wiki background model (current: ${current})`,
        items.map((item) => item.label),
        options,
      );
      return items.find((item) => item.label === picked)?.value;
    });
    registerOmpWikiSettingsCommand(api, runtime);
    registerDashboardCommand(api, runtime, async (ui, lines) => {
      await ui.custom(
        (_tui, _theme, _keybindings, close) => ({
          render: () => lines,
          invalidate() {},
          handleInput(data: string) {
            if (data === "\x1b" || data === "\x1b[27u" || data === "\x1b[27;1u" || data === "q") {
              close(undefined);
            }
          },
        }),
        { overlay: true },
      );
    });
  });
}
