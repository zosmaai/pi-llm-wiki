import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerWikiReindex } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { reindexWiki } from "../extensions/llm-wiki/lib/wiki-service.js";

const roots: string[] = [];
const originalWikiHome = process.env.WIKI_HOME;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: restore an originally absent variable
  if (originalWikiHome === undefined) delete process.env.WIKI_HOME;
  else process.env.WIKI_HOME = originalWikiHome;
});

function tempVault(): ReturnType<typeof getVaultPaths> {
  const root = mkdtempSync(join(tmpdir(), "pi-llm-wiki-reindex-tool-"));
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ topic: "Reindex" }));
  return paths;
}

function writePage(paths: ReturnType<typeof getVaultPaths>, rel: string, title: string): void {
  const dir = join(paths.wiki, rel.split("/").slice(0, -1).join("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(paths.wiki, rel),
    `---
type: concept
title: ${title}
created: 2026-08-09
---

# ${title}

Body for ${title}.
`,
  );
}

function registerTool() {
  let captured: { name: string; execute: (...args: unknown[]) => Promise<unknown> } | undefined;
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  registerWikiReindex(pi);
  return captured!;
}

describe("wiki_reindex tool", () => {
  it("registers with the wiki_reindex name and validates schema-based params", async () => {
    const tool = registerTool();
    expect(tool.name).toBe("wiki_reindex");

    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const onUpdate = () => {};
    const ctx = { cwd: paths.root, hasUI: false, ui: {} };

    const result = (await tool.execute(
      "id",
      { scope: "changed", components: ["lexical"], force: false, vault: "active" },
      new AbortController().signal,
      onUpdate,
      ctx,
    )) as { isError?: boolean; details: Record<string, unknown>; content: { text: string }[] };

    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({
      scope: "changed",
      components: ["lexical"],
      vault: "active",
    });
    expect(result.content[0].text).toContain("QMD indexing complete");
    expect(existsSync(join(paths.meta, "qmd", "current", "index.sqlite"))).toBe(true);
  });

  it("cancels cleanly before any work when aborted", async () => {
    const tool = registerTool();
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const controller = new AbortController();
    controller.abort();
    const result = (await tool.execute(
      "id",
      { scope: "changed", components: ["lexical"], force: false, vault: "active" },
      controller.signal,
      () => {},
      { cwd: paths.root, hasUI: false, ui: {} },
    )) as { isError?: boolean; details: Record<string, unknown>; content: { text: string }[] };
    expect(result.isError).toBe(true);
  });

  it("returns an error for a vault that is not writable", async () => {
    const tool = registerTool();
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    // Break the config so the vault is not writable.
    writeFileSync(join(paths.dotWiki, "config.json"), "{broken");
    const result = (await tool.execute(
      "id",
      { scope: "changed", components: ["lexical"], force: false, vault: "active" },
      new AbortController().signal,
      () => {},
      { cwd: paths.root, hasUI: false, ui: {} },
    )) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
  });
});

describe("wiki_reindex vault selection", () => {
  it("active processes only the resolved active vault", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const result = await reindexWiki(paths, {
      scope: "changed",
      components: ["lexical"],
      vault: "active",
    });
    expect(result.vault).toBe("active");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].root).toBe(paths.root);
    expect(result.results[0].result.ok).toBe(true);
  });

  it("project processes only active non-personal vaults", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const result = await reindexWiki(paths, {
      scope: "changed",
      components: ["lexical"],
      vault: "project",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].label).toBe("project");
    expect(result.results[0].root).toBe(paths.root);
  });

  it("all deduplicates identical roots and reports each independently", async () => {
    // Sandbox personal vault under WIKI_HOME.
    const personalHome = mkdtempSync(join(tmpdir(), "pi-llm-wiki-personal-"));
    roots.push(personalHome);
    process.env.WIKI_HOME = personalHome;
    const personal = getVaultPaths(personalHome);
    ensureVaultStructure(personal);
    writeFileSync(join(personal.dotWiki, "config.json"), JSON.stringify({ topic: "Personal" }));
    writePage(personal, "concepts/note.md", "Note");

    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const result = await reindexWiki(paths, {
      scope: "changed",
      components: ["lexical"],
      vault: "all",
    });
    // project (active) + personal are distinct roots -> 2 results.
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    const rootsSeen = new Set(result.results.map((r) => r.root));
    expect(rootsSeen.size).toBe(result.results.length);
    for (const r of result.results) {
      expect(r.result.ok).toBe(true);
    }
  });

  it("a failing vault does not prevent the other from being returned", async () => {
    const personalHome = mkdtempSync(join(tmpdir(), "pi-llm-wiki-personal-"));
    roots.push(personalHome);
    process.env.WIKI_HOME = personalHome;
    const personal = getVaultPaths(personalHome);
    ensureVaultStructure(personal);
    writeFileSync(join(personal.dotWiki, "config.json"), JSON.stringify({ topic: "Personal" }));
    writePage(personal, "concepts/note.md", "Note");

    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    // Break only the active vault's config so it fails validation.
    writeFileSync(join(paths.dotWiki, "config.json"), "{broken");
    const result = await reindexWiki(paths, {
      scope: "changed",
      components: ["lexical"],
      vault: "all",
    });
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    const projectResult = result.results.find((r) => r.label === "project");
    const personalResult = result.results.find((r) => r.label === "personal");
    expect(projectResult?.result.ok).toBe(false);
    expect(personalResult?.result.ok).toBe(true);
  });
});
