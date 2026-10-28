import { join } from "node:path";
import type { HybridQueryResult, QMDStore, SearchResult } from "@tobilu/qmd";

/**
 * Package-private normalized adapter over the pinned @tobilu/qmd SDK.
 *
 * This is the ONLY production module allowed to import @tobilu/qmd. It hides
 * SDK-specific types, collection config, model identity, and close behavior so
 * the rest of the extension never touches QMD internals or tables directly.
 */

export const QMD_PACKAGE_VERSION = "2.8.3";
export const QMD_DEFAULT_MODELS = {
  embed: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
  generate: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
  rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
} as const;

export interface QmdResolvedModels {
  embed: string;
  generate: string;
  rerank: string;
}

export interface QmdStoreUpdateResult {
  collections: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Present since qmd 2.8 (documents excluded by ignore rules / not re-indexed). */
  skipped: number;
  needsEmbedding: number;
}

export interface QmdStoreEmbedResult {
  docsProcessed: number;
  chunksEmbedded: number;
  errors: number;
  durationMs: number;
}

export interface QmdStoreStatus {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  canonicalDocuments: number;
  evidenceDocuments: number;
}

export interface QmdIndexStore {
  update(
    onProgress?: (progress: {
      collection: string;
      file: string;
      current: number;
      total: number;
    }) => void,
  ): Promise<QmdStoreUpdateResult>;
  embed(options: {
    force: boolean;
    onProgress?: (progress: {
      chunksEmbedded: number;
      totalChunks: number;
      errors: number;
    }) => void;
  }): Promise<QmdStoreEmbedResult>;
  status(): Promise<QmdStoreStatus>;
  /** lexical: store.searchLex(query, { limit }) — BM25 only, no model load. */
  searchLex(query: string, limit?: number): Promise<QmdSearchHit[]>;
  /** hybrid + adaptive-initial: typed lex/vec queries, NO LLM expansion, NO rerank. */
  searchTyped(query: string, limit?: number): Promise<QmdSearchHit[]>;
  /** adaptive-uncertain + quality: plain query, LLM expansion + rerank, with intent. */
  searchExpanded(
    query: string,
    intent: string | undefined,
    limit?: number,
  ): Promise<QmdSearchHit[]>;
  close(): Promise<void>;
}

/**
 * Normalized, SDK-free retrieval hit. `score` is 0..1 relative to this result
 * list's max (within-store confidence only — never comparable across stores).
 */
export interface QmdSearchHit {
  /** Mirror collection the hit came from ("canonical" | "evidence"). */
  collection: "canonical" | "evidence";
  /** Mirror-relative file, e.g. "qmd://canonical/concepts/rag.md". */
  file: string;
  title: string;
  /** 0..1, normalized to this result list's max. Within-store confidence only. */
  score: number;
  source: "fts" | "vec";
  /** Best chunk body when the SDK returned one (hybrid results). */
  body?: string;
}

/**
 * Mirror collection a hit came from: the SDK reports virtual paths
 * "qmd://<collection>/<path>.md", and the mirror layout is
 * ".../documents/<role>/<pageId>.md". Either form resolves the role.
 */
function roleFromFile(file: string): QmdSearchHit["collection"] {
  return /(?:^|\/)documents\/canonical\/|^qmd:\/\/canonical\//.test(file)
    ? "canonical"
    : "evidence";
}

type RawHit = Omit<QmdSearchHit, "score"> & { raw: number };

/** Normalize raw within-store scores to 0..1 against this list's max. */
function withNormalizedScores(hits: RawHit[]): QmdSearchHit[] {
  const max = Math.max(...hits.map((h) => h.raw), 1e-9);
  return hits.map(({ raw, ...rest }) => ({ ...rest, score: raw / max }));
}

const mapLexHit = (r: SearchResult): RawHit => ({
  collection: roleFromFile(r.filepath),
  file: r.filepath,
  title: r.title,
  source: r.source,
  raw: r.score,
});

const mapHybridHit = (r: HybridQueryResult): RawHit => ({
  collection: roleFromFile(r.file),
  file: r.file,
  title: r.title,
  source: "fts" as const,
  body: r.bestChunk,
  raw: r.score,
});

export type QmdStoreFactory = (input: {
  dbPath: string;
  documentsPath: string;
}) => Promise<QmdIndexStore>;

/**
 * Issue #302: two unrelated install failures reach this one catch, and the
 * single message we used to print blamed a native build for both. They need
 * different remedies, so name the cause.
 *
 * - The module is not on disk at all. npm drops an optional subtree whose peer
 *   requirements cannot be met, and it does so without a warning.
 *   @tobilu/qmd declares `peer typescript@^5.9.3`, so any consumer on
 *   TypeScript 6 or 7 loses qmd silently.
 * - The module is on disk but its native subtree failed to build or load
 *   (`ERR_DLOPEN_FAILED`), which is what the old message described.
 */
