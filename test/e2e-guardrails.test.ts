/**
 * E2E guardrail verification — PR #52 checklist item (Step 4).
 *
 * Tests `isProtectedPath()` (the pure function that drives the tool_call hook
 * in guardrails.ts) directly — no live pi session required.
 *
 * Covers every class of path the hook must block or allow:
 *   BLOCK  .llm-wiki/raw/**          (immutable source artifacts)
 *   BLOCK  .llm-wiki/meta/**         (auto-generated metadata)
 *   ALLOW  .llm-wiki/wiki/**         (editable knowledge pages)
 *   ALLOW  anything outside the vault
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProtectedPath } from "../extensions/llm-wiki/lib/utils.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const tmpDir = join(import.meta.dirname, "..", "tmp", `e2e-guardrails-${Date.now()}`);

beforeAll(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function makePaths() {
  const root = join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`);
  const p = getVaultPaths(root);
  ensureVaultStructure(p);
  return p;
}

describe("E2E — Guardrails: isProtectedPath blocks raw/** and meta/**", () => {
  it("blocks a write to raw/sources/SRC-*/extracted.md", () => {
    const paths = makePaths();
    const target = join(paths.rawSources, "SRC-2026-06-03-001", "extracted.md");

    const result = isProtectedPath(target, paths);

    console.log(`\nraw/sources/SRC-*/extracted.md → protected=${result.protected}`);
    console.log(`reason: ${result.reason}`);

    expect(result.protected).toBe(true);
    expect(result.reason).toContain("Raw sources are immutable");
    console.log("✅ raw source write blocked\n");
  });

  it("blocks a write to raw/sources/SRC-*/manifest.json", () => {
    const paths = makePaths();
    const target = join(paths.rawSources, "SRC-2026-06-03-001", "manifest.json");

    const result = isProtectedPath(target, paths);

    expect(result.protected).toBe(true);
    expect(result.reason).toContain("Raw sources are immutable");
    console.log("✅ raw manifest write blocked\n");
  });

  it("blocks a write to raw/sources/SRC-*/original/report.docx", () => {
    const paths = makePaths();
    const target = join(paths.rawSources, "SRC-2026-06-03-001", "original", "report.docx");

    const result = isProtectedPath(target, paths);

    expect(result.protected).toBe(true);
    expect(result.reason).toContain("Raw sources are immutable");
    console.log("✅ raw original artifact write blocked\n");
  });

  it("blocks a write to meta/registry.json", () => {
    const paths = makePaths();
    const target = join(paths.meta, "registry.json");

    const result = isProtectedPath(target, paths);

    console.log(`\nmeta/registry.json → protected=${result.protected}`);
    console.log(`reason: ${result.reason}`);

    expect(result.protected).toBe(true);
    expect(result.reason).toContain("Metadata is auto-generated");
    console.log("✅ meta/registry.json write blocked\n");
  });

  it("blocks a write to meta/backlinks.json", () => {
    const paths = makePaths();
    const target = join(paths.meta, "backlinks.json");

    const result = isProtectedPath(target, paths);

    expect(result.protected).toBe(true);
    expect(result.reason).toContain("Metadata is auto-generated");
    console.log("✅ meta/backlinks.json write blocked\n");
  });

  it("blocks a write to meta/events.jsonl", () => {
    const paths = makePaths();
    const target = join(paths.meta, "events.jsonl");

    const result = isProtectedPath(target, paths);

    expect(result.protected).toBe(true);
    expect(result.reason).toContain("Metadata is auto-generated");
    console.log("✅ meta/events.jsonl write blocked\n");
  });

  it("ALLOWS a write to wiki/concepts/retrieval-augmented-generation.md", () => {
    const paths = makePaths();
    const target = join(paths.wiki, "concepts", "retrieval-augmented-generation.md");

    const result = isProtectedPath(target, paths);

    console.log(`\nwiki/concepts/*.md → protected=${result.protected}`);

    expect(result.protected).toBe(false);
    console.log("✅ wiki/concepts write allowed\n");
  });

  it("ALLOWS a write to wiki/sources/SRC-2026-06-03-001.md (source page, not raw packet)", () => {
    const paths = makePaths();
    const target = join(paths.wiki, "sources", "SRC-2026-06-03-001.md");

    const result = isProtectedPath(target, paths);

    expect(result.protected).toBe(false);
    console.log("✅ wiki/sources page write allowed\n");
  });

  it("ALLOWS a write to wiki/entities/openai.md", () => {
    const paths = makePaths();
    const target = join(paths.wiki, "entities", "openai.md");

    const result = isProtectedPath(target, paths);

    expect(result.protected).toBe(false);
    console.log("✅ wiki/entities write allowed\n");
  });

  it("ALLOWS a write to a file outside the vault entirely", () => {
    const paths = makePaths();
    const target = "/tmp/some-random-file.md";

    const result = isProtectedPath(target, paths);

    expect(result.protected).toBe(false);
    console.log("✅ path outside vault allowed\n");
  });
});
