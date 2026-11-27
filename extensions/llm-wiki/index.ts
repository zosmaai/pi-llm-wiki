import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWikiExtension } from "./extension.js";
import { registerWikiDashboardCommand } from "./lib/dashboard-command.js";
import { registerWikiModelCommand } from "./lib/model-command.js";
import { registerWikiSettingsCommand } from "./lib/settings-command.js";

export default function (pi: ExtensionAPI): void {
  registerWikiExtension(pi, (api, runtime) => {
    registerWikiModelCommand(api, runtime);
    registerWikiSettingsCommand(api, runtime);
    registerWikiDashboardCommand(api, runtime);
  });
}
