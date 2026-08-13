export const BENCHMARK_VERSION = 1;

export type BenchmarkRole = "canonical" | "evidence";
export type BenchmarkSplit = "train" | "heldout";
export type AutoExpectation = "hit" | "none";

export interface BenchmarkPage {
  id: string;
  type: string;
  title: string;
  body: string;
  aliases?: string[];
  tags?: string[];
  status?: "draft" | "stable" | "deprecated";
}

export interface BenchmarkJudgment {
  pageId: string;
  grade: 1 | 2 | 3;
  role: BenchmarkRole;
}

export interface BenchmarkQuery {
  id: string;
  text: string;
  category:
    | "exact_lookup"
    | "entity_alias"
    | "paraphrase"
    | "vague_recollection"
    | "conceptual"
    | "graph_scope"
    | "evidence_request"
    | "temporal"
    | "contradiction"
    | "conclusion"
    | "synthesis"
    | "negative";
  split: BenchmarkSplit;
  judgments: BenchmarkJudgment[];
  autoExpectation: AutoExpectation;
  expectedConflicts?: string[];
}

export const benchmarkPages: BenchmarkPage[] = [
  {
    id: "entities/qmd",
    type: "entity",
    title: "QMD",
    aliases: ["Query Markup Documents"],
    tags: ["retrieval", "markdown"],
    status: "stable",
    body: "QMD is an on-device Markdown search engine combining BM25, vector retrieval, reciprocal-rank fusion, and local reranking.",
  },
  {
    id: "concepts/reciprocal-rank-fusion",
    type: "concept",
    title: "Reciprocal Rank Fusion",
    aliases: ["RRF"],
    tags: ["retrieval", "ranking"],
    body: "Reciprocal Rank Fusion combines independently ranked lists by rank instead of adding incomparable BM25 and cosine scores.",
  },
  {
    id: "concepts/hybrid-retrieval",
    type: "concept",
    title: "Hybrid Retrieval",
    tags: ["bm25", "embeddings"],
    body: "Hybrid retrieval joins lexical matching for exact terms with dense semantic retrieval for paraphrases and vague recollection.",
  },
  {
    id: "concepts/canonical-memory-cards",
    type: "concept",
    title: "Canonical Memory Cards",
    tags: ["zettelkasten", "memory"],
    body: "A reviewed canonical card should be returned before raw observations, with source evidence preserved behind the card.",
  },
  {
    id: "concepts/zettelkasten",
    type: "concept",
    title: "Zettelkasten",
    aliases: ["card box method", "卡片盒笔记法"],
    body: "Zettelkasten organizes atomic permanent notes and meaningful links. It is a knowledge model, not a search ranking algorithm.",
  },
  {
    id: "concepts/obsidian-graph-view",
    type: "concept",
    title: "Obsidian Graph View",
    body: "Obsidian Graph View helps people inspect links, clusters, and orphan notes. It visualizes existing links but does not improve machine search relevance by itself.",
  },
  {
    id: "concepts/wiki-reindex",
    type: "concept",
    title: "Wiki Reindexing",
    aliases: ["wiki_reindex"],
    body: "Reindexing rescans valid Markdown, refreshes lexical state, embeds stale chunks, removes deleted pages, and keeps the last usable index if rebuilding fails.",
  },
  {
    id: "concepts/node-runtime-policy",
    type: "concept",
    title: "Node Runtime Policy",
    body: "The QMD-backed major requires Node.js 22 or newer. Users requiring Node.js 18 remain on the previous package major.",
  },
  {
    id: "concepts/conflict-preservation",
    type: "concept",
    title: "Memory Conflict Preservation",
    body: "Conflicting claims remain stored with their evidence. Recall shows both and asks the user which scope or claim applies instead of silently choosing.",
  },
  {
    id: "concepts/retrieval-feedback",
    type: "concept",
    title: "Retrieval Feedback",
    body: "Explicit corrections are strong signals. Opened, cited, and shown-only events are weaker, bounded, decaying signals and never rewrite facts.",
  },
  {
    id: "concepts/query-expansion",
    type: "concept",
    title: "Query Expansion",
    body: "Query expansion may improve broad questions but can drift. Adaptive retrieval escalates only uncertain results while exact identifiers bypass expansion.",
  },
  {
    id: "concepts/validated-index-mirror",
    type: "concept",
    title: "Validated Index Mirror",
    body: "QMD indexes a generated mirror containing only pages accepted by the shared Markdown parser, so malformed pages cannot influence candidate generation.",
  },
  {
    id: "syntheses/second-brain-retrieval",
    type: "synthesis",
    title: "Second-Brain Retrieval Architecture",
    body: "The strongest second-brain design combines QMD candidate retrieval with canonical-card prioritization, source evidence, contradiction assembly, bounded feedback, and measured evaluation.",
  },
  {
    id: "analyses/qmd-adoption-decision",
    type: "analysis",
    title: "QMD Adoption Decision",
    body: "The project chose QMD as the first-class retrieval engine rather than rebuilding BM25, vector search, RRF, and local reranking.",
  },
  {
    id: "sources/qmd-2-5-3-release",
    type: "source",
    title: "QMD 2.5.3 Release Evidence",
    body: "The published QMD 2.5.3 package requires Node.js 22, exposes a TypeScript SDK, and supports model-free searchLex plus model-backed vector and reranking calls.",
  },
  {
    id: "sources/vault-audit",
    type: "source",
    title: "Vault Retrieval Audit",
    body: "The audited vault had hundreds of source observations, few canonical concepts, almost no retrieval metadata, and no active embedding sidecar.",
  },
  {
    id: "sources/user-card-first-decision",
    type: "source",
    title: "Card-First User Decision",
    body: "The user selected canonical atomic cards first, with observations retained as evidence rather than mixed equally in recall.",
  },
  {
    id: "sources/reindex-failure-recovery",
    type: "source",
    title: "Reindex Recovery Requirement",
    body: "A failed full rebuild must preserve the previous closed database artifact and report stale derived state instead of deleting the usable index.",
  },
  {
    id: "sources/node-22-decision",
    type: "source",
    title: "Node 22 Major-Version Decision",
    body: "The user approved a clean major-version break to Node.js 22 so QMD can be a first-class dependency.",
  },
  {
    id: "sources/old-conflicting-claim",
    type: "source",
    title: "Older Conflicting Claim",
    body: "An older note says raw observations should always outrank synthesized cards because they are closer to original evidence.",
  },
  {
    id: "sources/new-conflicting-claim",
    type: "source",
    title: "Newer Conflicting Claim",
    body: "A newer reviewed decision says canonical cards should rank first while raw observations remain attached evidence.",
  },
  {
    id: "sources/feedback-evaluation",
    type: "source",
    title: "Feedback Evaluation Evidence",
    body: "Click and open behavior is position-biased, so implicit engagement must remain a tiny supplementary signal rather than factual ground truth.",
  },
];

