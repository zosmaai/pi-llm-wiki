/**
 * /wiki-dashboard command.
 *
 * Read-only mirror of /wiki-settings: one persistent screen, Esc closes.
 * Unlike settings there is no per-key change — every line is computed once
 * from on-disk vault state (see lib/dashboard.ts) and rendered as plain
 * text through a Container + Text.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { registerDashboardCommand } from "./dashboard-command-core.js";
import type { Runtime } from "./runtime.js";

/** One-screen read-only TUI; handles Esc and `q`. */
export class DashboardScreen extends Container {
  private doneFn: (result?: unknown) => void;

  constructor(lines: string[], close: (result?: unknown) => void) {
    super();
    this.doneFn = close;
    this.addChild(new Text(lines.join("\n"), 1, 1));
  }

  handleInput(data: string): void {
    // ponytail: matchesKey handles every terminal key shape (raw bytes,
    // kitty CSI-u like \u001b[27u for Esc, ctrl combos) — a raw === "\u001b"
    // check only works in terminals without the kitty keyboard protocol,
    // which is exactly where Ghostty users' Esc went nowhere.
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.doneFn();
    }
  }
}

// ponytail: overlay options matching pi-blackhole's config modal style
const OVERLAY_OPTS = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "92%", maxHeight: "95%" } as const,
};

/**
 * Register the /wiki-dashboard command.
 */
export function registerWikiDashboardCommand(pi: ExtensionAPI, runtime: Runtime): void {
  registerDashboardCommand(pi, runtime, async (ui, lines) => {
    await ui.custom((_tui, _theme, _keybindings, close) => {
      return new DashboardScreen(lines, close);
    }, OVERLAY_OPTS);
  });
}
