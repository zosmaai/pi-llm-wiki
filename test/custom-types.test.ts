import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWikiEnsurePage } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

interface Tool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    s: undefined,
    u: undefined,
    ctx: unknown,
  ) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
}

function capture(fn: (pi: ExtensionAPI) => void): Tool {
  let tool: Tool | undefined;
  const pi = {
    registerTool: (def: unknown) => {
      tool = def as Tool;
    },
  } as unknown as ExtensionAPI;
  fn(pi);
  if (!tool) throw new Error("tool not registered");
  return tool;
}

let wikiDir: string;

beforeEach(() => {
  wikiDir = join(
    import.meta.dirname,
    "..",
    "tmp",
    `ct-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const llm = join(wikiDir, ".llm-wiki");
  for (const d of ["wiki/entities", "wiki/concepts", "wiki/sources", "meta", "outputs"]) {
    mkdirSync(join(llm, d), { recursive: true });
  }
  writeFileSync(join(llm, "config.json"), JSON.stringify({ topic: "Test", mode: "personal" }));
  ensureVaultStructure(getVaultPaths(wikiDir));
  writeFileSync(
    join(llm, "meta", "registry.json"),
    JSON.stringify({ version: "1.0", last_updated: "", pages: {} }),
  );
});

afterEach(() => {
  try {
    rmSync(wikiDir, { recursive: true, force: true });
  } catch {}
});

function writeSettings(customTypes: Record<string, string>): void {
  const cfg = join(wikiDir, ".pi");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ "llm-wiki": { customTypes } }));
}

describe("wiki_ensure_page custom types", () => {
  it("creates a custom type in the correct folder", async () => {
    writeSettings({ decision: "decisions" });
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "decision", title: "Auth Architecture" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const expected = join(getVaultPaths(wikiDir).wiki, "decisions", "auth-architecture.md");
    expect(existsSync(expected)).toBe(true);
    expect(res.details.created).toBe(true);
  });

  it("built-in types still work alongside custom types", async () => {
    writeSettings({ decision: "decisions" });
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "entity", title: "Test Entity" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const expected = join(getVaultPaths(wikiDir).wiki, "entities", "test-entity.md");
    expect(existsSync(expected)).toBe(true);
  });

  it("custom type uses generic template when no content provided", async () => {
    writeSettings({ metric: "metrics" });
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "metric", title: "API Latency" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const file = join(getVaultPaths(wikiDir).wiki, "metrics", "api-latency.md");
    const body = readFileSync(file, "utf-8");
    expect(body).toContain("# API Latency");
    expect(body).toContain("## Links");
  });

  it("custom type with explicit content writes that content", async () => {
    writeSettings({ decision: "decisions" });
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "decision", title: "Use Postgres", content: "# Use Postgres\n\nWe chose Postgres." },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const file = join(getVaultPaths(wikiDir).wiki, "decisions", "use-postgres.md");
    const body = readFileSync(file, "utf-8");
    expect(body).toContain("We chose Postgres.");
  });

  it("undefined customTypes (no config) falls back to built-ins only", async () => {
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Test Concept" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const expected = join(getVaultPaths(wikiDir).wiki, "concepts", "test-concept.md");
    expect(existsSync(expected)).toBe(true);
  });

  it("unrecognized type without config falls back to concepts folder", async () => {
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "nonexistent", title: "Fallback Page" },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const expected = join(getVaultPaths(wikiDir).wiki, "concepts", "fallback-page.md");
    expect(existsSync(expected)).toBe(true);
  });
});
