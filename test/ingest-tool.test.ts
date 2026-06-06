import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { registerWikiIngest } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

interface CapturedTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

// Minimal harness: capture the tool definition registered via pi.registerTool.
function captureIngestTool(runtime?: Runtime): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool: (def: unknown) => {
      tool = def as CapturedTool;
    },
  } as unknown as ExtensionAPI;
  registerWikiIngest(pi, runtime);
  if (!tool) throw new Error("tool not registered");
  return tool;
}

function makeCtx(cwd: string) {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    notifications,
    ctx: {
      cwd,
      hasUI: true,
      ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
      model: { provider: "p", id: "m" },
      modelRegistry: {
        find: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
    } as unknown,
  };
}

describe("wiki_ingest background dispatch", () => {
  let tmpDir: string;
  let wikiDir: string;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `ingest-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    wikiDir = join(tmpDir, "vault");
    mkdirSync(wikiDir, { recursive: true });
    const paths = getVaultPaths(wikiDir);
    ensureVaultStructure(paths);
    // Mark this as a vault and add one capturable source packet.
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "T", mode: "personal" }),
    );
    const src = join(paths.rawSources, "SRC-001");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "extracted.md"), "# Some Paper\n\nContent about transformers.");
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ id: "SRC-001", title: "Some Paper" }),
    );
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("dispatches to the background and returns a non-blocking message when a model resolves", async () => {
    const runtime = new Runtime();
    const launched: string[] = [];
    // Stub resolveModel + launchTask so no real LLM call happens.
    runtime.resolveModel = async () => ({
      ok: true,
      model: { provider: "p", id: "m" },
      apiKey: "k",
    });
    runtime.launchTask = (_ctx, label, _work) => {
      launched.push(label);
      return Promise.resolve();
    };

    const tool = captureIngestTool(runtime);
    const { ctx } = makeCtx(wikiDir);
    const res = await tool.execute("id", { background: true }, undefined, undefined, ctx);

    expect(launched).toEqual(["ingest:SRC-001"]);
    expect(res.details.background).toBe(true);
    expect(res.details.dispatched).toEqual(["SRC-001"]);
    const text = res.content[0].text as string;
    expect(text).toContain("background");
    expect(text).not.toContain("extracted.md"); // not the synchronous path
  });

  it("falls back to the synchronous path when the model does not resolve", async () => {
    const runtime = new Runtime();
    runtime.resolveModel = async () => ({ ok: false, reason: "no API key" });

    const tool = captureIngestTool(runtime);
    const { ctx } = makeCtx(wikiDir);
    const res = await tool.execute("id", { background: true }, undefined, undefined, ctx);

    expect(res.details.background).toBeUndefined();
    const text = res.content[0].text as string;
    expect(text).toContain("Next steps");
    expect(text).toContain("extracted.md");
  });

  it("falls back to synchronous when background=false even if a model is available", async () => {
    const runtime = new Runtime();
    let launchedCount = 0;
    runtime.resolveModel = async () => ({
      ok: true,
      model: { provider: "p", id: "m" },
      apiKey: "k",
    });
    runtime.launchTask = () => {
      launchedCount++;
      return Promise.resolve();
    };

    const tool = captureIngestTool(runtime);
    const { ctx } = makeCtx(wikiDir);
    const res = await tool.execute("id", { background: false }, undefined, undefined, ctx);

    expect(launchedCount).toBe(0);
    expect(res.content[0].text as string).toContain("Next steps");
  });

  it("falls back to synchronous when no runtime is provided (backward compatible)", async () => {
    const tool = captureIngestTool(undefined);
    const { ctx } = makeCtx(wikiDir);
    const res = await tool.execute("id", { background: true }, undefined, undefined, ctx);
    expect(res.content[0].text as string).toContain("Next steps");
  });
});
