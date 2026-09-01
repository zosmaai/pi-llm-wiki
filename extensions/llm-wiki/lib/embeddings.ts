import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { parseKnowledgeDocument } from "./knowledge-document.js";
import type { Registry } from "./metadata.js";
import type { LaunchCtx, Runtime } from "./runtime.js";
import type { TaskConfig } from "./task-config.js";
import { readJson, type VaultPaths, writeJson } from "./utils.js";
import { assertWritableVault } from "./vault-format.js";

/**
 * Background semantic embeddings, computed at write time (issue #66, epic #63).
 *
 * Every wiki page gets a normalized embedding vector stored in a sidecar
 * (`meta/embeddings.json`), keyed by page id with a content hash for staleness
 * detection. Embeddings are computed in the background via the #64 runtime so
 * the main agent is never blocked, and so that semantic retrieval (#67) can
 * rank pages WITHOUT any embedding/LLM call in the query hot path.
 *
 * Design principles:
 *   - Fully optional: with no embedding provider configured, `resolveEmbedder`
 *     returns undefined and every entry point no-ops silently. Existing lexical
 *     search (lib/recall.ts) is untouched. This is the default.
 *   - Embeddings have their OWN auth path (an embedding API key + an
 *     OpenAI-compatible endpoint), independent of the chat-model resolution in
 *     Runtime.resolveModel.
 *   - The compute/store functions take an injected `Embedder`, so unit tests
 *     mock embedding with NO network.
 */

// ── constants ─────────────────────────────────────────────
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com";
/** Cap on body chars fed into a single embedding (keep prompts bounded). */
const MAX_BODY_CHARS = 8_000;
const STORE_VERSION = "1.0";

// ── types ─────────────────────────────────────────────────

/** Embeds a batch of texts into raw (un-normalized) vectors. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** A resolved embedding backend: a model label + the embed function. */
export interface Embedder {
  model: string;
  embed: EmbedFn;
}

export interface EmbeddingEntry {
  /** sha256 of the exact text that was embedded — drives staleness detection. */
  hash: string;
  /** Embedding model label that produced this vector. */
  model: string;
  /** Vector dimensionality. */
  dim: number;
  /** Normalized (unit-length) vector for cosine similarity. */
  vector: number[];
  /** ISO timestamp of when this entry was written. */
  updated: string;
}

export interface EmbeddingStore {
  version: string;
  /** Keyed by folder-qualified page id (e.g. "concepts/rag"). */
  entries: Record<string, EmbeddingEntry>;
}

export interface EmbedStats {
  embedded: number;
  skipped: number;
  total: number;
}

export interface ReindexStats extends EmbedStats {
  pruned: number;
}

// ── vector math (shared with retrieval #67) ───────────────

