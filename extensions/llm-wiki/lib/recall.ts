import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { Registry } from "./metadata.js";
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
};

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
): RecallResult[] {
  const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
    version: "1.0",
    last_updated: "",
    pages: {},
  });

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

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

    if (score > 0) {
      scored.push({
        id,
        entry,
        score,
        pagePath,
        bestChunkPreview: bestChunkContent ? chunkPreview(bestChunkHeading, bestChunkContent) : "",
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

  // Re-sort after expansion scoring
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
): RecallResult[] {
  // Search primary vault
  const primaryResults = searchWiki(primaryPaths, query, maxResults, minScore);

  // If primary is already the personal vault, no layered search needed
  if (isPersonalVault(primaryPaths)) return primaryResults;

  // Search personal vault as secondary layer (only when explicitly requested)
  let personalResults: RecallResult[] = [];
  if (includePersonal) {
    const personalPaths = getPersonalWikiPaths();
    if (existsSync(join(personalPaths.dotWiki, "config.json"))) {
      personalResults = searchWiki(personalPaths, query, maxResults, minScore);
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

/**
 * Format recall results as a compact system-prompt section.
 */
export function formatRecallContext(results: RecallResult[]): string {
  if (results.length === 0) return "";

  const hasLayered = results.some((r) => r.vaultLabel);
  const label = hasLayered ? " (personal + project)" : "";

  const lines: string[] = [
    "## Relevant Wiki Knowledge",
    "",
    `_${results.length} page(s) matched your query${label}._`,
    "",
  ];

  for (const r of results) {
    const vaultTag = r.vaultLabel ? ` ${r.vaultLabel}` : "";
    lines.push(`- **[[${r.id}]]** — *${r.type}* — ${r.title}${vaultTag}`);
    if (r.preview) {
      // Truncate preview to one line
      const preview = r.preview.length > 120 ? `${r.preview.slice(0, 120)}…` : r.preview;
      lines.push(`  ${preview}`);
    }
    lines.push("");
  }

  lines.push(
    "Use `read` to view full pages. Add new findings via wiki_ensure_page or wiki_retro.",
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
export function registerWikiRecall(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_recall",
    label: "Wiki Recall",
    description:
      "Search the wiki for pages relevant to a query. " +
      "Returns matching page IDs, titles, types, and content previews. " +
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
      // Use layered search: personal vault + project vault
      const results = searchWikiLayered(paths, params.query, maxResults);

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
        details: { query: params.query, matches: results } as Record<string, unknown>,
      };
    },
  });
}
