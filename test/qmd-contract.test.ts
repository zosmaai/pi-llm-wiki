import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ExpandedQuery, type QMDStore, type SearchOptions, createStore } from "@tobilu/qmd";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openQmdIndexStore } from "../extensions/llm-wiki/lib/qmd-store.js";

const hybridQueries: ExpandedQuery[] = [
  { type: "lex", query: "signed access tokens" },
  { type: "vec", query: "how users authenticate" },
];

const modeContracts = {
  hybrid: {
    queries: hybridQueries,
    rerank: false,
    candidateLimit: 40,
    limit: 10,
    explain: true,
  },
  adaptiveUncertain: {
    query: "how users authenticate",
    intent: "Authentication documentation",
    rerank: true,
    candidateLimit: 40,
    limit: 10,
    explain: true,
  },
  quality: {
    query: "how users authenticate",
    intent: "Authentication documentation",
    rerank: true,
    candidateLimit: 40,
    limit: 10,
    explain: true,
  },
} satisfies Record<string, SearchOptions>;

const tempRoot = mkdtempSync(join(tmpdir(), "pi-llm-wiki-qmd-contract-"));
const docsPath = join(tempRoot, "docs");
const dbPath = join(tempRoot, "index.sqlite");
let store: QMDStore;

function modelFiles(): string[] {
  const modelDir = join(homedir(), ".cache", "qmd", "models");
  if (!existsSync(modelDir)) return [];
  return readdirSync(modelDir).sort();
}

beforeAll(async () => {
  mkdirSync(docsPath, { recursive: true });
  writeFileSync(
    join(docsPath, "auth.md"),
    "# Authentication\n\nUsers authenticate with signed access tokens.\n",
  );
  writeFileSync(
    join(docsPath, "cache.md"),
    "# Cache\n\nCache entries expire after five minutes.\n",
  );
  store = await createStore({
    dbPath,
    config: {
      global_context: "SDK compatibility fixture",
      collections: {
        docs: { path: docsPath, pattern: "**/*.md" },
      },
    },
  });
});

afterAll(async () => {
  await store?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("QMD 2.5.3 SDK contract", () => {
  it("keeps the four-mode request shapes type-compatible", () => {
    expect(modeContracts.hybrid.queries).toEqual(hybridQueries);
    expect(modeContracts.adaptiveUncertain.rerank).toBe(true);
    expect(modeContracts.quality.candidateLimit).toBe(40);
  });

  it("updates and performs lexical search without downloading a model", async () => {
    const beforeModels = modelFiles();
    const updated = await store.update();
    expect(updated.collections).toBe(1);
    expect(updated.indexed).toBe(2);
    expect(updated.needsEmbedding).toBe(2);

    const results = await store.searchLex("signed access tokens", { collection: "docs", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("fts");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].title).toContain("Authentication");

    const status = await store.getStatus();
    expect(status.totalDocuments).toBe(2);
    expect(status.needsEmbedding).toBe(2);
    expect(modelFiles()).toEqual(beforeModels);
  });

  it.runIf(process.env.QMD_MODEL_SMOKE === "1")(
    "embeds, performs vector/hybrid search, expands, and reranks",
    async () => {
      const embedded = await store.embed({ force: true, chunkStrategy: "regex" });
      expect(embedded.docsProcessed).toBe(2);
      expect(embedded.errors).toBe(0);

      const vector = await store.searchVector("how users log in", { collection: "docs", limit: 5 });
      expect(vector.length).toBeGreaterThan(0);

      const hybrid = await store.search({ ...modeContracts.hybrid, collections: ["docs"] });
      expect(hybrid.length).toBeGreaterThan(0);

      const expanded = await store.expandQuery("how users authenticate", {
        intent: "Authentication documentation",
      });
      expect(expanded.length).toBeGreaterThan(0);

      const quality = await store.search({ ...modeContracts.quality, collections: ["docs"] });
      expect(quality.length).toBeGreaterThan(0);
      expect(quality[0].score).toBeGreaterThan(0);
    },
    1_200_000,
  );
});

describe("QMD normalized index store adapter", () => {
  it("updates canonical and evidence collections and reports status", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-llm-wiki-qmd-adapter-"));
    const documentsPath = join(root, "documents");
    const dbPath = join(root, "index.sqlite");
    try {
      mkdirSync(join(documentsPath, "canonical"), { recursive: true });
      mkdirSync(join(documentsPath, "evidence"), { recursive: true });
      writeFileSync(
        join(documentsPath, "canonical", "concept.md"),
        "# Concept\n\nA canonical conclusion.\n",
      );
      writeFileSync(join(documentsPath, "evidence", "source.md"), "# Source\n\nRaw evidence.\n");

      const handle = await openQmdIndexStore({ dbPath, documentsPath });
      const updated = await handle.update();
      expect(updated).toEqual({
        collections: 2,
        indexed: 2,
        updated: 0,
        unchanged: 0,
        removed: 0,
        needsEmbedding: 2,
      });
      expect(await handle.status()).toMatchObject({
        totalDocuments: 2,
        needsEmbedding: 2,
        hasVectorIndex: false,
        canonicalDocuments: 1,
        evidenceDocuments: 1,
      });
      await handle.close();

      // Delete one evidence file, reopen, update, expect removed: 1.
      rmSync(join(documentsPath, "evidence", "source.md"));
      const reopened = await openQmdIndexStore({ dbPath, documentsPath });
      const removed = await reopened.update();
      expect(removed.removed).toBe(1);
      expect(removed.indexed).toBe(0);
      expect((await reopened.status()).totalDocuments).toBe(1);
      await reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lexical update leaves the QMD model cache unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-llm-wiki-qmd-adapter-"));
    const documentsPath = join(root, "documents");
    const dbPath = join(root, "index.sqlite");
    try {
      mkdirSync(join(documentsPath, "canonical"), { recursive: true });
      writeFileSync(join(documentsPath, "canonical", "a.md"), "# A\n\nBody A.\n");
      const beforeModels = modelFiles();
      const handle = await openQmdIndexStore({ dbPath, documentsPath });
      await handle.update();
      expect(modelFiles()).toEqual(beforeModels);
      await handle.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
