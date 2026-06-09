import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  type Embedder,
  type EmbeddingStore,
  cosineSimilarity,
  normalizeVector,
  readEmbeddingStore,
  resolveEmbedder,
} from "./embeddings.js";
import type { Registry } from "./metadata.js";
import type { Runtime } from "./runtime.js";
import type { TaskConfig } from "./task-config.js";
import {
  type VaultPaths,
  getPersonalWikiPaths,
  isPersonalVault,
  parseFrontmatter,
  readJson,
  resolveVaultPaths,
} from "./utils.js";

// ─── Public API ────────────────────────────────────────

export interface RecallResult {
  /** Page identifier (folder-qualified, e.g. "concepts/rag") */
  id: string;
  /** Page title */
  title: string;
  /** Page type: source, entity, concept, synthesis, analysis */
  type: string;
  /** First N chars of page content for context */
  preview: string;
  /** Relative path from wiki root */
  path: string;
  /** Vault source label for dual-vault results */
  vaultLabel?: string;
  /** Relevance score (higher = better match). Used for filtering auto-injected results. */
  score: number;
}

type Scored = {
  id: string;
  entry: Registry["pages"][string];
  score: number;
  pagePath: string;
  bestChunkPreview: string;
  /** Cosine similarity to the query vector (0 when no semantic context). */
  semCos: number;
};

// ─── Hybrid (lexical + semantic) ranking ─────────────────

/**
 * Semantic re-ranking context for a single search (issue #67, epic #63).
 *
 * The query vector is computed ONCE per query (a single, cached embedding
 * lookup) in the async wrapper; the per-vault page vectors are read from the
 * precomputed `meta/embeddings.json` sidecar (written at #66 write-time). The
 * actual ranking is pure vector math — there is NO embedding/LLM call in
 * `searchWiki` itself, so the lexical hot path stays synchronous and offline.
 */
export interface SemanticContext {
  /** L2-normalized embedding of the query string. */
  queryVector: number[];
  /** Blend weight for the semantic signal (0 = lexical only, 1 = max boost). */
  weight: number;
}

/** Default blend weight when none is configured. */
export const DEFAULT_SEMANTIC_WEIGHT = 0.5;

/**
 * Lexical points a perfect (cosine = 1) semantic match is worth at full
 * weight. Chosen so a strong paraphrase match (cosine ≳ 0.84) at the default
 * weight (0.5) clears the auto-injection threshold (minScore = 5) on its own,
 * while weak/incidental similarity stays below it.
 */
export const SEMANTIC_SCALE = 12;

/**
 * Minimum cosine for a page with NO lexical match to even be considered a
 * semantic candidate. Keeps the candidate set bounded (near-orthogonal pages
 * are ignored) instead of pulling in the entire embedded vault.
 */
export const SEMANTIC_MIN_COSINE = 0.2;

/**
 * Blend a lexical score with a cosine similarity. The lexical score keeps its
 * original absolute scale (so `minScore` semantics survive); the semantic
 * signal is added as a bounded, weighted boost on a comparable scale. With no
 * semantic signal (cosine ≤ 0) this is the identity on the lexical score, so
 * the pure-lexical path is preserved exactly.
 */
export function fuseScores(lexical: number, cosine: number, weight: number): number {
  return lexical + weight * SEMANTIC_SCALE * Math.max(cosine, 0);
}

/**
 * Normalize text for recall matching.
 *
 * Wiki queries are often short and multilingual (for example: "继续学习pi").
 * Normalization keeps CJK characters intact, lowercases Latin text, removes
 * punctuation boundaries, and makes hyphenated page IDs match space-separated
 * queries.
 */
function normalizeText(value: unknown): string {
  return flattenSearchValue(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\-_./\\]+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "");
}

function flattenSearchValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(flattenSearchValue).join(" ");
  if (typeof value === "object") return Object.values(value).map(flattenSearchValue).join(" ");
  return String(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Tokenize with support for CJK short queries and English/kebab-case terms.
 *
 * Besides whitespace tokens, this returns Latin/digit runs ("pi", "recall")
 * and overlapping CJK bigrams/trigrams. The full normalized query is also kept
 * so exact short phrases still rank highest.
 */
function queryTerms(query: string): string[] {
  const normalized = normalizeText(query);
  const compact = compactText(normalized);
  const terms: string[] = [];

  if (normalized) terms.push(normalized);
  if (compact && compact !== normalized) terms.push(compact);

  for (const part of normalized.split(/\s+/)) {
    if (part.length >= 2) terms.push(part);
  }

  const latinRuns = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  terms.push(...latinRuns);

  const cjkRuns =
    normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const run of cjkRuns) {
    for (let size = 2; size <= 3; size++) {
      if (run.length < size) continue;
      for (let i = 0; i <= run.length - size; i++) {
        terms.push(run.slice(i, i + size));
      }
    }
  }

  return unique(terms).slice(0, 30);
}

function includesTerm(haystack: string, term: string): boolean {
  if (!haystack || !term) return false;
  return haystack.includes(term) || compactText(haystack).includes(compactText(term));
}

function scoreField(value: unknown, terms: string[], weight: number): number {
  const text = normalizeText(value);
  if (!text) return 0;

  let score = 0;
  for (const term of terms) {
    if (includesTerm(text, term)) score += weight;
  }
  return score;
}

// ─── Common English stopwords ─────────────────────────

const STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "were",
  "they",
  "their",
  "them",
  "will",
  "would",
  "could",
  "should",
  "about",
  "there",
  "which",
  "what",
  "when",
  "where",
  "than",
  "then",
  "also",
  "just",
  "more",
  "some",
  "such",
  "only",
  "other",
  "into",
  "over",
  "very",
  "after",
  "before",
  "because",
  "between",
  "through",
  "during",
  "without",
  "within",
  "along",
  "these",
  "those",
  "page",
  "section",
  "note",
  "info",
  "type",
  "used",
  "using",
]);

// ─── Chunk-Level Indexing ────────────────────────────

interface PageChunk {
  /** The heading line (e.g. "## Configuration") or empty for the intro section */
  heading: string;
  /** Content of this chunk */
  content: string;
  /** Heading level (0 for intro, 1 for #, 2 for ##, etc.) */
  level: number;
}

/**
 * Split a page's body into chunks by headings.
 * Each heading and its following content become one chunk.
 * Content before the first heading becomes the intro chunk.
 */
function chunkPage(body: string): PageChunk[] {
  if (!body.trim()) return [];

  const chunks: PageChunk[] = [];
  const lines = body.split("\n");

  let currentHeading = "";
  let currentLevel = 0;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.trim().match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      // Save previous chunk
      if (currentContent.length > 0 || currentHeading) {
        chunks.push({
          heading: currentHeading,
          content: currentContent.join("\n").trim(),
          level: currentLevel,
        });
      }
      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Save last chunk
  if (currentContent.length > 0 || currentHeading) {
    chunks.push({
      heading: currentHeading,
      content: currentContent.join("\n").trim(),
      level: currentLevel,
    });
  }

  return chunks;
}

function pagePreview(content: string): string {
  const { body } = parseFrontmatter(content);
  return body.trim().slice(0, 200).replace(/\n/g, " ");
}

/**
 * Get a preview of the best-matching chunk, or fall back to the page intro.
 * Shows the heading (if any) and the first ~200 chars of content.
 */
function chunkPreview(heading: string, content: string): string {
  const trimmed = content.slice(0, 180).replace(/\n/g, " ");
  if (heading) {
    return `#${heading} — ${trimmed}`;
  }
  return trimmed;
}

/**
 * Extract distinctive terms from the top search results for query expansion.
 * Pseudo-relevance feedback: terms from top-matching pages that aren't in
 * the original query become expansion candidates.
 */
