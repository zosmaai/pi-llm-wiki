import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWikiRetro, saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { retroOperation } from "../mcp/operations.js";
import { readFile } from "./helpers.js";

type TestTool = {
  execute: (...args: unknown[]) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
};
describe("wiki retro", () => {
  let wikiDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `retro-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    wikiDir = (() => {
      const dir = join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const llmWiki = join(dir, ".llm-wiki");
      const dirs = [
        "raw/articles",
        "raw/papers",
        "raw/notes",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/syntheses",
        "wiki/changes",
        "meta",
        "outputs",
        ".discoveries",
      ];
      for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });
      return dir;
    })();
    const paths = getVaultPaths(wikiDir);
    ensureVaultStructure(paths);
    const dotWiki = join(paths.dotWiki);
    mkdirSync(dotWiki, { recursive: true });
    writeFileSync(
      join(dotWiki, "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal" }),
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it.each(["../../../outside", "../../meta/pwn", "with/slash", ".", "Index", "LOG"])(
    "rejects unsafe slug %s without writing",
    (slug) => {
      const paths = getVaultPaths(wikiDir);
      expect(() => saveInsight(paths, slug, "Title", "Body")).toThrow("Invalid insight slug");
      expect(existsSync(join(paths.root, "outside.md"))).toBe(false);
      expect(existsSync(join(paths.meta, "pwn.md"))).toBe(false);
    },
  );

  it("maps unsafe retro slugs to structured Pi and MCP errors", async () => {
    const paths = getVaultPaths(wikiDir);
    let tool: TestTool | undefined;
    registerWikiRetro({
      registerTool: (definition: unknown) => {
        tool = definition as TestTool;
      },
    } as unknown as ExtensionAPI);
    if (!tool) throw new Error("wiki_retro was not registered");

    const piResult = await tool.execute(
      "test",
      { slug: "../../escape", title: "Title", body: "Body" },
      undefined,
      undefined,
      { cwd: paths.root, hasUI: false },
    );
    expect(piResult.isError).toBe(true);
    expect(piResult.details.error).toBe("invalid_insight_slug");

    const mcpResult = await retroOperation(paths, "../../escape", "Title", "Body");
    expect(mcpResult).toEqual({
      ok: false,
      diagnostics: [
        { code: "invalid_insight_slug", message: "Invalid insight slug: ../../escape" },
      ],
    });
    expect(existsSync(join(paths.root, "escape.md"))).toBe(false);
    expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
  });

  it("should save an insight as a single lightweight markdown file", async () => {
    const { saveInsight } = await import("../extensions/llm-wiki/lib/retro.js");
    const paths = getVaultPaths(wikiDir);
    const result = saveInsight(
      paths,
      "test-pattern",
      "Test Pattern",
      "This is a test insight.",
      "devops",
    );
    // Returns slug and page path (no raw source packet)
    expect(result.slug).toBe("test-pattern");
    expect(result.sourcePagePath).toContain(".llm-wiki/wiki/sources/");
    expect(result.sourcePagePath).toContain("test-pattern.md");
    // Should NOT create raw source packet (lightweight mode)
    expect(existsSync(join(paths.rawSources))).toBe(true);
    // Source page should exist with proper frontmatter
    expect(existsSync(result.sourcePagePath)).toBe(true);
    const sourcePage = readFile(result.sourcePagePath);
    expect(sourcePage).toContain("type: source");
    expect(sourcePage).toContain("title: Test Pattern");
    expect(sourcePage).toContain("slug: test-pattern");
    expect(sourcePage).toContain("status: insight");
    expect(sourcePage).toContain("This is a test insight.");
    expect(sourcePage).toContain("category: devops");
    expect(sourcePage).toContain("## Related");
    expect(sourcePage).toContain("_Add links to related pages._");
    expect(sourcePage).not.toContain("[[wikilinks]]");
  });

  it("should save an insight without a category", async () => {
    const { saveInsight } = await import("../extensions/llm-wiki/lib/retro.js");
    const paths = getVaultPaths(wikiDir);
    const result = saveInsight(paths, "simple-note", "Simple Note", "Just a note.");
    expect(result.slug).toBe("simple-note");
    expect(existsSync(result.sourcePagePath)).toBe(true);
    const sourcePage = readFile(result.sourcePagePath);
    expect(sourcePage).not.toContain("category:");
  });

  it("should support multiple retros with unique slugs", async () => {
    const { saveInsight } = await import("../extensions/llm-wiki/lib/retro.js");
    const paths = getVaultPaths(wikiDir);
    const r1 = saveInsight(paths, "insight-one", "One", "First insight.");
    const r2 = saveInsight(paths, "insight-two", "Two", "Second insight.");
    expect(r1.slug).toBe("insight-one");
    expect(r2.slug).toBe("insight-two");
    expect(existsSync(r1.sourcePagePath)).toBe(true);
    expect(existsSync(r2.sourcePagePath)).toBe(true);
    expect(r1.sourcePagePath).not.toBe(r2.sourcePagePath);
  });

  it("should rebuild metadata after saving an insight", async () => {
    const { saveInsight } = await import("../extensions/llm-wiki/lib/retro.js");
    const paths = getVaultPaths(wikiDir);
    saveInsight(paths, "meta-test", "Meta Test", "Checking metadata.");
    const registry = JSON.parse(readFile(join(paths.meta, "registry.json")));
    const sourcePageId = Object.keys(registry.pages).find((id) =>
      id.startsWith("sources/meta-test"),
    );
    expect(sourcePageId).toBeTruthy();
    expect(registry.pages[sourcePageId!].title).toBe("Meta Test");
  });
});
