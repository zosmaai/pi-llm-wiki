import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { registerWikiRebuildMeta } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

// Issue #77: heavy mutating tools dispatch to the background runtime and report
// on completion; with no runtime they fall back to a synchronous inline result.

interface CapturedTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

function captureRebuildTool(runtime?: Runtime): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool: (def: unknown) => {
      tool = def as CapturedTool;
    },
  } as unknown as ExtensionAPI;
  registerWikiRebuildMeta(pi, runtime);
  if (!tool) throw new Error("tool not registered");
  return tool;
}

describe("wiki_rebuild_meta background + report (issue #77)", () => {
  let tmpDir: string;
  let wikiDir: string;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `bg-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    wikiDir = join(tmpDir, "vault");
    mkdirSync(wikiDir, { recursive: true });
    const paths = getVaultPaths(wikiDir);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "T", mode: "personal" }),
    );
    writeFileSync(
      join(paths.wiki, "concepts", "alpha.md"),
      "---\ntype: concept\n---\n\n# Alpha\n\nSome content.\n",
    );
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("dispatches to the background and returns a non-blocking ack when a runtime is present", async () => {
    const runtime = new Runtime();
    const reported: string[] = [];
    runtime.report = (s: string) => reported.push(s);
    const launched: string[] = [];
    // Run work synchronously inline so we can assert the report deterministically.
    runtime.launchReported = async (_ctx, label, work) => {
      launched.push(label);
      const summary = await work();
      if (summary) runtime.report(summary);
    };

    const tool = captureRebuildTool(runtime);
    const res = await tool.execute("id", {}, undefined, undefined, {
      cwd: wikiDir,
      hasUI: true,
      ui: { notify: () => {} },
    } as unknown);

    expect(res.details.background).toBe(true);
    expect(res.content[0].text).toContain("background");
    expect(launched).toEqual([`rebuild_meta:${getVaultPaths(wikiDir).root}`]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("metadata rebuilt");
    // The rebuild actually ran: registry.json now exists.
    const reg = JSON.parse(
      readFileSync(join(getVaultPaths(wikiDir).meta, "registry.json"), "utf-8"),
    );
    expect(Object.keys(reg.pages).length).toBeGreaterThan(0);
  });

  it("runs synchronously inline when no runtime is provided (backward compatible)", async () => {
    const tool = captureRebuildTool(undefined);
    const res = await tool.execute("id", {}, undefined, undefined, {
      cwd: wikiDir,
      hasUI: false,
    } as unknown);
    expect(res.details.background).toBe(false);
    expect(res.content[0].text).toContain("metadata rebuilt");
  });
});