function extractExpansionTerms(
  scored: Scored[],
  originalQuery: string,
  paths: VaultPaths,
  maxTerms = 6,
): string[] {
  const topResults = scored.slice(0, Math.min(3, scored.length));
  if (topResults.length === 0) return [];

  const originalNorm = normalizeText(originalQuery);
  const termFreq = new Map<string, number>();

  for (const { pagePath, entry } of topResults) {
    // Collect text from registry metadata + file content
    const metaText = normalizeText(
      [entry.title, entry.aliases, entry.tags, entry.summary, entry.description]
        .filter(Boolean)
        .join(" "),
    );
    for (const w of metaText.split(/\s+/)) {
      if (w.length >= 4 && !originalNorm.includes(w) && !STOPWORDS.has(w)) {
        termFreq.set(w, (termFreq.get(w) || 0) + 1);
      }
    }

    // Also extract from file body
    if (existsSync(pagePath)) {
      const content = readFileSync(pagePath, "utf-8");
      const { body } = parseFrontmatter(content);
      const bodyNorm = normalizeText(body);
      for (const w of bodyNorm.split(/\s+/)) {
        if (w.length >= 4 && !originalNorm.includes(w) && !STOPWORDS.has(w)) {
          termFreq.set(w, (termFreq.get(w) || 0) + 1);
        }
      }
    }
  }

  // Sort by frequency descending, take top N
  return Array.from(termFreq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);
}

/**
 * Search a single vault's registry for pages matching a query.
 * Returns up to `maxResults` matches, each with a content preview.
 * Results below `minScore` are excluded (default 0 = no filtering).
 */
