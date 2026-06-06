import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatActiveModelLabel } from "../extensions/llm-wiki/lib/model-command.js";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import {
  loadTaskConfig,
  parseModelRef,
  persistTaskModel,
} from "../extensions/llm-wiki/lib/task-config.js";

const SESSION_MODEL = { provider: "session-prov", id: "session-model" };
const CONFIG_MODEL = { provider: "cfg-prov", id: "cfg-model" };
const OVERRIDE_MODEL = { provider: "ovr-prov", id: "ovr-model" };

function makeNotifier() {
  const calls: Array<{ message: string; type?: string }> = [];
  return {
    calls,
    ui: { notify: (message: string, type?: string) => calls.push({ message, type }) },
  };
}

/** Registry mock whose `find` resolves a known set of models by provider+id. */
function makeRegistry(known: Array<{ provider: string; id: string }>, authOk = true) {
  return {
    find: (p: string, i: string) => known.find((m) => m.provider === p && m.id === i),
    getApiKeyAndHeaders: async (_m: unknown) => ({
      ok: authOk,
      apiKey: authOk ? "key-123" : undefined,
      headers: { "x-test": "1" },
    }),
  };
}

// ── parseModelRef ─────────────────────────────────────────
describe("parseModelRef", () => {
  it("parses 'provider/id' splitting on the first slash", () => {
    expect(parseModelRef("anthropic/claude-haiku")).toEqual({
      provider: "anthropic",
      id: "claude-haiku",
    });
  });

  it("keeps slashes inside the model id (split on first only)", () => {
    expect(parseModelRef("openrouter/meta/llama-3")).toEqual({
      provider: "openrouter",
      id: "meta/llama-3",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelRef("  openai/gpt-4o  ")).toEqual({ provider: "openai", id: "gpt-4o" });
  });

  it("returns undefined for empty, slashless, or partial refs", () => {
    expect(parseModelRef("")).toBeUndefined();
    expect(parseModelRef("   ")).toBeUndefined();
    expect(parseModelRef("noprovider")).toBeUndefined();
    expect(parseModelRef("/missing-provider")).toBeUndefined();
    expect(parseModelRef("missing-id/")).toBeUndefined();
  });
});

// ── persistTaskModel (round-trips through loadTaskConfig) ──
describe("persistTaskModel", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `modelsel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("writes taskModel to project .pi/settings.json and loadTaskConfig reads it back", () => {
    persistTaskModel(tmpDir, { provider: "anthropic", id: "claude-haiku" });
    expect(loadTaskConfig(tmpDir).taskModel).toEqual({
      provider: "anthropic",
      id: "claude-haiku",
    });
  });

  it("creates the .pi directory when missing", () => {
    // tmpDir has no .pi yet.
    persistTaskModel(tmpDir, { provider: "openai", id: "gpt-4o" });
    const raw = JSON.parse(readFileSync(join(tmpDir, ".pi", "settings.json"), "utf-8"));
    expect(raw["llm-wiki"].taskModel).toEqual({ provider: "openai", id: "gpt-4o" });
  });

  it("clears taskModel when passed undefined (back to session model)", () => {
    persistTaskModel(tmpDir, { provider: "anthropic", id: "claude-haiku" });
    persistTaskModel(tmpDir, undefined);
    expect(loadTaskConfig(tmpDir).taskModel).toBeUndefined();
    const raw = JSON.parse(readFileSync(join(tmpDir, ".pi", "settings.json"), "utf-8"));
    expect(raw["llm-wiki"]?.taskModel).toBeUndefined();
  });

  it("preserves other namespaced settings and other top-level keys", () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({
        theme: "dark",
        "llm-wiki": { semanticWeight: 0.7, embeddingProvider: "openai" },
      }),
    );
    persistTaskModel(tmpDir, { provider: "anthropic", id: "claude-haiku" });
    const raw = JSON.parse(readFileSync(join(tmpDir, ".pi", "settings.json"), "utf-8"));
    expect(raw.theme).toBe("dark");
    expect(raw["llm-wiki"].semanticWeight).toBe(0.7);
    expect(raw["llm-wiki"].embeddingProvider).toBe("openai");
    expect(raw["llm-wiki"].taskModel).toEqual({ provider: "anthropic", id: "claude-haiku" });
    // And the loaded config still reflects everything.
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.semanticWeight).toBe(0.7);
    expect(cfg.taskModel).toEqual({ provider: "anthropic", id: "claude-haiku" });
  });
});

// ── resolveModel precedence: override > config > session ───
describe("Runtime.resolveModel with per-call override", () => {
  it("override wins over both configured taskModel and session model", async () => {
    const rt = new Runtime();
    rt.config = { taskModel: CONFIG_MODEL };
    rt.configLoaded = true;
    const reg = makeRegistry([CONFIG_MODEL, OVERRIDE_MODEL]);
    const res = await rt.resolveModel(
      { model: SESSION_MODEL, modelRegistry: reg, hasUI: false },
      OVERRIDE_MODEL,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model).toBe(OVERRIDE_MODEL);
  });

  it("falls back to configured taskModel when the override is not in the registry (and warns)", async () => {
    const rt = new Runtime();
    rt.config = { taskModel: CONFIG_MODEL };
    rt.configLoaded = true;
    const reg = makeRegistry([CONFIG_MODEL]); // OVERRIDE not known
    const { calls, ui } = makeNotifier();
    const res = await rt.resolveModel(
      { model: SESSION_MODEL, modelRegistry: reg, hasUI: true, ui },
      OVERRIDE_MODEL,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model).toBe(CONFIG_MODEL);
    expect(calls.some((c) => c.type === "warning" && /override/i.test(c.message))).toBe(true);
  });

  it("falls back to the session model when neither override nor config resolve", async () => {
    const rt = new Runtime();
    const reg = makeRegistry([]); // nothing known
    const res = await rt.resolveModel(
      { model: SESSION_MODEL, modelRegistry: reg, hasUI: false },
      OVERRIDE_MODEL,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model).toBe(SESSION_MODEL);
  });

  it("no override + no config still uses the session model (unchanged behavior)", async () => {
    const rt = new Runtime();
    const reg = makeRegistry([]);
    const res = await rt.resolveModel({ model: SESSION_MODEL, modelRegistry: reg, hasUI: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model).toBe(SESSION_MODEL);
  });
});

// ── formatActiveModelLabel ────────────────────────────────
describe("formatActiveModelLabel", () => {
  it("shows the configured task model as provider/id", () => {
    expect(formatActiveModelLabel({ taskModel: CONFIG_MODEL })).toBe("cfg-prov/cfg-model");
  });

  it("shows the session model (with id) when no taskModel is configured", () => {
    expect(formatActiveModelLabel({}, "session-model")).toBe("session model (session-model)");
  });

  it("shows a bare 'session model' when the session id is unknown", () => {
    expect(formatActiveModelLabel({})).toBe("session model");
  });
});
