import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Embedder, readEmbeddingStore } from "../extensions/llm-wiki/lib/embeddings.js";
import {
  type CommitResult,
  commitSynthesis,
  type RunIngestSynthesisArgs,
} from "../extensions/llm-wiki/lib/ingest-worker.js";
import { loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { defaultProviderFactory, resolveLaneModel } from "../mcp/model-lane.js";
import { ingestOperation } from "../mcp/operations.js";

const FAUX_PROVIDER = "faux";
const FAUX_MODEL = "faux-test";

/** pi-ai's test-double provider handle; the factory must return `.provider`. */
function fauxFactory(): unknown {
  return fauxProvider({
    provider: FAUX_PROVIDER,
    models: [{ id: FAUX_MODEL }],
  }).provider;
}

function committedSynthesis(args: RunIngestSynthesisArgs): CommitResult {
  const result = commitSynthesis(args.paths, args.sourceId, args.manifest, {
    summary: "A deterministic test summary.",
    key_takeaways: ["The test source was committed."],
    entities: [{ title: "Test Entity", description: "A test entity." }],
    concepts: [],
  });
  if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? "commit failed");
  return result;
}

function testEmbedder(calls: string[][]): Embedder {
  return {
    model: "test-embedding-model",
    embed: async (texts) => {
      calls.push(texts);
      return texts.map((_, index) => [index + 1, 1]);
    },
  };
}

let root: string;
beforeEach(() => {
  root = join(
    import.meta.dirname,
    "..",
    "tmp",
    `mcp-lane-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({
      "llm-wiki": {
        mode: "personal",
        taskModel: { provider: FAUX_PROVIDER, id: FAUX_MODEL },
        taskModelApiKey: "test-key",
        taskModelBaseUrl: "http://localhost",
      },
    }),
  );
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ mode: "personal" }));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

it("resolveLaneModel resolves a model from the config-first lane (faux provider)", async () => {
  const res = await resolveLaneModel(loadTaskConfig(root), fauxFactory);
  expect(res.ok).toBe(true);
});

it("resolveLaneModel degrades gracefully when no model is configured", async () => {
  const cfg = loadTaskConfig(root);
  const bare = { ...cfg, taskModel: undefined };
  const res = await resolveLaneModel(bare, fauxFactory);
  expect(res.ok).toBe(false);
});

it("resolveLaneModel registers a per-call override without configured taskModel", async () => {
  const res = await resolveLaneModel(
    { taskModelApiKey: "test-key", taskModelBaseUrl: "http://localhost" },
    defaultProviderFactory,
    { provider: "override-provider", id: "override-model" },
  );
  expect(res.ok).toBe(true);
  if (res.ok)
    expect(res.model).toMatchObject({ provider: "override-provider", id: "override-model" });
});

it("resolveLaneModel registers a different per-call provider and model", async () => {
  const res = await resolveLaneModel(
    {
      taskModel: { provider: "configured-provider", id: "configured-model" },
      taskModelApiKey: "test-key",
      taskModelBaseUrl: "http://localhost",
    },
    defaultProviderFactory,
    { provider: "override-provider", id: "override-model" },
  );
  expect(res.ok).toBe(true);
  if (res.ok)
    expect(res.model).toMatchObject({ provider: "override-provider", id: "override-model" });
});

it("ingestOperation reports when the vault has no raw packets at all", async () => {
  const paths = getVaultPaths(root);
  rmSync(paths.rawSources, { recursive: true, force: true });
  const res = await ingestOperation(paths, {});
  expect(res.isError).toBe(true);
  expect(res.report).toContain("No raw/sources/ directory");
});

it("ingestOperation reports when every source is already ingested", async () => {
  const paths = getVaultPaths(root);
  const res = await ingestOperation(paths, {});
  expect(res.isError).toBeUndefined();
  expect(res.report).toContain("All sources ingested");
});

it("ingestOperation falls back to self-synthesize instructions when the lane has no model", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolatedAgentDir = join(root, "agent");
  mkdirSync(isolatedAgentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  try {
    writeFileSync(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { mode: "personal" } }),
    );
    const paths = getVaultPaths(root);
    mkdirSync(join(paths.rawSources, "SRC-2026-09-11-001"), { recursive: true });
    writeFileSync(join(paths.rawSources, "SRC-2026-09-11-001", "extracted.md"), "hello world");
    writeFileSync(
      join(paths.rawSources, "SRC-2026-09-11-001", "manifest.json"),
      JSON.stringify({
        kind: "text",
        title: "Lane Test",
        captured_at: "2026-09-11T00:00:00Z",
      }),
    );
    const res = await ingestOperation(paths, {});
    expect(res.isError).toBeUndefined();
    expect(res.report).toContain("synthesize these sources yourself");
    expect(res.report).toContain("SRC-2026-09-11-001");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

it("embeds pages written by each successful MCP synthesis", async () => {
  const paths = getVaultPaths(root);
  const sourceId = "SRC-2026-09-11-001";
  mkdirSync(join(paths.rawSources, sourceId), { recursive: true });
  writeFileSync(join(paths.rawSources, sourceId, "extracted.md"), "test source text");
  writeFileSync(
    join(paths.rawSources, sourceId, "manifest.json"),
    JSON.stringify({ id: sourceId, title: "Embedding Lane Test", format: "text" }),
  );
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  writeFileSync(
    join(paths.wiki, "concepts", "unrelated.md"),
    "---\ntype: concept\ntitle: Unrelated\nstatus: active\n---\n\n# Unrelated\n",
  );

  const calls: string[][] = [];
  const result = await ingestOperation(
    paths,
    {},
    {
      runSynthesis: async (args) => committedSynthesis(args),
      embedder: testEmbedder(calls),
    },
  );

  expect(result.isError).toBeUndefined();
  expect(result.report).toContain(`**${sourceId}**: ingested`);
  expect(result.report).toContain("embeddings: 2 embedded");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveLength(2);
  const store = readEmbeddingStore(paths);
  expect(store.entries[`sources/${sourceId}`]).toBeDefined();
  expect(store.entries["entities/test-entity"]).toBeDefined();
  expect(store.entries["concepts/unrelated"]).toBeUndefined();
});

it("keeps a committed synthesis successful when post-commit embedding fails", async () => {
  const paths = getVaultPaths(root);
  const sourceId = "SRC-2026-09-11-002";
  mkdirSync(join(paths.rawSources, sourceId), { recursive: true });
  writeFileSync(join(paths.rawSources, sourceId, "extracted.md"), "test source text");
  writeFileSync(
    join(paths.rawSources, sourceId, "manifest.json"),
    JSON.stringify({ id: sourceId, title: "Embedding Failure Test", format: "text" }),
  );
  const failingEmbedder: Embedder = {
    model: "test-embedding-model",
    embed: async () => {
      throw new Error("provider offline");
    },
  };
  const result = await ingestOperation(
    paths,
    {},
    {
      runSynthesis: async (args) => committedSynthesis(args),
      embedder: failingEmbedder,
    },
  );

  expect(result.isError).toBeUndefined();
  expect(result.report).toContain(`**${sourceId}**: ingested`);
  expect(result.report).toContain("embedding refresh failed");
  expect(readFileSync(join(paths.wiki, "sources", `${sourceId}.md`), "utf8")).toContain(
    "status: ingested",
  );
});