export function searchWiki(
  paths: VaultPaths,
  query: string,
  maxResults = 5,
  minScore = 0,
  semantic?: SemanticContext,
): RecallResult[] {
  const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
    version: "1.0",
    last_updated: "",
    pages: {},
  });

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  // Read this vault's precomputed embedding sidecar (synchronous, offline).
  // Missing/empty sidecar => no semantic signal => pure lexical, by construction.
  const embeddingStore: EmbeddingStore | undefined = semantic
    ? readEmbeddingStore(paths)
    : undefined;

  const scored: Scored[] = [];

  for (const [id, entry] of Object.entries(registry.pages)) {
    const pagePath = join(paths.wiki, `${id}.md`);
    const content = existsSync(pagePath) ? readFileSync(pagePath, "utf-8") : "";
    const { frontmatter, body } = parseFrontmatter(content);

    let score = 0;

    // Strong identifiers: exact command/short-query aliases should win.
    score += scoreField(id, terms, 3);
    score += scoreField(entry.title, terms, 5);
    score += scoreField(frontmatter.title, terms, 5);
    score += scoreField(entry.type, terms, 1);

    // Recall-oriented metadata. Arrays are supported by parseFrontmatter and
    // legacy comma/bracket strings still flatten into searchable text.
    score += scoreField(entry.aliases, terms, 6);
    score += scoreField(frontmatter.aliases, terms, 6);
    score += scoreField(entry.recall_triggers, terms, 7);
    score += scoreField(frontmatter.recall_triggers, terms, 7);
    score += scoreField(entry.summary, terms, 3);
    score += scoreField(frontmatter.summary, terms, 3);
    score += scoreField(entry.description, terms, 3);
    score += scoreField(frontmatter.description, terms, 3);

    // General metadata from the registry/frontmatter.
    score += scoreField(entry.tags, terms, 2);
    score += scoreField(entry.category, terms, 2);
    score += scoreField(entry.domain, terms, 2);
    score += scoreField(frontmatter.tags, terms, 2);
    score += scoreField(frontmatter.category, terms, 2);
    score += scoreField(frontmatter.domain, terms, 2);

    // Body search: use chunk-level indexing for more precise matching.
    // Each section of the page is scored independently, so a query about
    // "Postgres" matches only the Postgres section, not the whole page.
    let bestChunkScore = 0;
    let bestChunkHeading = "";
    let bestChunkContent = "";

    if (body.trim()) {
      const chunks = chunkPage(body);
      for (const chunk of chunks) {
        let chunkScore = 0;
        // Heading gets a strong boost
        chunkScore += scoreField(chunk.heading, terms, 4);
        // Chunk body content
        chunkScore += scoreField(chunk.content, terms, 1);

        if (chunkScore > bestChunkScore) {
          bestChunkScore = chunkScore;
          bestChunkHeading = chunk.heading;
          bestChunkContent = chunk.content;
        }
      }
    }

    // Add best chunk score to total page score
    score += bestChunkScore;

    // Semantic candidacy: a page with no lexical match can still qualify if its
    // precomputed vector is sufficiently close to the query vector. The boost
    // itself is applied AFTER pseudo-relevance feedback so PRF stays lexical.
    let semCos = 0;
    if (semantic && embeddingStore) {
      const vec = embeddingStore.entries[id]?.vector;
      if (vec && vec.length === semantic.queryVector.length) {
        semCos = cosineSimilarity(semantic.queryVector, vec);
      }
    }
    const semEligible = semCos >= SEMANTIC_MIN_COSINE;

    if (score > 0 || semEligible) {
      scored.push({
        id,
        entry,
        score,
        pagePath,
        bestChunkPreview: bestChunkContent ? chunkPreview(bestChunkHeading, bestChunkContent) : "",
        semCos,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // ── Pseudo-Relevance Feedback (PRF) ─────────────────
  // Extract distinctive terms from the top 3 results and use them to
  // boost semantically related pages. This gives "semantic" expansion
  // without external dependencies: if an "Authentication" page mentions
  // JWT, OAuth, and sessions, those terms boost other pages that discuss
  // related concepts.
  const expansionTerms = extractExpansionTerms(scored, query, paths, 6);
  if (expansionTerms.length > 0) {
    const expTermList = queryTerms(expansionTerms.join(" "));
    // Apply expansion scoring to the top 25 results (cheap re-read)
    const expansionCandidates = scored.slice(0, Math.min(25, scored.length));
    for (const item of expansionCandidates) {
      const content = existsSync(item.pagePath) ? readFileSync(item.pagePath, "utf-8") : "";
      const { body } = parseFrontmatter(content);
      let expChunkScore = 0;
      if (body.trim()) {
        const chunks = chunkPage(body);
        for (const chunk of chunks) {
          let cs = 0;
          cs += scoreField(chunk.heading, expTermList, 2); // half weight
          cs += scoreField(chunk.content, expTermList, 0.5);
          if (cs > expChunkScore) expChunkScore = cs;
        }
      }
      // Dampened addition — expansion contributes at most 40%
      item.score += expChunkScore * 0.4;
    }
  }

  // ── Semantic fusion ─────────────────────────────────
  // Blend the precomputed cosine similarity into the (lexical + PRF) score.
  // Applied last so PRF expansion remains purely lexical and so a strongly
  // paraphrase-relevant page that lexical missed can clear `minScore`. With no
  // semantic context every boost is 0, leaving the lexical ranking untouched.
  if (semantic) {
    for (const item of scored) {
      item.score = fuseScores(item.score, item.semCos, semantic.weight);
    }
  }

  // Re-sort after expansion + semantic scoring
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const top = scored.filter((s) => s.score >= minScore).slice(0, maxResults);

  return top.map(({ id, entry, pagePath, score, bestChunkPreview }) => {
    let preview = bestChunkPreview;
    if (!preview && existsSync(pagePath)) {
      // Fallback: no chunk matched, show page intro
      preview = pagePreview(readFileSync(pagePath, "utf-8"));
    }

    return {
      id,
      title: String(entry.title || id),
      type: String(entry.type || "page"),
      preview,
      path: pagePath,
      score,
    };
  });
}

/**
 * Search both project/primary vault and personal vault, merging results.
 * Personal results are appended after primary results, deduplicated by page ID.
 *
 * @param minScore - Minimum relevance score (default 0 = no filter).
 * @param includePersonal - Whether to search the personal vault (default true).
 *   Auto-injection should pass false to avoid personal-vault contamination.
 */
export function searchWikiLayered(
  primaryPaths: VaultPaths,
  query: string,
  maxResults = 5,
  minScore = 0,
  includePersonal = true,
  semantic?: SemanticContext,
): RecallResult[] {
  // Search primary vault
  const primaryResults = searchWiki(primaryPaths, query, maxResults, minScore, semantic);

  // If primary is already the personal vault, no layered search needed
  if (isPersonalVault(primaryPaths)) return primaryResults;

  // Search personal vault as secondary layer (only when explicitly requested)
  let personalResults: RecallResult[] = [];
  if (includePersonal) {
    const personalPaths = getPersonalWikiPaths();
    if (existsSync(join(personalPaths.dotWiki, "config.json"))) {
      personalResults = searchWiki(personalPaths, query, maxResults, minScore, semantic);
    }
  }

  // Merge: personal results first (they're the user's accumulated knowledge),
  // then primary results (project-specific). Deduplicate by page ID.
  const seen = new Set<string>();
  const merged: RecallResult[] = [];

  for (const r of [...personalResults, ...primaryResults]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    // If it's from personal vault, tag it
    if (personalResults.includes(r)) {
      merged.push({ ...r, vaultLabel: "📓 personal" });
    } else {
      merged.push(r);
    }
  }

  return merged.slice(0, maxResults);
}

// ─── Async hybrid entry point (the single, cached query embedding) ───

/**
 * Cache of query string → normalized embedding vector. The query embedding is
 * the ONLY embedding call in the recall hot path; caching collapses repeated
 * recalls of the same query within a session (e.g. auto-injection + an explicit
 * wiki_recall) into a single network call, satisfying the #67 "single cached
 * query-embedding lookup" bound.
 */
const queryEmbeddingCache = new Map<string, number[]>();
const QUERY_CACHE_MAX = 256;

function queryCacheKey(model: string, query: string): string {
  return `${model}\u0000${normalizeText(query)}`;
}

/** Test-only: reset the module-level query-embedding cache. */
export function __clearQueryEmbeddingCache(): void {
  queryEmbeddingCache.clear();
}

/** True if a vault has at least one stored embedding vector. */
function storeHasEntries(paths: VaultPaths): boolean {
  return Object.keys(readEmbeddingStore(paths).entries).length > 0;
}

/**
 * Embed the query string once (cached), returning a normalized vector, or
 * `undefined` when no embedder is configured or the call yields nothing.
 */
async function embedQuery(embedder: Embedder, query: string): Promise<number[] | undefined> {
  const key = queryCacheKey(embedder.model, query);
  const cached = queryEmbeddingCache.get(key);
  if (cached) return cached;

  const [raw] = await embedder.embed([query]);
  if (!raw || raw.length === 0) return undefined;
  const vec = normalizeVector(raw);

  if (queryEmbeddingCache.size >= QUERY_CACHE_MAX) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest !== undefined) queryEmbeddingCache.delete(oldest);
  }
  queryEmbeddingCache.set(key, vec);
  return vec;
}

/**
 * Hybrid layered recall: lexical scoring blended with semantic cosine ranking.
 *
 * Design (issue #67): page vectors are precomputed at write time (#66); the
 * ONLY per-query embedding work is a single, cached lookup of the (short) query
 * string. If no vault has embeddings, the query embedding is skipped entirely
 * and this degrades to exactly `searchWikiLayered` (pure lexical, zero network).
 * Likewise when no embedder is configured. `opts.embedder` is an injection seam
 * for tests (mirrors `embedPages`) so unit tests never touch the network.
 */
export async function searchWikiHybrid(
  primaryPaths: VaultPaths,
  query: string,
  maxResults = 5,
  minScore = 0,
  includePersonal = true,
  opts: { config?: TaskConfig; embedder?: Embedder } = {},
): Promise<RecallResult[]> {
  // Pure-lexical fast path: no semantic signal anywhere => no embedding call.
  let anyEmbeddings = storeHasEntries(primaryPaths);
  if (!anyEmbeddings && includePersonal && !isPersonalVault(primaryPaths)) {
    const personalPaths = getPersonalWikiPaths();
    if (existsSync(join(personalPaths.dotWiki, "config.json"))) {
      anyEmbeddings = storeHasEntries(personalPaths);
    }
  }
  if (!anyEmbeddings) {
    return searchWikiLayered(primaryPaths, query, maxResults, minScore, includePersonal);
  }

  const embedder = opts.embedder ?? (opts.config ? resolveEmbedder(opts.config) : undefined);
  if (!embedder) {
    // Embeddings exist but no embedder configured to embed the query: fall back
    // to pure lexical rather than guess. (Degrades gracefully.)
    return searchWikiLayered(primaryPaths, query, maxResults, minScore, includePersonal);
  }

  let semantic: SemanticContext | undefined;
  try {
    const queryVector = await embedQuery(embedder, query);
    if (queryVector) {
      const weight = opts.config?.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT;
      semantic = { queryVector, weight };
    }
  } catch {
    // Network/embedding failure must never break recall — fall back to lexical.
    semantic = undefined;
  }

  return searchWikiLayered(primaryPaths, query, maxResults, minScore, includePersonal, semantic);
}

/**
 * Default page-count gate for two-stage (links-first) recall (issue #68).
 * When a vault's registered page count exceeds this, recall returns ranked
 * links (expand on demand via `read`) instead of inline content previews.
 */
export const DEFAULT_RECALL_LINKS_THRESHOLD = 50;

/** Max characters of the 1-line snippet shown beside a link in links-first mode. */
const LINKS_SNIPPET_MAX = 80;

/** Count the registered pages of a single vault (O(1), no page-body I/O). */
function registryPageCount(paths: VaultPaths): number {
  const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
    version: "1.0",
    last_updated: "",
    pages: {},
  });
  return Object.keys(registry.pages).length;
}

