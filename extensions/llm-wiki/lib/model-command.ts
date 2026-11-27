import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { registerModelCommand } from "./model-command-core.js";
import type { Runtime } from "./runtime.js";

const MAX_VISIBLE = 10;

function buildSelectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("dim", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("muted", text),
  };
}

/** Case-insensitive substring on label/value. Not SelectList.setFilter (prefix-on-value). */
function itemMatchesQuery(item: SelectItem, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return item.label.toLowerCase().includes(needle) || item.value.toLowerCase().includes(needle);
}

/** Editor-dock picker; `ui.custom` without overlay replaces the input slot like `/model`. */
class ModelPickerScreen extends Container {
  private readonly allItems: SelectItem[];
  private readonly listTheme: SelectListTheme;
  private readonly search: Input;
  private list: SelectList;
  private doneFn: (result?: string) => void;
  private closed = false;

  constructor(
    title: string,
    items: SelectItem[],
    selectedIndex: number,
    theme: Theme,
    done: (result?: string) => void,
  ) {
    super();
    this.allItems = items;
    this.listTheme = buildSelectTheme(theme);
    this.doneFn = done;
    this.addChild(new Text(title, 0, 0));
    this.addChild(new Spacer(1));
    this.search = new Input();
    this.search.focused = true;
    this.addChild(this.search);
    this.list = this.makeList(items, selectedIndex);
    this.addChild(this.list);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.confirm")
    ) {
      this.list.handleInput(data);
      return;
    }
    // tui.select.cancel defaults to escape + ctrl+c and the kitty CSI-u Esc
    // form, so one keybinding check covers every cancel keypath (no hardcoded Esc,
    // so a remapped binding is honored).
    if (kb.matches(data, "tui.select.cancel")) {
      this.finish(undefined);
      return;
    }
    this.search.handleInput(data);
    this.applyFilter();
  }

  private makeList(items: SelectItem[], selectedIndex: number): SelectList {
    const list = new SelectList(
      items,
      Math.min(MAX_VISIBLE, Math.max(items.length, 1)),
      this.listTheme,
    );
    list.setSelectedIndex(selectedIndex);
    list.onSelect = (item) => this.finish(item.value);
    list.onCancel = () => this.finish(undefined);
    return list;
  }

  private applyFilter(): void {
    const filtered = this.allItems.filter((item) => itemMatchesQuery(item, this.search.getValue()));
    const previous = this.list.getSelectedItem()?.value;
    const selectedIndex = Math.max(
      0,
      filtered.findIndex((item) => item.value === previous),
    );
    this.removeChild(this.list);
    this.list = this.makeList(filtered, selectedIndex);
    this.addChild(this.list);
  }

  private finish(result?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.doneFn(result);
  }
}

/**
 * Register the `/wiki-model` slash command. Lets the user view the active
 * background task model and choose another (or revert to the session model).
 * The choice is persisted to project settings and applied immediately.
 *
 *   /wiki-model                 → interactive picker (lists available models)
 *   /wiki-model provider/id     → set directly (scriptable / no UI needed)
 *   /wiki-model session|clear   → clear the override, use the session model
 */
export function registerWikiModelCommand(pi: ExtensionAPI, runtime: Runtime): void {
  registerModelCommand(pi, runtime, async (ui, current, items, selectedIndex) => {
    if (typeof ui.custom !== "function") {
      ui.notify(
        `LLM Wiki: this host does not support the model picker. Pass provider/id (e.g. anthropic/claude-haiku) or "session". Active: ${current}.`,
        "warning",
      );
      return undefined;
    }
    return ui.custom<string | undefined>((_tui, theme, _keybindings, done) => {
      return new ModelPickerScreen(
        `Wiki background model (current: ${current})`,
        items,
        selectedIndex,
        theme,
        done,
      );
    });
  });
}
