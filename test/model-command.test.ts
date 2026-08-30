/**
 * /wiki-model command tests.
 *
 * Scriptable args are covered in model-selection.test.ts. This file drives the
 * no-arg interactive picker the way the terminal would: fake ui.custom runs
 * the factory synchronously, then handleInput() + render() on the screen.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWikiModelCommand } from "../extensions/llm-wiki/lib/model-command.js";
import { loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";

type Handler = (args: string, ctx: Record<string, unknown>) => Promise<void>;

interface Screen {
  handleInput(data: string): void;
  render(width: number): string[];
}

interface NotifyCall {
  message: string;
  type?: string;
}

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const KITTY_ESC = "\u001b[27u";

const fakeTheme = { fg: (_color: string, text: string) => text };

function captureHandler(): {
  handler: Handler;
  runtime: { ensureConfig: () => void; config: { taskModel?: { provider: string; id: string } } };
} {
  let handler: Handler | undefined;
  const fakePi = {
    registerCommand: (_name: string, descriptor: { handler: Handler }) => {
      handler = descriptor.handler;
    },
  };
  const runtime = {
    ensureConfig: () => {},
    config: {} as { taskModel?: { provider: string; id: string } },
  };
  registerWikiModelCommand(fakePi as never, runtime as never);
  if (!handler) throw new Error("handler was not registered");
  return { handler, runtime };
}

function makeModels(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    provider: "prov",
    id: `m-${String(i).padStart(2, "0")}`,
  }));
}

function makeCtx(opts: {
  cwd: string;
  hasUI?: boolean;
  models?: Array<{ provider: string; id: string }>;
  custom?: boolean;
}) {
  const notifications: NotifyCall[] = [];
  const statuses: string[] = [];
  const screen: { current?: Screen } = {};
  const overlay: { opts?: unknown } = {};
  let selectCalled = false;
  const models = opts.models ?? makeModels(3);

  const ui: Record<string, unknown> = {
    notify: (message: string, type?: string) => {
      notifications.push({ message, type });
    },
    setStatus: (_key: string, value: string) => {
      statuses.push(value);
    },
    select: async () => {
      selectCalled = true;
      return undefined;
    },
  };

  if (opts.custom !== false) {
    ui.custom = (
      factory: (tui: unknown, theme: unknown, kb: unknown, done: (r?: unknown) => void) => unknown,
      customOpts?: unknown,
    ) =>
      new Promise((resolve) => {
        overlay.opts = customOpts;
        screen.current = factory(null, fakeTheme, null, resolve) as Screen;
      });
  }

  return {
    ctx: {
      cwd: opts.cwd,
      hasUI: opts.hasUI ?? true,
      model: { provider: "session-prov", id: "session-model" },
      modelRegistry: {
        getAvailable: () => models,
        getAll: () => models,
        find: (p: string, i: string) => models.find((m) => m.provider === p && m.id === i),
      },
      ui,
    },
    notifications,
    statuses,
    screen,
    overlay,
    get selectCalled() {
      return selectCalled;
    },
  };
}

function tick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("/wiki-model interactive picker", () => {
  let handler: Handler;
  let runtime: { config: { taskModel?: { provider: string; id: string } } };
  const dirs: string[] = [];
  let priorAgentDir: string | undefined;

  beforeEach(() => {
    const cap = captureHandler();
    handler = cap.handler;
    runtime = cap.runtime;
    const agentTmp = mkdtempSync(join(tmpdir(), "wiki-model-agent-"));
    dirs.push(agentTmp);
    priorAgentDir = process.env.PI_CODING_AGENT_DIR;
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
    const tmp = mkdtempSync(join(tmpdir(), `wiki-model-${tag}-`));
    dirs.push(tmp);
    mkdirSync(join(tmp, ".pi"), { recursive: true });
    return tmp;
  }

  it("notifies when hasUI is false and does not open a picker", async () => {
    const tmp = project("no-ui");
    const h = makeCtx({ cwd: tmp, hasUI: false });
    await handler("", h.ctx);
    expect(h.screen.current).toBeUndefined();
    expect(h.selectCalled).toBe(false);
    expect(
      h.notifications.some((n) => n.type === "info" && /no interactive UI/i.test(n.message)),
    ).toBe(true);
  });

  it("warns when ui.custom is missing", async () => {
    const tmp = project("no-custom");
    const h = makeCtx({ cwd: tmp, custom: false });
    await handler("", h.ctx);
    expect(h.selectCalled).toBe(false);
    expect(
      h.notifications.some(
        (n) => n.type === "warning" && /does not support the model picker/i.test(n.message),
      ),
    ).toBe(true);
  });

  it("opens a custom picker in the editor dock, not ui.select or an overlay", async () => {
    const tmp = project("custom");
    const h = makeCtx({ cwd: tmp, models: makeModels(30) });
    const pending = handler("", h.ctx);
    await tick();
    expect(h.selectCalled).toBe(false);
    expect(h.overlay.opts).toBeUndefined();
    expect(h.screen.current).toBeDefined();
    h.screen.current!.handleInput(ESC);
    await pending;
  });

  it("windows a long registry so the highlight stays on screen", async () => {
    const tmp = project("window");
    const models = makeModels(30);
    runtime.config = { taskModel: { provider: "prov", id: "m-00" } };
    const h = makeCtx({ cwd: tmp, models });
    const pending = handler("", h.ctx);
    await tick();
    const screen = h.screen.current!;

    const initial = screen.render(80);
    expect(initial.length).toBeLessThan(20);
    expect(initial.join("\n")).toMatch(/\(\d+\/31\)/);
    expect(initial.join("\n")).toContain("→ ");
    expect(initial.join("\n")).toContain("prov/m-00");
    expect(initial.join("\n")).toContain("current");

    for (let i = 0; i < 15; i++) screen.handleInput(DOWN);
    const after = screen.render(80);
    expect(after.length).toBeLessThan(20);
    expect(after.join("\n")).toContain("→ ");
    expect(after.join("\n")).toContain("prov/m-15");

    screen.handleInput(ESC);
    await pending;
  });

  it("persists the selected model on Enter", async () => {
    const tmp = project("pick");
    const h = makeCtx({ cwd: tmp, models: makeModels(5) });
    const pending = handler("", h.ctx);
    await tick();
    const screen = h.screen.current!;
    screen.handleInput(DOWN); // session row → first model
    screen.handleInput(ENTER);
    await pending;
    expect(loadTaskConfig(tmp).taskModel).toEqual({ provider: "prov", id: "m-00" });
  });

  it("does not persist when cancelled with Esc", async () => {
    const tmp = project("esc");
    const h = makeCtx({ cwd: tmp, models: makeModels(5) });
    const pending = handler("", h.ctx);
    await tick();
    h.screen.current!.handleInput(ESC);
    await pending;
    expect(loadTaskConfig(tmp).taskModel).toBeUndefined();
  });

  it("cancels on Escape under the kitty keyboard protocol (CSI-u form)", async () => {
    const tmp = project("kitty");
    const h = makeCtx({ cwd: tmp, models: makeModels(5) });
    const pending = handler("", h.ctx);
    await tick();
    h.screen.current!.handleInput(KITTY_ESC);
    await pending;
    expect(loadTaskConfig(tmp).taskModel).toBeUndefined();
  });
});