/**
 * Total registered page count across the vault(s) recall will actually search.
 * Mirrors `searchWikiLayered`'s vault selection so the two-stage gate is keyed
 * to the same corpus the agent sees. Reads only `registry.json` — never a page
 * body — so the gate stays cheap as the vault grows.
 */
export function vaultPageCount(primaryPaths: VaultPaths, includePersonal = true): number {
  let count = registryPageCount(primaryPaths);
  if (includePersonal && !isPersonalVault(primaryPaths)) {
    const personalPaths = getPersonalWikiPaths();
    if (existsSync(join(personalPaths.dotWiki, "config.json"))) {
      count += registryPageCount(personalPaths);
    }
  }
  return count;
}

/**
 * Decide whether recall should use links-first (stage 1) rendering: true when
 * the vault page count is STRICTLY GREATER THAN the configured threshold.
 * Threshold 0 forces links-first for any non-empty vault; a very large value
 * keeps previews inline always. Default `DEFAULT_RECALL_LINKS_THRESHOLD`.
 */
export function shouldUseLinksFirst(pageCount: number, config?: TaskConfig): boolean {
  const threshold = config?.recallLinksThreshold ?? DEFAULT_RECALL_LINKS_THRESHOLD;
  return pageCount > threshold;
}

/** One-line snippet for links-first rendering, derived from the chunk preview. */
function linkSnippet(preview: string): string {
  const oneLine = preview.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > LINKS_SNIPPET_MAX ? `${oneLine.slice(0, LINKS_SNIPPET_MAX)}…` : oneLine;
}