export function describeQmdUnavailable(cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const code = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  const moduleMissing =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find (?:package|module)/.test(reason);
  if (moduleMissing) {
    return (
      `@tobilu/qmd ${QMD_PACKAGE_VERSION} is not installed. It is an optional dependency, and npm ` +
      "silently drops an optional subtree whose peer requirements cannot be met — qmd declares " +
      "`peer typescript@^5.9.3`, so any host that has TypeScript 6 or 7 installed loses it without " +
      "a warning. Install it with peer resolution relaxed: " +
      "`npm install @tobilu/qmd@" +
      QMD_PACKAGE_VERSION +
      " --legacy-peer-deps` (pi's own `pi install` already passes `--legacy-peer-deps`). " +
      "Keyword recall keeps working; only the semantic index needs qmd."
    );
  }
  return (
    `@tobilu/qmd ${QMD_PACKAGE_VERSION} is installed but failed to load: ${reason}. Its native ` +
    "subtree (better-sqlite3, sqlite-vec, node-llama-cpp) needs GitHub access or a C++ toolchain " +
    "to build. Re-run the install with GitHub reachable, or with build tools available."
  );
}

/**
 * Open a QMD index store over the mirror documents directory, with two
 * non-overlapping collections (canonical and evidence).
 */
export async function openQmdIndexStore(input: {
  dbPath: string;
  documentsPath: string;
}): Promise<QmdIndexStore> {
  // @tobilu/qmd is an optional dependency (issue #264): on restricted machines
  // its native subtree (better-sqlite3) fails to install, and npm also drops it
  // when a peer requirement is unmet (issue #302). Load lazily so the package
  // installs everywhere — only QMD operations fail, with an actionable message.
  let createStore: typeof import("@tobilu/qmd").createStore;
  try {
    ({ createStore } = await import("@tobilu/qmd"));
  } catch (cause) {
    throw new Error(describeQmdUnavailable(cause), { cause });
  }

  const store: QMDStore = await createStore({
    dbPath: input.dbPath,
    config: {
      global_context: "Validated LLM Wiki knowledge",
      collections: {
        canonical: {
          path: join(input.documentsPath, "canonical"),
          pattern: "**/*.md",
          context: { "/": "Reusable conclusions, entities, requirements, and procedures" },
        },
        evidence: {
          path: join(input.documentsPath, "evidence"),
          pattern: "**/*.md",
          context: { "/": "Source evidence, observations, trajectories, and unpromoted notes" },
        },
      },
    },
  });

  return {
    update: (onProgress) => store.update({ onProgress }),
    embed: ({ force, onProgress }) => store.embed({ force, chunkStrategy: "regex", onProgress }),
    status: async () => {
      const status = await store.getStatus();
      const counts = Object.fromEntries(
        status.collections.map((collection) => [collection.name, collection.documents]),
      );
      return {
        totalDocuments: status.totalDocuments,
        needsEmbedding: status.needsEmbedding,
        hasVectorIndex: status.hasVectorIndex,
        canonicalDocuments: counts.canonical ?? 0,
        evidenceDocuments: counts.evidence ?? 0,
      };
    },
    close: () => store.close(),
    searchLex: async (query, limit = 40) =>
      withNormalizedScores((await store.searchLex(query, { limit })).map(mapLexHit)),
    searchTyped: async (query, limit = 10) =>
      withNormalizedScores(
        (
          await store.search({
            queries: [
              { type: "lex", query },
              { type: "vec", query },
            ],
            rerank: false,
            candidateLimit: 40,
            limit,
            explain: true,
          })
        ).map(mapHybridHit),
      ),
    searchExpanded: async (query, intent, limit = 10) =>
      withNormalizedScores(
        (
          await store.search({
            query,
            intent,
            rerank: true,
            candidateLimit: 40,
            limit,
            explain: true,
          })
        ).map(mapHybridHit),
      ),
  };
}

/** Resolve model identities from env, defaulting to pinned models. No downloads. */
export function resolveQmdModels(env: NodeJS.ProcessEnv = process.env): QmdResolvedModels {
  return {
    embed: env.QMD_EMBED_MODEL?.trim() || QMD_DEFAULT_MODELS.embed,
    generate: env.QMD_GENERATE_MODEL?.trim() || QMD_DEFAULT_MODELS.generate,
    rerank: env.QMD_RERANK_MODEL?.trim() || QMD_DEFAULT_MODELS.rerank,
  };
}
