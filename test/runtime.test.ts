import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { runSubAgent } from "../extensions/llm-wiki/lib/subagent.js";
import { loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";

// ── helpers ───────────────────────────────────────────────
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeNotifier() {
  const calls: Array<{ message: string; type?: string }> = [];
  return {
    calls,
    ui: { notify: (message: string, type?: string) => calls.push({ message, type }) },
  };
}

const SESSION_MODEL = { provider: "session-prov", id: "session-model" };
const CONFIG_MODEL = { provider: "cfg-prov", id: "cfg-model" };

function makeRegistry(opts: {
  found?: unknown;
  authOk?: boolean;
  apiKey?: string;
}) {
  return {
    find: (_p: string, _i: string) => opts.found,
    getApiKeyAndHeaders: async (_m: unknown) => ({
      ok: opts.authOk ?? true,
      apiKey: opts.apiKey ?? (opts.authOk === false ? undefined : "key-123"),
      headers: { "x-test": "1" },
    }),
  };
}

// ── task-config ───────────────────────────────────────────
describe("loadTaskConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `taskcfg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("returns empty config (no taskModel) when nothing is set", () => {
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.taskModel).toBeUndefined();
  });

  it("reads taskModel from project .pi/settings.json under the llm-wiki key", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { taskModel: { provider: "anthropic", id: "claude-haiku" } } }),
    );
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.taskModel).toEqual({ provider: "anthropic", id: "claude-haiku" });
  });

  it("ignores malformed taskModel (missing id)", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { taskModel: { provider: "anthropic" } } }),
    );
    expect(loadTaskConfig(tmpDir).taskModel).toBeUndefined();
  });

  it("ignores invalid JSON without throwing", () => {
    writeFileSync(join(tmpDir, ".pi", "settings.json"), "{ not valid json ");
    expect(() => loadTaskConfig(tmpDir)).not.toThrow();
    expect(loadTaskConfig(tmpDir).taskModel).toBeUndefined();
  });
});

// ── Runtime.resolveModel ──────────────────────────────────
describe("Runtime.resolveModel", () => {
  it("uses the session model when no taskModel is configured", async () => {
    const rt = new Runtime();
    const reg = makeRegistry({ found: undefined, authOk: true });
    const res = await rt.resolveModel({ model: SESSION_MODEL, modelRegistry: reg, hasUI: false });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.model).toBe(SESSION_MODEL);
      expect(res.apiKey).toBe("key-123");
      expect(res.headers).toEqual({ "x-test": "1" });
    }
  });

  it("prefers the configured taskModel when found in the registry", async () => {
    const rt = new Runtime();
    rt.config = { taskModel: CONFIG_MODEL };
    rt.configLoaded = true;
    const reg = makeRegistry({ found: CONFIG_MODEL, authOk: true });
    const res = await rt.resolveModel({ model: SESSION_MODEL, modelRegistry: reg, hasUI: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model).toBe(CONFIG_MODEL);
  });

  it("falls back to the session model (and warns) when the configured model is not found", async () => {
    const rt = new Runtime();
    rt.config = { taskModel: CONFIG_MODEL };
    rt.configLoaded = true;
    const reg = makeRegistry({ found: undefined, authOk: true });
    const { calls, ui } = makeNotifier();
    const res = await rt.resolveModel({
      model: SESSION_MODEL,
      modelRegistry: reg,
      hasUI: true,
      ui,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model).toBe(SESSION_MODEL);
    expect(calls.some((c) => c.type === "warning" && /not found/.test(c.message))).toBe(true);
  });

  it("returns ok:false when there is no model at all", async () => {
    const rt = new Runtime();
    const reg = makeRegistry({ found: undefined, authOk: true });
    const res = await rt.resolveModel({ model: undefined, modelRegistry: reg, hasUI: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no model available/);
  });

  it("returns ok:false when the provider has no API key", async () => {
    const rt = new Runtime();
    const reg = makeRegistry({ found: undefined, authOk: false });
    const res = await rt.resolveModel({ model: SESSION_MODEL, modelRegistry: reg, hasUI: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no API key/);
  });
});

// ── Runtime.launchTask ────────────────────────────────────
describe("Runtime.launchTask", () => {
  it("runs work off the caller's stack and resolves when done", async () => {
    const rt = new Runtime();
    let ran = false;
    const p = rt.launchTask({ hasUI: false }, "t1", async () => {
      ran = true;
    });
    expect(rt.isInFlight("t1") || ran).toBe(true);
    await p;
    expect(ran).toBe(true);
    expect(rt.isInFlight("t1")).toBe(false);
    expect(rt.pendingCount).toBe(0);
  });

  it("is single-flight per label: a duplicate launch returns the existing promise", async () => {
    const rt = new Runtime();
    const d = deferred();
    let runs = 0;
    const work = async () => {
      runs++;
      await d.promise;
    };
    const p1 = rt.launchTask({ hasUI: false }, "dup", work);
    const p2 = rt.launchTask({ hasUI: false }, "dup", work);
    expect(p2).toBe(p1);
    expect(rt.pendingCount).toBe(1);
    d.resolve();
    await p1;
    expect(runs).toBe(1);
  });

  it("allows different labels to run concurrently", async () => {
    const rt = new Runtime();
    const a = deferred();
    const b = deferred();
    const pa = rt.launchTask({ hasUI: false }, "a", async () => {
      await a.promise;
    });
    const pb = rt.launchTask({ hasUI: false }, "b", async () => {
      await b.promise;
    });
    expect(rt.pendingCount).toBe(2);
    a.resolve();
    b.resolve();
    await Promise.all([pa, pb]);
    expect(rt.pendingCount).toBe(0);
  });

  it("isolates errors: a throwing task does not reject and notifies the UI", async () => {
    const rt = new Runtime();
    const { calls, ui } = makeNotifier();
    await expect(
      rt.launchTask({ hasUI: true, ui }, "boom", async () => {
        throw new Error("kaboom");
      }),
    ).resolves.toBeUndefined();
    expect(calls.some((c) => c.type === "warning" && /kaboom/.test(c.message))).toBe(true);
    expect(rt.isInFlight("boom")).toBe(false);
  });

  it("awaitAll drains all in-flight tasks", async () => {
    const rt = new Runtime();
    const d1 = deferred();
    const d2 = deferred();
    rt.launchTask({ hasUI: false }, "x", async () => {
      await d1.promise;
    });
    rt.launchTask({ hasUI: false }, "y", async () => {
      await d2.promise;
    });
    expect(rt.pendingCount).toBe(2);
    setTimeout(() => {
      d1.resolve();
      d2.resolve();
    }, 5);
    await rt.awaitAll();
    expect(rt.pendingCount).toBe(0);
  });
});

// ── runSubAgent ───────────────────────────────────────────
describe("runSubAgent", () => {
  it("returns immediately without touching the model when the prompt is empty", async () => {
    let toolCalled = false;
    const tool = {
      name: "t",
      execute: async () => {
        toolCalled = true;
        return { content: [] };
      },
    } as unknown as AgentTool;
    await runSubAgent({
      model: { provider: "x", id: "y" } as unknown as Model<Api>,
      apiKey: "unused",
      systemPrompt: "noop",
      userPrompt: "   ",
      tools: [tool],
    });
    expect(toolCalled).toBe(false);
  });
});
