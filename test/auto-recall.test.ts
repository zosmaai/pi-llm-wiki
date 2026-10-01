import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoRecallEnabled, loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";

// Issue #262: opt out of automatic before_agent_start recall while keeping the
// wiki_recall tool, MCP tools, and /wiki-* commands available for explicit use.

describe("autoRecallEnabled (issue #262)", () => {
  it("defaults to true when unset", () => {
    expect(autoRecallEnabled(undefined)).toBe(true);
    expect(autoRecallEnabled({})).toBe(true);
  });

  it("honors an explicit boolean", () => {
    expect(autoRecallEnabled({ autoRecall: false })).toBe(false);
    expect(autoRecallEnabled({ autoRecall: true })).toBe(true);
  });
});

describe("loadTaskConfig parses autoRecall", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `auto-recall-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("reads autoRecall:false from project settings", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { autoRecall: false } }),
    );
    expect(loadTaskConfig(tmpDir).autoRecall).toBe(false);
    expect(autoRecallEnabled(loadTaskConfig(tmpDir))).toBe(false);
  });

  it("defaults to enabled when the key is absent", () => {
    expect(loadTaskConfig(tmpDir).autoRecall).toBeUndefined();
    expect(autoRecallEnabled(loadTaskConfig(tmpDir))).toBe(true);
  });

  it("ignores a non-boolean autoRecall value", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { autoRecall: "off" } }),
    );
    expect(loadTaskConfig(tmpDir).autoRecall).toBeUndefined();
    expect(autoRecallEnabled(loadTaskConfig(tmpDir))).toBe(true);
  });
});
