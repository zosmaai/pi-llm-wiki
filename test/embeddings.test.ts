import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EmbeddingStore,
  buildEmbeddingText,
  contentHash,
  cosineSimilarity,
  embedPages,
  embeddingStorePath,
  isStale,
  normalizeVector,
  readEmbeddingStore,
  reindexEmbeddings,
  resolveEmbedder,
} from "../extensions/llm-wiki/lib/embeddings.js";
import { rebuildMetadataLight } from "../extensions/llm-wiki/lib/metadata.js";
import type { TaskConfig } from "../extensions/llm-wiki/lib/task-config.js";
import {
  type VaultPaths,
  ensureVaultStructure,
  getVaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

// ── deterministic mock embedder (NO network) ──────────────
// Produces a stable pseudo-vector from the text so identical text → identical
// vector, and we can assert call counts.
function makeMockEmbedder(model = "mock-embed") {
  const calls: string[][] = [];
  const embed = async (texts: string[]): Promise<number[][]> => {
    calls.push(texts);
    return texts.map((t) => {
      // 8-dim vector seeded by char codes — deterministic, non-zero.
      const v = new Array(8).fill(0);
      for (let i = 0; i < t.length; i++) {
        v[i % 8] += (t.charCodeAt(i) % 13) + 1;
      }
      return v;
    });
  };
  return { embedder: { model, embed }, calls };
}

function writePage(paths: VaultPaths, rel: string, body: string): void {
  const full = join(paths.wiki, `${rel}.md`);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf-8");
}

// ── vector math ───────────────────────────────────────────
describe("vector math", () => {
  it("normalizeVector returns a unit vector", () => {
    const n = normalizeVector([3, 4]);
    expect(Math.hypot(n[0], n[1])).toBeCloseTo(1, 10);
    expect(n).toEqual([0.6, 0.8]);
  });

  it("normalizeVector handles a zero vector without NaN", () => {
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("cosineSimilarity is 1 for identical, ~0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("cosineSimilarity returns 0 on dimension mismatch", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

// ── embedding text + hash ─────────────────────────────────
describe("buildEmbeddingText", () => {
  it("front-loads title + metadata, then body", () => {
    const text = buildEmbeddingText(
      "concepts/rag",
      { title: "RAG", type: "concept", tags: ["ai", "search"] },
      "Retrieval augmented generation.",
    );
    expect(text).toContain("title: RAG");
    expect(text).toContain("type: concept");
    expect(text).toContain("tags: ai, search");
    expect(text).toContain("Retrieval augmented generation.");
  });

  it("falls back to the id when no title is present", () => {
    expect(buildEmbeddingText("entities/x", {}, "body")).toContain("title: entities/x");
  });
});

// ── store + staleness ─────────────────────────────────────
describe("embedding store + staleness", () => {
  let tmpDir: string;
  let paths: VaultPaths;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `embed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    paths = getVaultPaths(join(tmpDir, "vault"));
    ensureVaultStructure(paths);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("embeds a page on write and stores a normalized vector keyed by id + hash", async () => {
    writePage(paths, "concepts/rag", "---\ntype: concept\ntitle: RAG\n---\n\nRetrieval.");
    const { embedder, calls } = makeMockEmbedder();

    const stats = await embedPages(paths, ["concepts/rag"], embedder);
    expect(stats).toEqual({ embedded: 1, skipped: 0, total: 1 });
    expect(calls).toHaveLength(1);

    const store = readEmbeddingStore(paths);
    const entry = store.entries["concepts/rag"];
    expect(entry).toBeDefined();
    expect(entry.model).toBe("mock-embed");
    expect(entry.dim).toBe(8);
    // Vector is normalized.
    expect(Math.hypot(...entry.vector)).toBeCloseTo(1, 8);
    // Hash matches the embedded text.
    const { frontmatter, body } = {
      frontmatter: { type: "concept", title: "RAG" },
      body: "Retrieval.",
    };
    expect(entry.hash).toBe(contentHash(buildEmbeddingText("concepts/rag", frontmatter, body)));
  });

  it("skips a fresh page (same content hash) on re-embed", async () => {
    writePage(paths, "concepts/rag", "---\ntype: concept\ntitle: RAG\n---\n\nRetrieval.");
    const { embedder, calls } = makeMockEmbedder();

    await embedPages(paths, ["concepts/rag"], embedder);
    const stats2 = await embedPages(paths, ["concepts/rag"], embedder);

    expect(stats2).toEqual({ embedded: 0, skipped: 1, total: 1 });
    expect(calls).toHaveLength(1); // no second network call
  });

  it("re-embeds when content changes (stale by hash)", async () => {
    writePage(paths, "concepts/rag", "---\ntype: concept\ntitle: RAG\n---\n\nRetrieval.");
    const { embedder, calls } = makeMockEmbedder();
    await embedPages(paths, ["concepts/rag"], embedder);

    writePage(paths, "concepts/rag", "---\ntype: concept\ntitle: RAG\n---\n\nChanged body!");
    const stats = await embedPages(paths, ["concepts/rag"], embedder);

    expect(stats.embedded).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("re-embeds when the model changes even if hash matches", async () => {
    writePage(paths, "concepts/rag", "---\ntype: concept\ntitle: RAG\n---\n\nRetrieval.");
    await embedPages(paths, ["concepts/rag"], makeMockEmbedder("model-a").embedder);
    const stats = await embedPages(paths, ["concepts/rag"], makeMockEmbedder("model-b").embedder);
    expect(stats.embedded).toBe(1);
  });

  it("force re-embeds even fresh pages", async () => {
    writePage(paths, "concepts/rag", "---\ntype: concept\ntitle: RAG\n---\n\nRetrieval.");
    const { embedder } = makeMockEmbedder();
    await embedPages(paths, ["concepts/rag"], embedder);
    const stats = await embedPages(paths, ["concepts/rag"], embedder, { force: true });
    expect(stats.embedded).toBe(1);
  });

  it("isStale: missing entry, changed hash, changed model", () => {
    const store: EmbeddingStore = {
      version: "1.0",
      entries: {
        "a/b": { hash: "h1", model: "m1", dim: 2, vector: [1, 0], updated: "t" },
      },
    };
    expect(isStale(store, "a/b", "h1", "m1")).toBe(false);
    expect(isStale(store, "a/b", "h2", "m1")).toBe(true);
    expect(isStale(store, "a/b", "h1", "m2")).toBe(true);
    expect(isStale(store, "missing", "h1", "m1")).toBe(true);
  });

  it("ignores ids with no backing file", async () => {
    const { embedder, calls } = makeMockEmbedder();
    const stats = await embedPages(paths, ["concepts/ghost"], embedder);
    expect(stats).toEqual({ embedded: 0, skipped: 0, total: 1 });
    expect(calls).toHaveLength(0);
  });
});

// ── backfill / reindex ────────────────────────────────────
describe("reindexEmbeddings (backfill)", () => {
  let tmpDir: string;
  let paths: VaultPaths;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `reindex-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    paths = getVaultPaths(join(tmpDir, "vault"));
    ensureVaultStructure(paths);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("embeds an existing vault end-to-end and prunes deleted pages", async () => {
    writePage(paths, "concepts/rag", "---\ntype: concept\ntitle: RAG\n---\n\nRetrieval.");
    writePage(paths, "entities/openai", "---\ntype: entity\ntitle: OpenAI\n---\n\nLab.");
    rebuildMetadataLight(paths);

    const { embedder } = makeMockEmbedder();
    const stats = await reindexEmbeddings(paths, embedder);
    expect(stats.embedded).toBe(2);
    expect(stats.pruned).toBe(0);

    const store = readEmbeddingStore(paths);
    expect(Object.keys(store.entries).sort()).toEqual(["concepts/rag", "entities/openai"]);

    // Second pass: all fresh.
    const stats2 = await reindexEmbeddings(paths, embedder);
    expect(stats2.embedded).toBe(0);
    expect(stats2.skipped).toBe(2);

    // Delete a page + rebuild registry → pruned on reindex.
    rmSync(join(paths.wiki, "entities", "openai.md"));
    rebuildMetadataLight(paths);
    const stats3 = await reindexEmbeddings(paths, embedder);
    expect(stats3.pruned).toBe(1);
    expect(readEmbeddingStore(paths).entries["entities/openai"]).toBeUndefined();
  });
});

// ── provider resolution / no-op default ───────────────────
describe("resolveEmbedder", () => {
  const ENV_KEY = "LLM_WIKI_TEST_EMBED_KEY";
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    prev[ENV_KEY] = process.env[ENV_KEY];
    prev.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    delete process.env[ENV_KEY];
    // biome-ignore lint/performance/noDelete: delete truly unsets the env var (assigning undefined coerces to "undefined")
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    for (const k of [ENV_KEY, "OPENAI_API_KEY"]) {
      if (prev[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev[k];
      }
    }
  });

  it("returns undefined when no provider is configured (default no-op)", () => {
    expect(resolveEmbedder({})).toBeUndefined();
  });

  it("returns undefined for an unsupported provider", () => {
    const cfg: TaskConfig = { embeddingProvider: "cohere", embeddingApiKey: "k" };
    expect(resolveEmbedder(cfg)).toBeUndefined();
  });

  it("returns undefined when provider is set but no key resolves", () => {
    expect(resolveEmbedder({ embeddingProvider: "openai" })).toBeUndefined();
  });

  it("does NOT auto-enable from an ambient OPENAI_API_KEY alone", () => {
    process.env.OPENAI_API_KEY = "ambient";
    expect(resolveEmbedder({})).toBeUndefined();
  });

  it("resolves an embedder from an explicit provider + inline key", () => {
    const cfg: TaskConfig = {
      embeddingProvider: "openai",
      embeddingApiKey: "sk-test",
      embeddingModel: "text-embedding-3-large",
    };
    const e = resolveEmbedder(cfg);
    expect(e).toBeDefined();
    expect(e?.model).toBe("text-embedding-3-large");
  });

  it("resolves the key from a configured env var name", () => {
    process.env[ENV_KEY] = "sk-from-env";
    const cfg: TaskConfig = { embeddingProvider: "openai", embeddingApiKeyEnv: ENV_KEY };
    expect(resolveEmbedder(cfg)).toBeDefined();
  });
});

// ── store path ────────────────────────────────────────────
describe("embeddingStorePath", () => {
  it("lives in the meta sidecar dir", () => {
    const paths = getVaultPaths("/tmp/x");
    expect(embeddingStorePath(paths)).toBe(join(paths.meta, "embeddings.json"));
  });
});
