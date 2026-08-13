import { join } from "node:path";
import { type QMDStore, createStore } from "@tobilu/qmd";

/**
 * Package-private normalized adapter over the pinned @tobilu/qmd SDK.
 *
 * This is the ONLY production module allowed to import @tobilu/qmd. It hides
 * SDK-specific types, collection config, model identity, and close behavior so
 * the rest of the extension never touches QMD internals or tables directly.
 */

export const QMD_PACKAGE_VERSION = "2.5.3";
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
  close(): Promise<void>;
}

export type QmdStoreFactory = (input: {
  dbPath: string;
  documentsPath: string;
}) => Promise<QmdIndexStore>;

/**
 * Open a QMD index store over the mirror documents directory, with two
 * non-overlapping collections (canonical and evidence).
 */
export async function openQmdIndexStore(input: {
  dbPath: string;
  documentsPath: string;
}): Promise<QmdIndexStore> {
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
