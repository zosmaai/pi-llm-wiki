import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { retroOperation } from "../mcp/operations.js";

let tmpDir: string;
let paths: ReturnType<typeof getVaultPaths>;

beforeEach(() => {
  tmpDir = join(import.meta.dirname, "..", "tmp", `mcp-gate-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  paths = getVaultPaths(tmpDir);
  ensureVaultStructure(paths);
  writeFileSync(
    join(paths.dotWiki, "config.json"),
    JSON.stringify({ topic: "Test", mode: "personal", knowledge_format: "legacy" }),
  );
  // Seed the registry with one resolvable target so [[transformer]] resolves and [[ghost]] does not.
  writeFileSync(
    join(paths.meta, "registry.json"),
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
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true }); // only this test's own root
  } catch {}
});

describe("retroOperation wikilink gate", () => {
  const body = "Learned about [[transformer]] and [[ghost]]";
  const pagePath = () => join(paths.wiki, "sources", "mcp-gate-note.md");

  it("default (warn) → saves, does not fail", async () => {
    const res = await retroOperation(paths, "mcp-gate-note", "MCP Gate Note", body);
    expect(res.ok).toBe(true);
    expect(existsSync(pagePath())).toBe(true);
  });

  it("off → saves verbatim", async () => {
    const res = await retroOperation(paths, "mcp-gate-note", "MCP Gate Note", body, "test", "off");
    expect(res.ok).toBe(true);
    expect(existsSync(pagePath())).toBe(true);
  });

  it("strict → rejects with link_validation, writes nothing", async () => {
    const res = await retroOperation(
      paths,
      "mcp-gate-note",
      "MCP Gate Note",
      body,
      "test",
      "strict",
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "link_validation")).toBe(true);
    expect(existsSync(pagePath())).toBe(false);
  });

  it("normalize → saves with the resolvable link rewritten", async () => {
    const res = await retroOperation(
      paths,
      "mcp-gate-note",
      "MCP Gate Note",
      body,
      "test",
      "normalize",
    );
    expect(res.ok).toBe(true);
    const text = existsSync(pagePath()) ? readFileSync(pagePath(), "utf-8") : "";
    expect(text).toContain("[[concepts/transformer]]");
    expect(text).toContain("[[ghost]]");
  });
});