/** Normalize a vector to unit length so dot product == cosine similarity. */
export function normalizeVector(vec: number[]): number[] {
  const sanitized = vec.map((v) => (Number.isFinite(v) ? v : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) return new Array(sanitized.length).fill(0);
  return sanitized.map((v) => v / magnitude);
}

/** Cosine similarity of two vectors. Robust to un-normalized input. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Stable content hash of the text that was (or will be) embedded. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── embedding text ────────────────────────────────────────

/**
 * Build the text to embed for a page: its title + salient frontmatter +
 * (bounded) body. Mirrors memex's `buildEmbeddingText` — front-loading the
 * high-signal metadata then appending the body content.
 */
export function buildEmbeddingText(
  id: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const parts: string[] = [];

  const title = frontmatter.title;
  parts.push(`title: ${typeof title === "string" && title.trim() ? title.trim() : id}`);
  if (typeof frontmatter.type === "string" && frontmatter.type.trim()) {
    parts.push(`type: ${frontmatter.type.trim()}`);
  }

  for (const key of [
    "aliases",
    "recall_triggers",
    "summary",
    "description",
    "tags",
    "category",
    "domain",
  ]) {
    const val = frontmatter[key];
    if (typeof val === "string" && val.trim()) {
      parts.push(`${key}: ${val.trim()}`);
    } else if (Array.isArray(val) && val.length > 0) {
      parts.push(`${key}: ${val.map((v) => String(v)).join(", ")}`);
    }
  }

  const head = parts.join("\n");
  const trimmedBody = body.trim().slice(0, MAX_BODY_CHARS);
  return trimmedBody ? `${head}\n\n${trimmedBody}` : head;
}

// ── sidecar store I/O ─────────────────────────────────────

export function embeddingStorePath(paths: VaultPaths): string {
  return join(paths.meta, "embeddings.json");
}

export function readEmbeddingStore(paths: VaultPaths): EmbeddingStore {
  const store = readJson<EmbeddingStore>(embeddingStorePath(paths), {
    version: STORE_VERSION,
    entries: {},
  });
  if (!store.entries || typeof store.entries !== "object") {
    return { version: STORE_VERSION, entries: {} };
  }
  return store;
}

export function writeEmbeddingStore(paths: VaultPaths, store: EmbeddingStore): void {
  assertWritableVault(paths);
  writeJson(embeddingStorePath(paths), store);
}

/** True if the page id has no fresh embedding for the given hash + model. */
export function isStale(store: EmbeddingStore, id: string, hash: string, model: string): boolean {
  const entry = store.entries[id];
  if (!entry) return true;
  return entry.hash !== hash || entry.model !== model;
}

// ── compute ───────────────────────────────────────────────

interface PageText {
  id: string;
  text: string;
  hash: string;
}

/** Read a page file (if present) and derive its embedding text + hash. */
function readPageText(paths: VaultPaths, id: string): PageText | undefined {
  const pagePath = join(paths.wiki, `${id}.md`);
  if (!existsSync(pagePath)) return undefined;
  const raw = readFileSync(pagePath, "utf-8");
  const result = parseKnowledgeDocument(raw, `${id}.md`);
  if (!result.ok) return undefined;
  const text = buildEmbeddingText(id, result.document.frontmatter, result.document.body);
  return { id, text, hash: contentHash(text) };
}

/**
 * Embed the given page ids, writing fresh vectors into the sidecar store.
 * Stale-aware: pages whose hash + model already match are skipped (unless
 * `force`). Pure async — pass a mock `Embedder` to test without a network.
 */
export async function embedPages(
  paths: VaultPaths,
  ids: string[],
  embedder: Embedder,
  opts: { force?: boolean } = {},
): Promise<EmbedStats> {
  assertWritableVault(paths);
  const store = readEmbeddingStore(paths);
  const targets: PageText[] = [];
  let skipped = 0;

  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const page = readPageText(paths, id);
    if (!page) continue;
    if (!opts.force && !isStale(store, id, page.hash, embedder.model)) {
      skipped++;
      continue;
    }
    targets.push(page);
  }

  if (targets.length > 0) {
    const vectors = await embedder.embed(targets.map((t) => t.text));
    const now = new Date().toISOString();
    for (let i = 0; i < targets.length; i++) {
      const vec = normalizeVector(vectors[i] ?? []);
      store.entries[targets[i].id] = {
        hash: targets[i].hash,
        model: embedder.model,
        dim: vec.length,
        vector: vec,
        updated: now,
      };
    }
    writeEmbeddingStore(paths, store);
  }

  return { embedded: targets.length, skipped, total: seen.size };
}

/**
 * Embed every registered wiki page that has a backing file, skipping fresh
 * ones (unless `force`), and prune sidecar entries for deleted pages. This is
 * the backfill / re-embed-stale path used by the reindex command.
 */
export async function reindexEmbeddings(
  paths: VaultPaths,
  embedder: Embedder,
  opts: { force?: boolean } = {},
): Promise<ReindexStats> {
  assertWritableVault(paths);
  const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
    version: "1.0",
    last_updated: "",
    pages: {},
  });

  const ids = Object.keys(registry.pages).filter((id) => existsSync(join(paths.wiki, `${id}.md`)));

  const stats = await embedPages(paths, ids, embedder, opts);

  // Prune entries whose page file no longer exists.
  const store = readEmbeddingStore(paths);
  let pruned = 0;
  for (const id of Object.keys(store.entries)) {
    if (!existsSync(join(paths.wiki, `${id}.md`))) {
      delete store.entries[id];
      pruned++;
    }
  }
  if (pruned > 0) writeEmbeddingStore(paths, store);

  return { ...stats, pruned };
}

