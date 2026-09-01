import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildSettingItems,
  registerWikiSettingsCommand,
} from "../extensions/llm-wiki/lib/settings-command.js";
import {
  loadTaskConfig,
  loadTaskConfigSources,
  persistSetting,
} from "../extensions/llm-wiki/lib/task-config.js";

/**
 * /wiki-settings command tests.
 *
 * The settings screen is a persistent pi-tui SettingsList rendered through
 * ui.custom(). Tests drive it the way the terminal would: raw key sequences
 * through the screen's handleInput(), plus render() output for cursor position.
 */

interface NotifyCall {
  message: string;
  type: string;
}

type Handler = (args: string, ctx: Record<string, unknown>) => Promise<void>;

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const fakePi = {
    registerCommand: (_name: string, descriptor: { handler: Handler }) => {
      handler = descriptor.handler;
    },
  };
  registerWikiSettingsCommand(fakePi as never, { ensureConfig: () => {} } as never);
  if (!handler) throw new Error("handler was not registered");
  return handler;
}

const fakeTheme = { fg: (_color: string, text: string) => text };

interface Screen {
  handleInput(data: string): void;
  render(width: number): string[];
}

interface InputLike {
  getValue(): string;
}

/**
 * Fake ctx. `custom` runs the factory synchronously inside the promise
 * executor, so the screen is available as soon as the handler awaits it.
 */
function makeCtx(opts: {
  cwd: string;
  hasUI?: boolean;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  custom?: (
    factory: (tui: unknown, theme: unknown, kb: unknown, done: (r?: unknown) => void) => unknown,
  ) => Promise<unknown>;
}) {
  const notifications: NotifyCall[] = [];
  const screen: { current?: Screen } = {};
  return {
    cwd: opts.cwd,
    hasUI: opts.hasUI ?? true,
    ui: {
      select: opts.select ?? (async (_title: string, options: string[]) => options[0]),
      notify: (message: string, type: string) => {
        notifications.push({ message, type });
      },
      custom:
        opts.custom ??
        ((
          factory: (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (r?: unknown) => void,
          ) => unknown,
        ) =>
          new Promise((resolve) => {
            screen.current = factory(null, fakeTheme, null, resolve) as Screen;
          })),
    },
    _notifications: notifications,
    _screen: screen,
  };
}

function notifs(ctx: Record<string, unknown>): NotifyCall[] {
  return ctx._notifications as NotifyCall[];
}

/** Flush microtasks so the handler reaches the custom factory. */
function tick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Key events arrive one per call in a real terminal — match that. */
function keys(screen: Screen, seq: string, n: number) {
  for (let i = 0; i < n; i++) screen.handleInput(seq);
}

/** A cwd guaranteed outside $HOME (scope picker shown, project writes isolated). */
function outsideHomeDir(tag: string) {
  return mkdtempSync(join(tmpdir(), `wiki-settings-${tag}-`));
}

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const BACKSPACE = "\b"; // pi's deleteCharBackward binding is \b, not \x7f

const SETTINGS_LINE_OFFSET = 2; // header line + spacer before the first item

