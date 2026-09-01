import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTaskConfig, persistSetting } from "../extensions/llm-wiki/lib/task-config.js";

describe("synthesisMaxTokens config (issue #160)", () => {
  let tmpDir: string;
  let priorAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `smt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it("loadTaskConfig returns undefined when not set (caller uses default)", () => {
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.synthesisMaxTokens).toBeUndefined();
  });

  it("reads synthesisMaxTokens from project settings", () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { synthesisMaxTokens: 32768 } }),
    );
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBe(32768);
  });

  it("reads synthesisMaxTokens from global settings", () => {
    const agentDir = join(tmpDir, "agent-home");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ "llm-wiki": { synthesisMaxTokens: 8192 } }),
    );
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBe(8192);
  });

  it("project wins over global", () => {
    const agentDir = join(tmpDir, "agent-home");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ "llm-wiki": { synthesisMaxTokens: 8192 } }),
    );
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { synthesisMaxTokens: 32768 } }),
    );
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBe(32768);
  });

  it("rejects non-number values", () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { synthesisMaxTokens: "big" } }),
    );
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBeUndefined();
  });

  it("rejects negative values", () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { synthesisMaxTokens: -100 } }),
    );
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBeUndefined();
  });

  it("clamps to integer", () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { synthesisMaxTokens: 16384.7 } }),
    );
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBe(16384);
  });

  it("persistSetting writes to project scope", () => {
    persistSetting(tmpDir, "project", "synthesisMaxTokens", 32768);
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBe(32768);
  });

  it("persistSetting writes to global scope", () => {
    persistSetting(tmpDir, "global", "synthesisMaxTokens", 8192);
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBe(8192);
  });

  it("persistSetting with undefined removes the key", () => {
    persistSetting(tmpDir, "project", "synthesisMaxTokens", 32768);
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBe(32768);
    persistSetting(tmpDir, "project", "synthesisMaxTokens", undefined);
    expect(loadTaskConfig(tmpDir).synthesisMaxTokens).toBeUndefined();
  });

  it("persistSetting preserves other llm-wiki keys", () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { notices: false, semanticWeight: 0.7 } }),
    );
    persistSetting(tmpDir, "project", "synthesisMaxTokens", 16384);
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.synthesisMaxTokens).toBe(16384);
    expect(cfg.notices).toBe(false);
    expect(cfg.semanticWeight).toBe(0.7);
  });

  it("persistSetting preserves non-wiki top-level keys", () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ theme: "dark", "llm-wiki": { notices: true } }),
    );
    persistSetting(tmpDir, "project", "synthesisMaxTokens", 16384);
    const raw = JSON.parse(
      require("node:fs").readFileSync(join(tmpDir, ".pi", "settings.json"), "utf-8"),
    );
    expect(raw.theme).toBe("dark");
    expect(raw["llm-wiki"].synthesisMaxTokens).toBe(16384);
    expect(raw["llm-wiki"].notices).toBe(true);
  });
});