/** Max chars of a skill/case body inlined directly into the recall block. */
const SKILL_INLINE_MAX = 1600;

/**
 * Skills/working-memory carve-out from links-first: short, high-value
 * procedural pages (`skill`/`case`) are meant to be APPLIED immediately, so we
 * inline their body directly rather than make the agent expand a link it often
 * skips (adherence > context-economy for these page types). Returns null for
 * non-skill pages or when the body can't be read.
 */
function isSkillOrCase(r: RecallResult): boolean {
  return (
    r.type === "skill" ||
    r.type === "case" ||
    r.id.startsWith("skills/") ||
    r.id.startsWith("cases/")
  );
}

function inlineSkillBody(r: RecallResult): string | null {
  if (!isSkillOrCase(r)) return null;
  if (!r.path || !existsSync(r.path)) return null;
  let body = readFileSync(r.path, "utf-8");
  body = body.replace(/^---\n[\s\S]*?\n---\n/, "").trim(); // strip YAML frontmatter
  if (!body) return null;
  if (body.length > SKILL_INLINE_MAX) {
    body = `${body.slice(0, SKILL_INLINE_MAX)}\n…(truncated — \`read\` the path above for the full page)`;
  }
  return body;
}

/**
 * Format recall results as a compact system-prompt section.
 *
 * Two render modes (issue #68):
 * - Default / `linksOnly: false` — preview-inline (unchanged for small vaults).
 * - `linksOnly: true` — stage-1 "links-first": a ranked list of links carrying
 *   id, title, type, score, and a single short snippet. The agent expands the
 *   links it wants on demand via `read` (stage 2). Used above the vault-size
 *   threshold to keep large vaults from flooding context.
 */