describe("/wiki-settings screen", () => {
  let handler: Handler;
  const dirs: string[] = [];
  let priorAgentDir: string | undefined;

  beforeAll(() => {
    handler = captureHandler();
  });

  beforeEach(() => {
    const agentTmp = outsideHomeDir("agent");
    dirs.push(agentTmp);
    priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    // Redirect global settings writes into a temp agent dir.
    process.env.PI_CODING_AGENT_DIR = join(agentTmp, "agent-home");
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: must truly unset; assigning undefined sets the string "undefined" in Node
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function project(tag: string) {
    const tmp = outsideHomeDir(tag);
    dirs.push(tmp);
    return tmp;
  }

  it("shows warning when hasUI is false", async () => {
    const tmp = project("no-ui");
    const ctx = makeCtx({ cwd: tmp, hasUI: false });
    await handler("", ctx);
    expect(notifs(ctx).some((n) => n.type === "warning" && /interactive/.test(n.message))).toBe(
      true,
    );
  });

  it("toggles a boolean in place, persists to project scope, keeps cursor", async () => {
    const tmp = project("toggle");
    const ctx = makeCtx({
      cwd: tmp,
      select: async (_title, options) => options[0], // scope: Project
    });
    const pending = handler("", ctx);
    await tick();
    const screen = ctx._screen!.current!;

    // Items: 0 Scope, 1 Model, 2 Synthesis Tokens, 3 Trajectories — move to #3.
    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(SPACE);

    expect(loadTaskConfig(tmp).trajectories).toBe(true);

    // No screen reset: cursor still on Trajectories (header+spacer + 3 items).
    const lines = screen.render(80);
    expect(lines[SETTINGS_LINE_OFFSET + 3]).toContain("Trajectories");
    expect(lines[SETTINGS_LINE_OFFSET + 3]).toContain("→");

    // Toggle back off.
    screen.handleInput(SPACE);
    expect(loadTaskConfig(tmp).trajectories).toBe(false);

    // Esc closes the screen.
    screen.handleInput(ESC);
    await pending;
    expect(existsSync(join(tmp, ".pi", "settings.json"))).toBe(true);
  });

  it("edits a number through the submenu (global scope) and restores the cursor", async () => {
    const tmp = project("number");
    const ctx = makeCtx({
      cwd: tmp,
      select: async (_title, options) => options[1], // scope: Global
    });
    const pending = handler("", ctx);
    await tick();
    const screen = ctx._screen!.current!;

    // Item 2 = Synthesis Tokens. Enter opens its input submenu (raw prefill).
    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(ENTER);
    keys(screen, BACKSPACE, 16);
    screen.handleInput("999999");
    screen.handleInput(ENTER);

    // Written to the (redirected) global settings, not the project file.
    expect(loadTaskConfig(tmp).synthesisMaxTokens).toBe(999999);
    const projectJson = existsSync(join(tmp, ".pi", "settings.json"))
      ? (JSON.parse(readFileSync(join(tmp, ".pi", "settings.json"), "utf8")) as Record<
          string,
          Record<string, unknown>
        >)
      : {};
    expect(projectJson["llm-wiki"]?.synthesisMaxTokens).toBeUndefined();

    // Cursor restored to Synthesis Tokens (item row 2).
    const lines = screen.render(80);
    expect(lines[SETTINGS_LINE_OFFSET + 2]).toContain("Synthesis Tokens");
    expect(lines[SETTINGS_LINE_OFFSET + 2]).toContain("→");

    screen.handleInput(ESC);
    await pending;
  });

  it("rejects an invalid number, stays in the submenu, then escs out", async () => {
    const tmp = project("invalid");
    const ctx = makeCtx({
      cwd: tmp,
      select: async (_title, options) => options[0], // scope: Project
    });
    const pending = handler("", ctx);
    await tick();
    const screen = ctx._screen!.current!;

    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(ENTER);
    keys(screen, BACKSPACE, 16);
    screen.handleInput("abc");
    screen.handleInput(ENTER);

    expect(notifs(ctx).some((n) => n.type === "error" && /invalid/i.test(n.message))).toBe(true);
    // Still editing: the input line holds "abc", the list is not shown.
    expect(screen.render(80).join("\n")).toContain("abc");

    // Esc closes the submenu (list back), Esc closes the screen.
    screen.handleInput(ESC);
    expect(screen.render(80)[0]).toContain("LLM Wiki Settings");
    screen.handleInput(ESC);
    await pending;
    expect(loadTaskConfig(tmp).synthesisMaxTokens).toBeUndefined();
  });

  it("sets and clears the model through the submenu", async () => {
    const tmp = project("model");
    const ctx = makeCtx({
      cwd: tmp,
      select: async (_title, options) => options[0], // scope: Project
    });
    const pending = handler("", ctx);
    await tick();
    const screen = ctx._screen!.current!;

    // Item 1 = Model (cursor starts on the Scope row). Enter + type.
    screen.handleInput(DOWN);
    screen.handleInput(ENTER);
    screen.handleInput("openai/gpt-4o");
    screen.handleInput(ENTER);
    expect(loadTaskConfig(tmp).taskModel).toEqual({ provider: "openai", id: "gpt-4o" });

    let lines = screen.render(80);
    expect(lines[SETTINGS_LINE_OFFSET + 1]).toContain("Model");
    expect(lines[SETTINGS_LINE_OFFSET + 1]).toContain("openai/gpt-4o");
    expect(lines[SETTINGS_LINE_OFFSET + 1]).toContain("→");

    // Reopen, clear the prefill, empty submit → clears to session model.
    screen.handleInput(ENTER);
    keys(screen, BACKSPACE, 32);
    screen.handleInput(ENTER);
    expect(loadTaskConfig(tmp).taskModel).toBeUndefined();
    lines = screen.render(80);
    expect(lines[SETTINGS_LINE_OFFSET + 1]).toContain("(session model)");

    screen.handleInput(ESC);
    await pending;
  });

  it("asks for scope first when cwd is outside home", async () => {
    const tmp = project("scope");
    let selectCalls = 0;
    const ctx = makeCtx({
      cwd: tmp,
      select: async (_title, options) => {
        selectCalls++;
        if (selectCalls === 1) return options[0]; // scope picker → Project
        return undefined;
      },
      custom: () => new Promise(() => {}), // test ends before the screen is driven
    });
    const pending = handler("", ctx);
    await tick();
    expect(selectCalls).toBe(1);
    void pending; // screen intentionally left open
  });

  it("shows a Scope row first, and cycling it re-targets where writes land", async () => {
    const tmp = project("scope-cycle");
    const ctx = makeCtx({
      cwd: tmp,
      select: async (_title, options) => options[0], // scope picker → Project
    });
    const pending = handler("", ctx);
    await tick();
    const screen = ctx._screen!.current!;

    // Scope row is the first item, starting at Project.
    let lines = screen.render(80);
    expect(lines[SETTINGS_LINE_OFFSET]).toContain("Scope");
    expect(lines[SETTINGS_LINE_OFFSET]).toContain("Project");

    // Cycle Scope → Global (cursor starts on the Scope row).
    screen.handleInput(SPACE);
    lines = screen.render(80);
    expect(lines[SETTINGS_LINE_OFFSET]).toContain("Global");

    // Move to Notices (row 4) and toggle — the write must land in the
    // (redirected) global file, not the project file.
    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(SPACE);

    expect(loadTaskConfig(tmp).notices).toBe(false);
    const agentSettings = JSON.parse(
      readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    expect(agentSettings["llm-wiki"]?.notices).toBe(false);
    if (existsSync(join(tmp, ".pi", "settings.json"))) {
      const projectJson = JSON.parse(
        readFileSync(join(tmp, ".pi", "settings.json"), "utf8"),
      ) as Record<string, Record<string, unknown>>;
      expect(projectJson["llm-wiki"]?.notices).toBeUndefined();
    }

    screen.handleInput(ESC);
    await pending;
  });

  it("scopes inside home to Global without asking", async () => {
    const priorHome = process.env.HOME;
    const fakeHome = outsideHomeDir("fakehome");
    dirs.push(fakeHome);
    process.env.HOME = fakeHome;
    try {
      const tmp = join(fakeHome, "proj");
      mkdirSync(tmp, { recursive: true });
      let pickerShown = false;
      const ctx = makeCtx({
        cwd: tmp,
        select: async () => {
          pickerShown = true;
          return "Global";
        },
      });
      const pending = handler("", ctx);
      await tick();
      const screen = ctx._screen!.current!;
      const lines = screen.render(80);
      expect(lines[SETTINGS_LINE_OFFSET]).toContain("Global"); // scope row, silent Global
      expect(pickerShown).toBe(false);
      screen.handleInput(ESC);
      await pending;
    } finally {
      // biome-ignore lint/performance/noDelete: must truly unset; assigning undefined sets the string "undefined" in Node
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it("notes that changing trajectories applies after a reload", async () => {
    const tmp = project("traj-note");
    const ctx = makeCtx({
      cwd: tmp,
      select: async (_title, options) => options[0], // scope: Project
    });
    const pending = handler("", ctx);
    await tick();
    const screen = ctx._screen!.current!;

    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(DOWN);
    screen.handleInput(SPACE); // Trajectories ON

    expect(loadTaskConfig(tmp).trajectories).toBe(true);
    expect(notifs(ctx).some((n) => /reload/i.test(n.message))).toBe(true);

    screen.handleInput(ESC);
    await pending;
  });
});

// ── buildSettingItems (pure) ─────────────────────────────

describe("buildSettingItems", () => {
  let tmpDir: string;
  let priorAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `ws-items-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, "agent-home");
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: must truly unset; assigning undefined sets the string "undefined" in Node
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function fixture() {
    persistSetting(tmpDir, "project", "notices", false);
    persistSetting(tmpDir, "project", "synthesisMaxTokens", 32768);
    persistSetting(tmpDir, "project", "taskModel", { provider: "anthropic", id: "claude-haiku" });
    return loadTaskConfigSources(tmpDir);
  }

  it("booleans get OFF/ON cycle values and no submenu", () => {
    const items = buildSettingItems(fixture(), () => {});
    const traj = items.find((i) => i.id === "trajectories")!;
    expect(traj.values).toEqual(["OFF", "ON"]);
    expect(traj.submenu).toBeUndefined();
    expect(traj.currentValue).toBe("OFF"); // default off
  });

  it("reflects overridden values and source", () => {
    const items = buildSettingItems(fixture(), () => {});
    const notices = items.find((i) => i.id === "notices")!;
    expect(notices.currentValue).toBe("OFF");
    expect(notices.description).toContain("project");
    const maxTok = items.find((i) => i.id === "synthesisMaxTokens")!;
    expect(maxTok.currentValue).toBe("32768");
    expect(maxTok.description).toContain("project");
  });

  it("marks unset settings as default", () => {
    const items = buildSettingItems(fixture(), () => {});
    const lang = items.find((i) => i.id === "synthesisLanguage")!;
    expect(lang.description).toMatch(/default/i);
  });

  it("non-boolean items expose a submenu with a raw-value input prefill", () => {
    const items = buildSettingItems(fixture(), () => {});
    for (const id of [
      "taskModel",
      "synthesisMaxTokens",
      "synthesisLanguage",
      "embeddingProvider",
    ]) {
      const item = items.find((i) => i.id === id)!;
      expect(item.submenu, id).toBeTypeOf("function");
      const sub = item.submenu!("unused", () => {}) as unknown as {
        children: { getValue?: () => string }[];
      };
      const input = sub.children.find((c) => typeof c.getValue === "function");
      expect(input, `${id}: input child exists`).toBeDefined();
    }
    const maxTok = items.find((i) => i.id === "synthesisMaxTokens")!;
    const input = (
      maxTok.submenu!("unused", () => {}) as unknown as {
        children: InputLike[];
      }
    ).children.find((c) => typeof (c as { getValue?: unknown }).getValue === "function") as
      | InputLike
      | undefined;
    expect(input?.getValue()).toBe("32768");
  });
});

// ── Pure config tests (no TUI) ──────────────────

describe("persistSetting + loadTaskConfigSources", () => {
  let tmpDir: string;
  let priorAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `ws-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, "agent-home");
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: must truly unset; assigning undefined sets the string "undefined" in Node
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadTaskConfigSources reports source correctly", () => {
    // Set at project level
    persistSetting(tmpDir, "project", "notices", false);
    const sources = loadTaskConfigSources(tmpDir);
    expect(sources.notices).toEqual({ value: false, source: "project" });
  });

  it("project wins over global in source tracking", () => {
    // Set at global level
    const agentDir = join(tmpDir, "agent-home");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ "llm-wiki": { notices: false } }),
    );
    // Override at project level
    persistSetting(tmpDir, "project", "notices", true);
    const sources = loadTaskConfigSources(tmpDir);
    expect(sources.notices).toEqual({ value: true, source: "project" });
  });

  it("unset settings show source as 'default' with undefined value", () => {
    const sources = loadTaskConfigSources(tmpDir);
    expect(sources.semanticWeight).toEqual({ value: undefined, source: "default" });
  });

  it("persistSetting boolean toggle round-trips", () => {
    persistSetting(tmpDir, "project", "trajectories", true);
    expect(loadTaskConfig(tmpDir).trajectories).toBe(true);
    persistSetting(tmpDir, "project", "trajectories", undefined);
    expect(loadTaskConfig(tmpDir).trajectories).toBeUndefined();
  });
});