// ── provider resolution (OpenAI-compatible) ───────────────

/** Compose the /v1/embeddings request path from an optional base path. */
function embeddingsRequestPath(basePath: string): string {
  if (!basePath || basePath === "/") return "/v1/embeddings";
  if (basePath.endsWith("/v1")) return `${basePath}/embeddings`;
  return `${basePath}/v1/embeddings`;
}

interface EmbeddingApiResponse {
  data?: Array<{ index?: number; embedding: number[] }>;
  error?: { message?: string };
  /** Some OpenAI-compatible gateways (e.g. GSA USAi / Vertex) nest errors here. */
  detail?: unknown;
}

/**
 * Max inputs per embeddings request. Providers cap batch size server-side
 * (OpenAI 2048, Google Vertex `text-embedding-*` 250, Cohere v3 96); we chunk
 * under the smallest common limit so a reindex of hundreds of pages never
 * overruns the cap. Exported so tests and callers can reference the default.
 */
export const DEFAULT_MAX_EMBED_BATCH = 96;

/**
 * Approx per-request character budget. Providers also cap *total tokens* per
 * request (Google Vertex `text-embedding-*` = 20,000 tokens). Tokenizing here
 * would add a dependency, so we approximate with a conservative char budget
 * (~2.8 chars/token observed for wiki prose, with headroom) — the request
 * stays well under the token cap without counting tokens.
 */
export const DEFAULT_MAX_EMBED_BATCH_CHARS = 45_000;

/**
 * Split `texts` into batches that stay under BOTH a count cap and a total
 * char budget. A single oversized text is emitted as its own batch rather than
 * dropped, so every input is always embedded. Pure — unit-testable with no
 * network.
 */
