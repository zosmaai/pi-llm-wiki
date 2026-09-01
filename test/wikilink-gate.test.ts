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
    `wg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const llm = join(wikiDir, ".llm-wiki");
  for (const d of ["wiki/entities", "wiki/concepts", "wiki/sources", "meta", "outputs"]) {
    mkdirSync(join(llm, d), { recursive: true });
  }
  // config.json is required — both tools call inspectWritableVault, which hard-blocks
  // on an absent/unreadable config (config_invalid_knowledge_format). Mirror retro.test.ts.
  writeFileSync(join(llm, "config.json"), JSON.stringify({ topic: "Test", mode: "personal" }));
  ensureVaultStructure(getVaultPaths(wikiDir));
  // Seed the registry with one resolvable target so [[transformer]] resolves and [[ghost]] does not.
  writeFileSync(
    join(llm, "meta", "registry.json"),
    JSON.stringify({
      version: "1.0",
      last_updated: "",
      pages: {
        "concepts/transformer": {
          id: "concepts/transformer",
          title: "Transformer",
          type: "concept",
        },
      },
    }),
  );
  // No .pi/settings.json here → default mode is "warn".
});

afterEach(() => {
  try {
    rmSync(wikiDir, { recursive: true, force: true }); // only this test's own root, never the shared test/tmp
  } catch {}
});

function setMode(mode: string): void {
  const cfg = join(wikiDir, ".pi");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    join(cfg, "settings.json"),
    JSON.stringify({ "llm-wiki": { wikilinkValidation: mode } }),
  );
}

describe("wiki_ensure_page wikilink gate", () => {
  const content = "see [[transformer]] and [[ghost]]";

  it("off → writes verbatim, no issues surfaced", async () => {
    setMode("off");
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Ghost Concept", content },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const file = join(getVaultPaths(wikiDir).wiki, "concepts", "ghost-concept.md");
    expect(existsSync(file)).toBe(true);
    expect(res.details.wikilinkIssues).toEqual([]);
  });

  it("warn → writes, reports the missing link (transformer resolves, not reported)", async () => {
    const tool = capture((pi) => registerWikiEnsurePage(pi)); // default warn
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Ghost Concept", content },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const issues = res.details.wikilinkIssues as string[];
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("ghost");
  });

  it("strict → rejects, writes nothing", async () => {
    setMode("strict");
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Ghost Concept", content },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBe(true);
    expect(res.details.error).toBe("link_validation");
    expect(existsSync(join(getVaultPaths(wikiDir).wiki, "concepts", "ghost-concept.md"))).toBe(
      false,
    );
  });

  it("normalize → rewrites resolvable link, reports the missing one", async () => {
    setMode("normalize");
    const tool = capture((pi) => registerWikiEnsurePage(pi));
    const res = await tool.execute(
      "t",
      { type: "concept", title: "Ghost Concept", content },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const file = join(getVaultPaths(wikiDir).wiki, "concepts", "ghost-concept.md");
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("[[concepts/transformer]]");
    expect(text).toContain("[[ghost]]");
  });
});

import { registerWikiRetro } from "../extensions/llm-wiki/lib/retro.js";

describe("wiki_retro wikilink gate", () => {
  const body = "Learned about [[transformer]] and [[ghost]]";

  it("warn (default) → saves, reports the missing link", async () => {
    const tool = capture((pi) => registerWikiRetro(pi));
    const res = await tool.execute(
      "t",
      { slug: "transformer-note", title: "Transformer Note", body },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const issues = res.details.wikilinkIssues as string[];
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("ghost");
    expect(existsSync(join(getVaultPaths(wikiDir).wiki, "sources", "transformer-note.md"))).toBe(
      true,
    );
  });

  it("strict → rejects, writes nothing", async () => {
    setMode("strict");
    const tool = capture((pi) => registerWikiRetro(pi));
    const res = await tool.execute(
      "t",
      { slug: "transformer-note", title: "Transformer Note", body },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBe(true);
    expect(res.details.error).toBe("link_validation");
    expect(existsSync(join(getVaultPaths(wikiDir).wiki, "sources", "transformer-note.md"))).toBe(
      false,
    );
  });

  it("normalize → saves with the resolvable link rewritten", async () => {
    setMode("normalize");
    const tool = capture((pi) => registerWikiRetro(pi));
    const res = await tool.execute(
      "t",
      { slug: "transformer-note", title: "Transformer Note", body },
      undefined,
      undefined,
      { cwd: wikiDir, hasUI: false },
    );
    expect(res.isError).toBeFalsy();
    const text = readFileSync(
      join(getVaultPaths(wikiDir).wiki, "sources", "transformer-note.md"),
      "utf-8",
    );
    expect(text).toContain("[[concepts/transformer]]");
    expect(text).toContain("[[ghost]]");
  });
});