export function formatRecallContext(
  results: RecallResult[],
  opts: { linksOnly?: boolean } = {},
): string {
  if (results.length === 0) return "";

  const hasLayered = results.some((r) => r.vaultLabel);
  const label = hasLayered ? " (personal + project)" : "";
  // Salience nudge: when a distilled skill/case matches, tell the agent to
  // apply it BEFORE experimenting (the dominant cost is recall non-adherence).
  const hasSkill = results.some(isSkillOrCase);
  const skillNudge =
    "⚠\ufe0f A distilled skill/case below matches this task — read and APPLY it BEFORE experimenting on your own.";

  if (opts.linksOnly) {
    const lines: string[] = [
      "## Relevant Wiki Knowledge (links-first)",
      "",
      `_${results.length} page(s) matched your query${label}, ranked. Two-stage recall: links only — open the ones you need to read their full content._`,
      "",
    ];

    if (hasSkill) lines.splice(1, 0, "", skillNudge);
    results.forEach((r, i) => {
      const vaultTag = r.vaultLabel ? ` ${r.vaultLabel}` : "";
      const snippet = linkSnippet(r.preview);
      const tail = snippet ? ` — ${snippet}` : "";
      lines.push(
        `${i + 1}. **[[${r.id}]]** — *${r.type}* — score ${r.score.toFixed(1)}${vaultTag} — ${r.title}${tail}`,
      );
      // Surface a read-resolvable path so expansion is a single, first-try
      // `read` (issue: wikilink ids aren't resolvable by the file read tool).
      if (r.path) lines.push(`   ↳ \`read ${r.path}\``);
      // Skills/case carve-out: inline the body so the agent doesn't have to
      // (and often won't) expand the link before acting.
      const inl = inlineSkillBody(r);
      if (inl) lines.push("", "   \`\`\`", ...inl.split("\n").map((x) => `   ${x}`), "   \`\`\`");
    });

    lines.push(
      "",
      "Call `read` on the exact path shown under each link to pull its full content." +
        " Add new findings via wiki_ensure_page or wiki_retro.",
      "",
    );

    return lines.join("\n");
  }

  const lines: string[] = [
    "## Relevant Wiki Knowledge",
    "",
    `_${results.length} page(s) matched your query${label}._`,
    "",
  ];

  if (hasSkill) lines.splice(1, 0, "", skillNudge);
  for (const r of results) {
    const vaultTag = r.vaultLabel ? ` ${r.vaultLabel}` : "";
    lines.push(`- **[[${r.id}]]** — *${r.type}* — ${r.title}${vaultTag}`);
    // Read-resolvable path so the agent expands in one first-try `read`
    // instead of guessing the file location from the wikilink id.
    if (r.path) lines.push(`  ↳ \`read ${r.path}\``);
    // Skills/case carve-out: inline the body (adherence > context-economy).
    const inl = inlineSkillBody(r);
    if (inl) {
      lines.push("", "  ```", ...inl.split("\n").map((x) => `  ${x}`), "  ```");
    } else if (r.preview) {
      // Truncate preview to one line
      const preview = r.preview.length > 120 ? `${r.preview.slice(0, 120)}…` : r.preview;
      lines.push(`  ${preview}`);
    }
    lines.push("");
  }

  lines.push(
    "Use `read` on the exact path shown under each link to view its full page." +
      " Add new findings via wiki_ensure_page or wiki_retro.",
    "",
  );

  return lines.join("\n");
}

