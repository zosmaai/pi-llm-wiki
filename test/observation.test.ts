import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildMetadataLight } from "../extensions/llm-wiki/lib/metadata.js";
import { saveObservation } from "../extensions/llm-wiki/lib/observation.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

describe("wiki observation", () => {
  let tmpDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `observation-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vaultDir = (() => {
      const dir = join(tmpDir, `vault-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const llmWiki = join(dir, ".llm-wiki");
      const dirs = [
        "raw/articles",
        "raw/papers",
        "raw/notes",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/syntheses",
        "meta",
        "outputs",
        ".discoveries",
      ];
      for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });
      return dir;
    })();
    ensureVaultStructure(getVaultPaths(vaultDir));

    // Write config.json
    const dotWiki = join(vaultDir, ".llm-wiki");
    writeFileSync(
      join(dotWiki, "config.json"),
      JSON.stringify({
        topic: "Test Vault",
        mode: "personal",
        created: "2026-05-27",
        version: "1.0",
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should save an observation and create a page file", () => {
    const paths = getVaultPaths(vaultDir);
    const result = saveObservation(paths, {
      title: "JWT auth middleware added",
      content:
        "User decided to use JWT with refresh tokens. Implementation at src/auth/jwt.ts. Tests passing.",
      relevance: "high",
      tags: "auth jwt backend",
      source_context: "Adding authentication module",
    });

    expect(result.slug).toContain("obs-");
    expect(result.slug).toContain("jwt-auth-middleware-added");
    expect(existsSync(result.pagePath)).toBe(true);

    const content = readFileSync(result.pagePath, "utf-8");
    expect(content).toContain("Observation: JWT auth middleware added");
    expect(content).toContain("User decided to use JWT with refresh tokens");
    expect(content).toContain("relevance: high");
    expect(content).toContain('tags: ["auth", "jwt", "backend"]');
    expect(content).toContain('source_context: "Adding authentication module"');
  });

  it("should save an observation with default optional fields", () => {
    const paths = getVaultPaths(vaultDir);
    const result = saveObservation(paths, {
      title: "Quick fix applied",
      content: "Fixed the login timeout bug by increasing TTL.",
      relevance: "medium",
    });

    expect(existsSync(result.pagePath)).toBe(true);
    const content = readFileSync(result.pagePath, "utf-8");
    expect(content).toContain("relevance: medium");
    expect(content).not.toContain("tags:");
    expect(content).not.toContain("source_context:");
  });

  it("should save an observation with critical relevance", () => {
    const paths = getVaultPaths(vaultDir);
    const result = saveObservation(paths, {
      title: "User is colorblind",
      content: "User stated they are colorblind; red/green indicators do not work for them.",
      relevance: "critical",
    });

    const content = readFileSync(result.pagePath, "utf-8");
    expect(content).toContain("relevance: critical");
  });

  it("should make observations searchable via wiki_recall", () => {
    const paths = getVaultPaths(vaultDir);
    saveObservation(paths, {
      title: "Postgres migration constraint",
      content:
        "Migration from MySQL to Postgres: discovered that JSONB queries use different syntax.",
      relevance: "high",
      tags: "migration postgres database",
    });

    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "postgres migration");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title.includes("Postgres migration"))).toBe(true);
  });

  it("should search observation content in wiki_recall", () => {
    const paths = getVaultPaths(vaultDir);
    saveObservation(paths, {
      title: "Auth decision",
      content: "Team chose Lucia for session-based auth over NextAuth and Clerk.",
      relevance: "high",
      tags: "auth decision",
    });

    rebuildMetadataLight(paths);
    // Search for content-specific terms
    const results = searchWiki(paths, "Lucia session-based auth");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title.includes("Auth decision"))).toBe(true);
  });

  it("should handle multiple observations independently", () => {
    const paths = getVaultPaths(vaultDir);
    const obs1 = saveObservation(paths, {
      title: "First finding",
      content: "Found bug in login flow.",
      relevance: "high",
    });
    const obs2 = saveObservation(paths, {
      title: "Second finding",
      content: "Fixed the bug by adding validation.",
      relevance: "medium",
    });

    expect(obs1.slug).not.toBe(obs2.slug);
    expect(existsSync(obs1.pagePath)).toBe(true);
    expect(existsSync(obs2.pagePath)).toBe(true);

    const content1 = readFileSync(obs1.pagePath, "utf-8");
    const content2 = readFileSync(obs2.pagePath, "utf-8");
    expect(content1).toContain("First finding");
    expect(content2).toContain("Second finding");
  });

  it("should slugify titles correctly", () => {
    const paths = getVaultPaths(vaultDir);
    const result = saveObservation(paths, {
      title: "Complex/Edge Case: 100% Done!",
      content: "Edge case handling completed.",
      relevance: "low",
    });

    expect(result.slug).toContain("complex-edge-case-100-done");
    expect(result.slug).not.toContain("//");
    expect(result.slug).not.toContain("_");
  });
});