export function chunkByBudget(texts: string[], maxCount: number, maxChars: number): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const text of texts) {
    // Close the current batch before adding a text that would exceed either
    // cap — but never emit an empty batch (an oversized text stands alone).
    if (batch.length > 0 && (batch.length >= maxCount || chars + text.length > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(text);
    chars += text.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Parse an OpenAI-compatible embeddings response into row-ordered vectors,
 * throwing on any error shape so failures are never silently stored as empty
 * vectors. Handles gateways that report errors via a nested `detail` field
 * (GSA USAi / Vertex) or via HTTP status alone, and providers that omit the
 * per-row `index` (returning rows in request order). Pure — unit-testable.
 */
export function parseEmbeddingResponse(
  status: number,
  body: EmbeddingApiResponse,
  expectedCount: number,
): number[][] {
  if (body.error || body.detail !== undefined || status < 200 || status >= 300) {
    const message =
      body.error?.message ??
      (typeof body.detail === "string"
        ? body.detail
        : body.detail !== undefined
          ? JSON.stringify(body.detail)
          : `HTTP ${status}`);
    throw new Error(`embedding API error: ${message}`);
  }
  const rows = body.data ?? [];
  if (rows.length !== expectedCount) {
    throw new Error(`embedding API returned ${rows.length} vectors for ${expectedCount} inputs`);
  }
  const ordered = rows.every((r) => typeof r.index === "number")
    ? [...rows].sort((a, b) => (a.index as number) - (b.index as number))
    : rows;
  return ordered.map((r) => r.embedding);
}

/**
 * Create an `EmbedFn` backed by an OpenAI-compatible `/v1/embeddings`
 * endpoint. Uses node's http/https directly (no SDK) so it works against
 * OpenAI, Azure (with an api-key header), or any compatible gateway.
 *
 * Inputs are split into batches under both the instance-count and total-char
 * caps (see `chunkByBudget`) and re-joined in request order, so provider batch
 * limits never truncate a reindex. Any request error is thrown, not swallowed.
 */
export function createOpenAIEmbedFn(cfg: {
  apiKey: string;
  baseUrl: string;
  model: string;
  headers?: Record<string, string>;
}): EmbedFn {
  const parsed = new URL(cfg.baseUrl);
  const basePath = parsed.pathname.replace(/\/$/, "");
  const requestPath = embeddingsRequestPath(basePath);
  const useHttp = parsed.protocol === "http:";
  const port = parsed.port ? Number(parsed.port) : undefined;

  const embedBatch = (texts: string[]): Promise<number[][]> =>
    new Promise<number[][]>((resolve, reject) => {
      if (texts.length === 0) {
        resolve([]);
        return;
      }
      const body = JSON.stringify({ model: cfg.model, input: texts });
      const reqFn = useHttp ? httpRequest : httpsRequest;
      const req = reqFn(
        {
          hostname: parsed.hostname,
          ...(port ? { port } : {}),
          path: requestPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
            ...(cfg.headers ?? {}),
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            let parsedBody: EmbeddingApiResponse;
            try {
              parsedBody = JSON.parse(data) as EmbeddingApiResponse;
            } catch (err) {
              reject(new Error(`failed to parse embedding response: ${(err as Error).message}`));
              return;
            }
            try {
              resolve(parseEmbeddingResponse(res.statusCode ?? 0, parsedBody, texts.length));
            } catch (err) {
              reject(err as Error);
            }
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

  return async (texts) => {
    const out: number[][] = [];
    for (const batch of chunkByBudget(
      texts,
      DEFAULT_MAX_EMBED_BATCH,
      DEFAULT_MAX_EMBED_BATCH_CHARS,
    )) {
      out.push(...(await embedBatch(batch)));
    }
    return out;
  };
}

/**
 * Resolve an `Embedder` from config, or `undefined` when embeddings are not
 * configured (the default — fully optional, silent no-op).
 *
 * Opt-in is explicit: `embeddingProvider` MUST be set (we do not auto-enable
 * just because an ambient OPENAI_API_KEY happens to exist). Only the
 * OpenAI-compatible provider is supported; anything else no-ops.
 */
export function resolveEmbedder(config: TaskConfig): Embedder | undefined {
  const provider = config.embeddingProvider?.trim().toLowerCase();
  if (!provider) return undefined;
  if (provider !== "openai" && provider !== "openai-compatible") return undefined;

  const keyEnv = config.embeddingApiKeyEnv?.trim() || "OPENAI_API_KEY";
  const apiKey = config.embeddingApiKey?.trim() || process.env[keyEnv]?.trim();
  if (!apiKey) return undefined;

  const model = config.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL;
  const baseUrl =
    config.embeddingBaseUrl?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    DEFAULT_EMBEDDING_BASE_URL;

  return { model, embed: createOpenAIEmbedFn({ apiKey, baseUrl, model }) };
}

// ── background launch helpers (used by tools/guardrails) ──

/**
 * Launch a background task that embeds a specific set of pages, if (and only
 * if) an embedder is configured. No-op (returns false) otherwise. Single-flight
 * per label, error-isolated, drained at compaction/shutdown — all via #64.
 */
export function launchEmbedPages(
  runtime: Runtime,
  ctx: LaunchCtx,
  paths: VaultPaths,
  ids: string[],
  label: string,
): boolean {
  if (ids.length === 0) return false;
  runtime.ensureConfig(paths.root);
  const embedder = resolveEmbedder(runtime.config);
  if (!embedder) return false;
  runtime.launchTask(ctx, label, async () => {
    await embedPages(paths, ids, embedder);
  });
  return true;
}

/**
 * Launch a background reindex (embed all stale registered pages + prune
 * deleted), if an embedder is configured. No-op otherwise. Single-flight per
 * vault so repeated writes within a turn collapse into one pass.
 */
export function launchReindex(runtime: Runtime, ctx: LaunchCtx, paths: VaultPaths): boolean {
  runtime.ensureConfig(paths.root);
  const embedder = resolveEmbedder(runtime.config);
  if (!embedder) return false;
  runtime.launchTask(ctx, `embed:reindex:${paths.root}`, async () => {
    await reindexEmbeddings(paths, embedder);
  });
  return true;
}