interface QueryGroup {
  key: string;
  category: BenchmarkQuery["category"];
  split: BenchmarkSplit;
  texts: [string, string, string, string, string];
  judgments: BenchmarkJudgment[];
  autoExpectation?: AutoExpectation;
  expectedConflicts?: string[];
}

const canonical = (pageId: string, grade: 1 | 2 | 3 = 3): BenchmarkJudgment => ({
  pageId,
  grade,
  role: "canonical",
});

const evidence = (pageId: string, grade: 1 | 2 | 3 = 2): BenchmarkJudgment => ({
  pageId,
  grade,
  role: "evidence",
});

const groups: QueryGroup[] = [
  {
    key: "qmd-exact",
    category: "exact_lookup",
    split: "train",
    texts: [
      "QMD",
      "Query Markup Documents",
      "QMD Markdown search engine",
      "find the QMD note",
      "QMD BM25 vector reranker",
    ],
    judgments: [canonical("entities/qmd"), evidence("sources/qmd-2-5-3-release")],
  },
  {
    key: "qmd-entity",
    category: "entity_alias",
    split: "train",
    texts: [
      "what tool is abbreviated QMD",
      "the local document search tool",
      "which entity provides local Markdown retrieval",
      "QMD full name",
      "on-device search for Markdown notes",
    ],
    judgments: [canonical("entities/qmd"), canonical("analyses/qmd-adoption-decision", 2)],
  },
  {
    key: "hybrid-paraphrase",
    category: "paraphrase",
    split: "heldout",
    texts: [
      "combine exact words with meaning based search",
      "find notes when I remember different wording",
      "keyword plus semantic document lookup",
      "search using both literal terms and concepts",
      "mix sparse and dense retrieval",
    ],
    judgments: [
      canonical("concepts/hybrid-retrieval"),
      canonical("concepts/reciprocal-rank-fusion", 1),
    ],
  },
  {
    key: "cards-vague",
    category: "vague_recollection",
    split: "train",
    texts: [
      "the decision about useful memory before noisy notes",
      "what should the AI remember first",
      "reviewed conclusion with proof behind it",
      "stop raw observations drowning good knowledge",
      "card first memory organization",
    ],
    judgments: [
      canonical("concepts/canonical-memory-cards"),
      evidence("sources/user-card-first-decision"),
    ],
  },
  {
    key: "zettelkasten-concept",
    category: "conceptual",
    split: "train",
    texts: [
      "what is Zettelkasten",
      "is Zettelkasten a search algorithm",
      "atomic permanent notes and meaningful links",
      "什么是卡片盒笔记法",
      "zettelkasten 是搜索算法吗",
    ],
    judgments: [canonical("concepts/zettelkasten")],
  },
  {
    key: "obsidian-graph",
    category: "graph_scope",
    split: "heldout",
    texts: [
      "does Obsidian graph improve search ranking",
      "what is graph view useful for",
      "find orphan notes visually",
      "can the Obsidian graph replace retrieval",
      "human link visualization versus machine relevance",
    ],
    judgments: [canonical("concepts/obsidian-graph-view")],
  },
  {
    key: "reindex-evidence",
    category: "evidence_request",
    split: "train",
    texts: [
      "how do I rebuild a stale wiki search index",
      "what evidence says failed reindex keeps the old database",
      "refresh lexical documents and stale vectors",
      "remove deleted notes from search",
      "wiki_reindex recovery requirement",
    ],
    judgments: [canonical("concepts/wiki-reindex"), evidence("sources/reindex-failure-recovery")],
  },
  {
    key: "node-temporal",
    category: "temporal",
    split: "train",
    texts: [
      "which Node version does the next major require",
      "can Node 18 use the QMD major",
      "current runtime decision for QMD",
      "why did the project move to Node 22",
      "published QMD package Node requirement",
    ],
    judgments: [canonical("concepts/node-runtime-policy"), evidence("sources/node-22-decision")],
  },
  {
    key: "memory-conflict",
    category: "contradiction",
    split: "heldout",
    texts: [
      "what happens when two memories disagree",
      "raw observations or canonical cards should rank first",
      "show both conflicting claims",
      "which note superseded the older ranking claim",
      "do not silently resolve contradictory memory",
    ],
    judgments: [
      canonical("concepts/conflict-preservation"),
      evidence("sources/old-conflicting-claim", 3),
      evidence("sources/new-conflicting-claim", 3),
    ],
    expectedConflicts: ["sources/old-conflicting-claim", "sources/new-conflicting-claim"],
  },
  {
    key: "feedback-conclusion",
    category: "conclusion",
    split: "train",
    texts: [
      "what did we conclude about retrieval feedback",
      "should ignored search results change facts",
      "how strong is an opened-result signal",
      "explicit correction versus implicit engagement",
      "position bias in second-brain feedback",
    ],
    judgments: [canonical("concepts/retrieval-feedback"), evidence("sources/feedback-evaluation")],
  },
  {
    key: "architecture-synthesis",
    category: "synthesis",
    split: "train",
    texts: [
      "best architecture for an AI second brain",
      "combine QMD with canonical evidence memory",
      "full retrieval design summary",
      "why QMD alone is not enough",
      "candidate search plus wiki memory semantics",
    ],
    judgments: [
      canonical("syntheses/second-brain-retrieval"),
      canonical("analyses/qmd-adoption-decision", 2),
    ],
  },
  {
    key: "unrelated-negative",
    category: "negative",
    split: "train",
    texts: [
      "Flipkart casual mens wear",
      "Razorpay webhook endpoint",
      "hotel trial balance audit",
      "exercise deletion in an admin panel",
      "sales register round off convention",
    ],
    judgments: [],
    autoExpectation: "none",
  },
];

export const benchmarkQueries: BenchmarkQuery[] = groups.flatMap((group) =>
  group.texts.map((text, index) => ({
    id: `${group.key}-${index + 1}`,
    text,
    category: group.category,
    split: group.split,
    judgments: group.judgments.map((judgment) => ({ ...judgment })),
    autoExpectation: group.autoExpectation ?? "hit",
    expectedConflicts: group.expectedConflicts ? [...group.expectedConflicts] : undefined,
  })),
);