// ─── Tool Registration ──────────────────────────────────

/**
 * Register the `wiki_recall` tool.
 * The model can call this explicitly to search the wiki.
 * It is also called automatically via before_agent_start hook.
 */
export function registerWikiRecall(pi: ExtensionAPI, runtime?: Runtime): void {
  pi.registerTool({
    name: "wiki_recall",
    label: "Wiki Recall",
    description:
      "Search the wiki for pages relevant to a query. " +
      "Returns matching page IDs, titles, types, and content previews (small vaults) " +
      "or a ranked list of links to expand with `read` (large vaults, two-stage recall). " +
      "Called automatically at session start — use explicitly to dig deeper.",
    promptSnippet: "Recall wiki knowledge relevant to the current task",
    promptGuidelines: [
      "Use wiki_recall at the START of every task to find relevant wiki knowledge.",
      "The extension auto-calls wiki_recall — but calling it explicitly with specific terms gets better results.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query — use the user's full request or key terms",
      }),
      max_results: Type.Optional(
        Type.Number({ description: "Max results (default: 5, max: 10)", default: 5 }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = resolveVaultPaths(ctx.cwd ?? process.cwd());

      if (!existsSync(join(paths.dotWiki, "config.json"))) {
        return {
          content: [
            {
              type: "text",
              text: "No wiki vault found at this location. Initialize one with wiki_bootstrap first.",
            },
          ],
          details: { error: "no_vault" } as Record<string, unknown>,
          isError: true,
        };
      }

      const maxResults = Math.min(params.max_results ?? 5, 10);
      // Use layered hybrid search: personal vault + project vault, blending
      // lexical scoring with precomputed semantic embeddings when available.
      // No embeddings / no embedder => pure lexical, no network call.
      if (runtime) runtime.ensureConfig(ctx.cwd ?? paths.root);
      const results = await searchWikiHybrid(paths, params.query, maxResults, 0, true, {
        config: runtime?.config,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No wiki pages found matching "${params.query}". The wiki is empty — use wiki_retro to start building knowledge.`,
            },
          ],
          details: { query: params.query, matches: [] } as Record<string, unknown>,
        };
      }

      const hasPersonal = results.some((r) => r.vaultLabel);
      const layerTag = hasPersonal ? " (personal + project)" : "";

      // Two-stage gate (issue #68): large vaults return ranked LINKS only;
      // the agent expands chosen links on demand via `read`. Small vaults keep
      // the inline-preview behavior. Page count is read from the registry only.
      const linksFirst = shouldUseLinksFirst(vaultPageCount(paths, true), runtime?.config);

      if (linksFirst) {
        const linkLines = results
          .map((r, i) => {
            const vault = r.vaultLabel ? ` ${r.vaultLabel}` : "";
            const snippet = linkSnippet(r.preview);
            const tail = snippet ? ` — ${snippet}` : "";
            return `${i + 1}. [[${r.id}]] — ${r.title} (${r.type}, score ${r.score.toFixed(1)})${vault}\n   Path: ${r.path}${tail}`;
          })
          .join("\n");
        const text = [
          `Found ${results.length} wiki page(s) matching "${params.query}"${layerTag} (two-stage recall — ranked links, expand on demand):`,
          "",
          linkLines,
          "",
          "Call `read` on the path(s) you need to pull full content.",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: { query: params.query, mode: "links", matches: results } as Record<
            string,
            unknown
          >,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} wiki page(s) matching "${params.query}"${layerTag}:\n\n${results
              .map((r) => {
                const vault = r.vaultLabel ? ` ${r.vaultLabel}` : "";
                return `## [[${r.id}]] — ${r.title}${vault}\nType: ${r.type}\nPath: ${r.path}\n\n${r.preview}`;
              })
              .join("\n\n---\n\n")}`,
          },
        ],
        details: { query: params.query, mode: "preview", matches: results } as Record<
          string,
          unknown
        >,
      };
    },
  });
}
