import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReminderText, buildSessionNotice } from "../extensions/llm-wiki/lib/observation.js";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { loadTaskConfig, noticesEnabled } from "../extensions/llm-wiki/lib/task-config.js";

// Issue #77: make wiki activity visible (recall status, observe/retro reminder,
// session notice) and route mutating actions through background + report.

describe("noticesEnabled (issue #77)", () => {
  it("defaults to true when unset", () => {
    expect(noticesEnabled(undefined)).toBe(true);
    expect(noticesEnabled({})).toBe(true);
  });

  it("honors an explicit boolean", () => {
    expect(noticesEnabled({ notices: false })).toBe(false);
    expect(noticesEnabled({ notices: true })).toBe(true);
  });
});

describe("loadTaskConfig parses notices", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `notices-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("reads notices:false from project settings", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { notices: false } }),
    );
    expect(loadTaskConfig(tmpDir).notices).toBe(false);
    expect(noticesEnabled(loadTaskConfig(tmpDir))).toBe(false);
  });

  it("ignores a non-boolean notices value", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { notices: "yes" } }),
    );
    expect(loadTaskConfig(tmpDir).notices).toBeUndefined();
  });
});

describe("visible guidance text", () => {
  it("reminder mentions BOTH capture tools", () => {
    const t = buildReminderText();
    expect(t).toContain("wiki_observe");
    expect(t).toContain("wiki_retro");
  });

  it("session notice announces the full loop (recall -> search -> read -> observe -> retro)", () => {
    const n = buildSessionNotice();
    expect(n).toContain("recall");
    expect(n).toContain("wiki_search");
    expect(n).toContain("read");
    expect(n).toContain("wiki_observe");
    expect(n).toContain("wiki_retro");
    // documents the opt-out
    expect(n).toContain("notices");
  });
});

interface SentMessage {
  msg: { customType: string; content: string; display: boolean };
}

function fakePi(): { pi: ExtensionAPI; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const pi = {
    sendMessage: (msg: SentMessage["msg"]) => {
      sent.push({ msg });
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

describe("Runtime.report (issue #77)", () => {
  it("no-ops when no pi is attached", () => {
    const rt = new Runtime();
    expect(() => rt.report("hello")).not.toThrow();
  });

  it("emits a visible message when notices are enabled (default)", () => {
    const rt = new Runtime();
    const { pi, sent } = fakePi();
    rt.pi = pi;
    rt.report("done");
    expect(sent).toHaveLength(1);
    expect(sent[0].msg.customType).toBe("wiki-action-report");
    expect(sent[0].msg.content).toBe("done");
    expect(sent[0].msg.display).toBe(true);
  });

  it("injects silently (display:false) when notices are disabled", () => {
    const rt = new Runtime();
    rt.config = { notices: false };
    const { pi, sent } = fakePi();
    rt.pi = pi;
    rt.report("quiet");
    expect(sent[0].msg.display).toBe(false);
  });

  it("never throws if sendMessage throws", () => {
    const rt = new Runtime();
    rt.pi = {
      sendMessage: () => {
        throw new Error("torn down");
      },
    } as unknown as ExtensionAPI;
    expect(() => rt.report("boom")).not.toThrow();
  });

  it("skips empty summaries", () => {
    const rt = new Runtime();
    const { pi, sent } = fakePi();
    rt.pi = pi;
    rt.report("");
    expect(sent).toHaveLength(0);
  });
});

describe("Runtime.launchReported (issue #77)", () => {
  it("runs the work and reports its returned summary", async () => {
    const rt = new Runtime();
    const { pi, sent } = fakePi();
    rt.pi = pi;
    let ran = false;
    await rt.launchReported({ hasUI: false }, "label-a", async () => {
      ran = true;
      return "✅ work complete";
    });
    expect(ran).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg.content).toBe("✅ work complete");
  });

  it("does not report when work returns null", async () => {
    const rt = new Runtime();
    const { pi, sent } = fakePi();
    rt.pi = pi;
    await rt.launchReported({ hasUI: false }, "label-b", async () => null);
    expect(sent).toHaveLength(0);
  });
});

// Sanity: the vault structure helper is unrelated, but assert the new test file
// does not accidentally create a vault in cwd.
describe("no side effects", () => {
  it("does not create a vault in the repo root", () => {
    expect(existsSync(join(import.meta.dirname, "..", ".llm-wiki"))).toBe(false);
  });
});
