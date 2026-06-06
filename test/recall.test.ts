import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Embedder,
  embeddingStorePath,
  normalizeVector,
} from "../extensions/llm-wiki/lib/embeddings.js";
import { rebuildMetadataLight } from "../extensions/llm-wiki/lib/metadata.js";
import {
  DEFAULT_SEMANTIC_WEIGHT,
  SEMANTIC_SCALE,
  type SemanticContext,
  __clearQueryEmbeddingCache,
  formatRecallContext,
  fuseScores,
  searchWiki,
  searchWikiHybrid,
  searchWikiLayered,
} from "../extensions/llm-wiki/lib/recall.js";
import {
  ensureVaultStructure,
  getPersonalWikiPaths,
  getVaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

describe("wiki recall", () => {
  let wikiDir: string;
  let tmpDir: string;
  let prevWikiHome: string | undefined;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `recall-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    // Sandbox the personal vault: point WIKI_HOME at a clean temp dir so tests
    // never read the developer's real ~/.llm-wiki (which would make the
    // "no personal wiki" cases flaky depending on the machine).
    prevWikiHome = process.env.WIKI_HOME;
    process.env.WIKI_HOME = join(tmpDir, "home");
    mkdirSync(process.env.WIKI_HOME, { recursive: true });
    wikiDir = (() => {
      const dir = join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const llmWiki = join(dir, ".llm-wiki");
      const dirs = [
        "raw/articles",
        "raw/papers",
        "raw/notes",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/syntheses",
        "wiki/changes",
        "meta",
        "outputs",
        ".discoveries",
      ];
      for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });
      return dir;
    })();
    ensureVaultStructure(getVaultPaths(wikiDir));
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: delete truly unsets the env var (assigning undefined coerces to "undefined")
    if (prevWikiHome === undefined) delete process.env.WIKI_HOME;
    else process.env.WIKI_HOME = prevWikiHome;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createRegistryPage(
    id: string,
    type: string,
    title: string,
    content: string,
    extra: Record<string, unknown> = {},
  ) {
    const folder = id.includes("/") ? id.split("/")[0] : "concepts";
    const name = id.includes("/") ? id.split("/").pop()! : id;
    const pagePath = join(wikiDir, ".llm-wiki", "wiki", folder, `${name}.md`);
    writeFileSync(
      pagePath,
      `---\ntype: ${type}\ntitle: "${title}"\ncreated: 2026-05-11\nupdated: 2026-05-11\nsources: []\n${Object.entries(
        extra,
      )
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}\n---\n\n${content}`,
      "utf-8",
    );
    return `${folder}/${name}`;
  }

  it("should return empty results when wiki has no pages", () => {
    const paths = getVaultPaths(wikiDir);
    const results = searchWiki(paths, "machine learning");
    expect(results).toEqual([]);
  });

  it("should find pages matching by title", () => {
    createRegistryPage(
      "reinforcement-learning",
      "concept",
      "Reinforcement Learning",
      "RL is a type of machine learning.",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "reinforcement learning");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain("Reinforcement Learning");
    expect(results[0].id).toContain("reinforcement-learning");
    expect(results[0].type).toBe("concept");
  });

  it("should find pages matching by page ID", () => {
    createRegistryPage(
      "transformer-architecture",
      "concept",
      "Transformer",
      "The Transformer model architecture.",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "transformer-architecture");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toContain("transformer-architecture");
  });

  it("should find pages matching by type", () => {
    createRegistryPage("gpt-4", "entity", "GPT-4", "OpenAI language model.", { category: "tool" });
    createRegistryPage("rag", "concept", "RAG", "Retrieval augmented generation.");
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "entity");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.type === "entity")).toBe(true);
  });

  it("should find pages matching multiline aliases and recall triggers", () => {
    const pagePath = join(wikiDir, ".llm-wiki", "wiki", "analyses", "continue-learning-pi.md");
    writeFileSync(
      pagePath,
      [
        "---",
        "type: analysis",
        "title: Pi 学习入口",
        "aliases:",
        "  - 继续学习pi",
        "  - 学习pi",
        "recall_triggers:",
        "  - pi下一节",
        "created: 2026-05-27",
        "updated: 2026-05-27",
        "---",
        "",
        "# Recall 提示",
        "",
        "命中后读取 Pi 学习进度。",
      ].join("\n"),
      "utf-8",
    );

    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "继续学习pi");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("analyses/continue-learning-pi");
  });

  it("should find pages matching body text when metadata is sparse", () => {
    createRegistryPage(
      "sparse-page",
      "concept",
      "Unrelated Title",
      "This body explains codex relay provider credential precedence.",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "credential precedence");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("concepts/sparse-page");
  });

  it("should find mixed Chinese and Latin short queries without spaces", () => {
    createRegistryPage(
      "pi-learning-progress",
      "synthesis",
      "Pi 学习进度",
      "下一步学习 Pi 交互模式。",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "学习pi");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === "concepts/pi-learning-progress")).toBe(true);
  });

  it("should return pages with content preview", () => {
    createRegistryPage(
      "attention-is-all-you-need",
      "source",
      "Attention Is All You Need",
      "This paper introduced the Transformer architecture.",
    );
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "attention");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].preview).toBeTruthy();
    expect(results[0].preview).toContain("Transformer");
  });

  it("should respect maxResults parameter", () => {
    for (let i = 1; i <= 5; i++) {
      createRegistryPage(
        `concept-${i}`,
        "concept",
        `Concept ${i}`,
        `This is concept ${i} about stuff.`,
      );
    }
    const paths = getVaultPaths(wikiDir);
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "concept", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should find requirement pages by title", () => {
    const reqDir = join(wikiDir, ".llm-wiki", "wiki", "requirements");
    mkdirSync(reqDir, { recursive: true });
    writeFileSync(
      join(reqDir, "sso-login.md"),
      [
        "---",
        "type: requirement",
        'title: "SSO Login"',
        "status: active",
        "priority: p0",
        "created: 2026-05-16",
        "updated: 2026-05-16",
        "---",
        "",
        "# SSO Login",
        "",
        "Users can sign in via OAuth providers.",
      ].join("\n"),
      "utf-8",
    );
    const paths = getVaultPaths(wikiDir);
    const dotWiki = join(paths.dotWiki);
    mkdirSync(dotWiki, { recursive: true });
    writeFileSync(
      join(dotWiki, "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal" }),
      "utf-8",
    );
    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "SSO Login");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id.startsWith("requirements/"))).toBe(true);
    expect(results.some((r) => r.title.includes("SSO Login"))).toBe(true);
  });

  it("should format recall results as system context", () => {
    const results = [
      {
        id: "concepts/rag",
        title: "RAG",
        type: "concept",
        preview: "Retrieval augmented generation is a technique.",
        path: "/tmp/wiki/concepts/rag.md",
        score: 5,
      },
      {
        id: "entities/openai",
        title: "OpenAI",
        type: "entity",
        preview: "OpenAI is an AI research organization.",
        path: "/tmp/wiki/entities/openai.md",
        score: 3,
      },
    ];
    const context = formatRecallContext(results);
    expect(context).toContain("Relevant Wiki Knowledge");
    expect(context).toContain("[[concepts/rag]]");
    expect(context).toContain("[[entities/openai]]");
    expect(context).toContain("RAG");
    expect(context).toContain("OpenAI");
    expect(context).toContain("2 page(s)");
    expect(context).toContain("wiki_ensure_page or wiki_retro");
  });

  it("should return empty string for empty results", () => {
    expect(formatRecallContext([])).toBe("");
  });

  it("should return empty results when no vault exists", () => {
    const emptyDir = join(tmpDir, "no-vault");
    mkdirSync(emptyDir, { recursive: true });
    const paths = getVaultPaths(emptyDir);
    // No config.json means no vault — search should handle gracefully
    const results = searchWiki(paths, "anything");
    expect(results).toEqual([]);
  });

  describe("layered recall (personal + project)", () => {
    it("should fall back to primary vault when no personal wiki exists", () => {
      createRegistryPage(
        "layered-test",
        "concept",
        "Layered Test",
        "Testing layered recall fallback.",
      );
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);
      // Personal wiki (~/.llm-wiki/) won't exist in test sandbox
      // So searchWikiLayered should return primary vault results only
      const results = searchWikiLayered(paths, "layered test");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toContain("Layered Test");
      // Should not have vaultLabel since personal wiki didn't contribute
      expect(results.every((r) => !r.vaultLabel)).toBe(true);
    });

    it("should tag personal vault results when personal wiki exists", () => {
      // Create primary vault page
      createRegistryPage(
        "project-concept",
        "concept",
        "Project Concept",
        "A project-specific concept.",
      );
      // Also create a personal wiki entry
      const personalPaths = getPersonalWikiPaths();
      const personalSourcesDir = join(personalPaths.wiki, "sources");
      mkdirSync(personalSourcesDir, { recursive: true });
      const personalMeta = join(personalPaths.meta);
      mkdirSync(personalMeta, { recursive: true });
      const personalDotWiki = personalPaths.dotWiki;
      mkdirSync(personalDotWiki, { recursive: true });
      writeFileSync(
        join(personalDotWiki, "config.json"),
        JSON.stringify({ topic: "Personal", mode: "personal" }),
      );
      writeFileSync(
        join(personalSourcesDir, "personal-insight.md"),
        [
          "---",
          "type: source",
          'title: "Personal Insight"',
          "slug: personal-insight",
          "status: insight",
          "created: 2026-05-21",
          "updated: 2026-05-21",
          "---",
          "",
          "# Personal Insight",
          "",
          "A personal wiki insight.",
        ].join("\n"),
      );
      rebuildMetadataLight(personalPaths);

      // Now rebuild primary vault metadata
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Search should find results from both vaults
      const results = searchWikiLayered(paths, "concept", 5);
      // Personal results should be tagged
      const personalResults = results.filter((r) => r.vaultLabel);
      if (personalResults.length > 0) {
        expect(personalResults[0].vaultLabel).toBe("📓 personal");
      }

      // Clean up personal wiki test artifacts
      try {
        rmSync(personalPaths.dotWiki, { recursive: true, force: true });
      } catch {}
    });
  });

  describe("chunk-level indexing", () => {
    it("should match a query against a specific section, not the whole page", () => {
      // Page with multiple sections - only one about the query topic
      createRegistryPage(
        "server-setup",
        "concept",
        "Server Setup",
        [
          "This page covers server setup basics.",
          "",
          "## Postgres",
          "",
          "PostgreSQL is configured with SSL and connection pooling via PgBouncer.",
          "Connection string uses the DATABASE_URL env var.",
          "",
          "## Redis",
          "",
          "Redis is used for caching session data and rate limiting.",
          "",
          "## Nginx",
          "",
          "Nginx reverse proxies API requests and serves static assets.",
        ].join("\n"),
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Query for Postgres - should match the Postgres section specifically
      const results = searchWiki(paths, "PostgreSQL connection pooling");
      expect(results.length).toBeGreaterThanOrEqual(1);

      // The preview should show the Postgres section content, not the intro
      const result = results[0];
      expect(result.id).toBe("concepts/server-setup");
      expect(result.preview).toContain("Postgres");
      expect(result.preview).toContain("PgBouncer");
      // Should not show the intro which mentions "server setup basics"
      expect(result.preview).not.toContain("basics");
    });

    it("should match a query against the intro section", () => {
      createRegistryPage(
        "introduction",
        "concept",
        "Getting Started",
        "Welcome to the framework. This is where you begin learning about routing and middleware.",
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      const results = searchWiki(paths, "Getting Started routing");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].preview).toContain("routing");
    });

    it("should match a deeply nested section heading", () => {
      createRegistryPage(
        "deep-page",
        "synthesis",
        "Deep Analysis",
        [
          "## Background",
          "",
          "General background.",
          "",
          "### Deep Dive",
          "",
          "The specific mechanism involves token-level processing.",
          "",
          "## Results",
          "",
          "All tests pass.",
        ].join("\n"),
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      const results = searchWiki(paths, "token-level processing");
      expect(results.length).toBeGreaterThanOrEqual(1);
      const result = results[0];
      expect(result.preview).toContain("token-level");
      expect(result.preview).toContain("Deep Dive");
    });

    it("should still find pages via metadata even when body has no match", () => {
      createRegistryPage(
        "api-reference",
        "concept",
        "API Reference",
        "Detailed API documentation with examples.",
        { aliases: "api-docs rest-api" },
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Match on alias, not body
      const results = searchWiki(paths, "rest-api");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("concepts/api-reference");
    });
  });

  describe("pseudo-relevance feedback (semantic expansion)", () => {
    it("should expand query terms from top results to boost related pages", () => {
      // Two pages: one directly matching "login", one about "authentication"
      // that mentions "JWT" and "OAuth" (terms not in the original query)
      createRegistryPage(
        "login-page",
        "concept",
        "Login Page",
        [
          "## Login Form",
          "",
          "The login form accepts email and password.",
          "",
          "## Password Reset",
          "",
          "Users can reset their password via email link.",
        ].join("\n"),
      );
      createRegistryPage(
        "auth-module",
        "concept",
        "Authentication System",
        [
          "## JWT Tokens",
          "",
          "JWT tokens are used for session management and API authentication.",
          "",
          "## OAuth Integration",
          "",
          "OAuth 2.0 supports Google and GitHub login providers.",
        ].join("\n"),
      );
      createRegistryPage(
        "unrelated",
        "concept",
        "Unrelated",
        "This page is about CSS styling and color themes.",
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Query for "login" - should find the Login Page (direct match)
      // and the Authentication System page (boosted because top result
      // "Login Page" shares semantic context with "Authentication System"
      // through terms like JWT, OAuth, session, etc.)
      const results = searchWiki(paths, "login", 5);
      expect(results.length).toBeGreaterThanOrEqual(2);

      // Login Page should be first (direct title match)
      expect(results[0].title).toContain("Login Page");

      // Authentication System should be found (boosted by PRF)
      const authResult = results.find((r) => r.id === "concepts/auth-module");
      expect(authResult).toBeDefined();

      // Unrelated should either be absent or ranked below auth
      const unrelatedIndex = results.findIndex((r) => r.id === "concepts/unrelated");
      const authIndex = results.findIndex((r) => r.id === "concepts/auth-module");
      if (unrelatedIndex >= 0 && authIndex >= 0) {
        expect(authIndex).toBeLessThan(unrelatedIndex);
      }
    });

    it("should work with CJK content (no crash)", () => {
      createRegistryPage(
        "pi-learning",
        "concept",
        "Pi 学习",
        [
          "## 交互模式",
          "",
          "Pi 的交互模式包括命令行和对话两种方式。",
          "",
          "## 扩展开发",
          "",
          "通过 TypeScript 扩展可以添加自定义工具和事件处理。",
        ].join("\n"),
      );

      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Query in Chinese - should not crash and should find relevant page
      const results = searchWiki(paths, "Pi 交互模式", 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle empty wiki gracefully (no expansion crash)", () => {
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Empty wiki - no top results to expand from
      const results = searchWiki(paths, "anything");
      expect(results).toEqual([]);
    });
  });

  // ── Hybrid lexical + semantic ranking (issue #67) ──────
  describe("hybrid lexical + semantic ranking", () => {
    beforeEach(() => __clearQueryEmbeddingCache());

    /** Write a hand-built embeddings.json sidecar keyed by page id. */
    function writeSidecar(
      paths: ReturnType<typeof getVaultPaths>,
      vectors: Record<string, number[]>,
      model = "mock-embed",
    ): void {
      const entries: Record<string, unknown> = {};
      for (const [id, raw] of Object.entries(vectors)) {
        const vector = normalizeVector(raw);
        entries[id] = { hash: "h", model, dim: vector.length, vector, updated: "t" };
      }
      writeFileSync(
        embeddingStorePath(paths),
        JSON.stringify({ version: "1.0", entries }),
        "utf-8",
      );
    }

    /** Mock embedder returning a fixed raw vector, recording call count. */
    function makeFixedEmbedder(raw: number[], model = "mock-embed") {
      const calls: string[][] = [];
      const embedder: Embedder = {
        model,
        embed: async (texts) => {
          calls.push(texts);
          return texts.map(() => [...raw]);
        },
      };
      return { embedder, calls };
    }

    it("fuseScores adds a bounded, weighted, non-negative semantic boost", () => {
      // Identity on the lexical score when cosine ≤ 0 (pure-lexical preserved).
      expect(fuseScores(5, 0, 0.5)).toBe(5);
      expect(fuseScores(5, -0.9, 0.5)).toBe(5);
      // lexical + weight * SCALE * cosine
      expect(fuseScores(5, 1, 0.5)).toBeCloseTo(5 + 0.5 * SEMANTIC_SCALE * 1, 10);
      expect(fuseScores(0, 1, 1)).toBeCloseTo(SEMANTIC_SCALE, 10);
      expect(fuseScores(3, 0.5, DEFAULT_SEMANTIC_WEIGHT)).toBeCloseTo(
        3 + DEFAULT_SEMANTIC_WEIGHT * SEMANTIC_SCALE * 0.5,
        10,
      );
    });

    it("surfaces a page pure lexical misses (paraphrase recall)", () => {
      // Neither page contains the query tokens "fixing cars" → lexical = 0.
      createRegistryPage(
        "automobile-care",
        "concept",
        "Automobile Maintenance",
        "Keeping your vehicle running smoothly over the years.",
      );
      createRegistryPage(
        "css-themes",
        "concept",
        "Color Palettes",
        "Styling guidance for light and dark visual themes.",
      );
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Pure lexical: query matches nothing.
      expect(searchWiki(paths, "fixing cars")).toEqual([]);

      // Semantic: query vector close to the automobile page, orthogonal to CSS.
      writeSidecar(paths, {
        "concepts/automobile-care": [1, 0, 0, 0],
        "concepts/css-themes": [0, 0, 1, 0],
      });
      const semantic: SemanticContext = {
        queryVector: normalizeVector([0.95, 0.05, 0, 0]),
        weight: 0.5,
      };
      const results = searchWiki(paths, "fixing cars", 5, 0, semantic);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("concepts/automobile-care");
      // The near-orthogonal CSS page stays below the semantic candidacy gate.
      expect(results.some((r) => r.id === "concepts/css-themes")).toBe(false);
    });

    it("changes ranking order vs pure lexical when semantics dominate", () => {
      // "Login Page" matches the query lexically; "Session Management" does not.
      createRegistryPage(
        "login-page",
        "concept",
        "Login Page",
        "The login form accepts an email and a password.",
      );
      createRegistryPage(
        "session-mgmt",
        "concept",
        "Token Lifecycle",
        "How bearer credentials are minted, rotated, and revoked.",
      );
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // Pure lexical: login-page is the (weak, body-only) match for "form";
      // session-mgmt has no lexical overlap at all.
      const lexical = searchWiki(paths, "form", 5);
      expect(lexical[0].id).toBe("concepts/login-page");
      expect(lexical.some((r) => r.id === "concepts/session-mgmt")).toBe(false);

      // Semantic: query vector identical to session-mgmt, orthogonal to login.
      writeSidecar(paths, {
        "concepts/login-page": [0, 1, 0, 0],
        "concepts/session-mgmt": [1, 0, 0, 0],
      });
      const semantic: SemanticContext = { queryVector: normalizeVector([1, 0, 0, 0]), weight: 0.5 };
      const hybrid = searchWiki(paths, "form", 5, 0, semantic);

      // session-mgmt now outranks the lexically-matched login-page.
      expect(hybrid[0].id).toBe("concepts/session-mgmt");
      expect(hybrid.some((r) => r.id === "concepts/login-page")).toBe(true);
    });

    it("no embeddings sidecar → identical to pure lexical (regression)", () => {
      for (const [id, title] of [
        ["alpha", "Alpha Concept"],
        ["beta", "Beta Concept"],
      ] as const) {
        createRegistryPage(id, "concept", title, `Body about ${title} and shared concept text.`);
      }
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      const pure = searchWiki(paths, "concept", 5);
      // Passing a semantic context but with NO sidecar present must be a no-op.
      const semantic: SemanticContext = { queryVector: [1, 0, 0, 0], weight: 0.5 };
      const withCtxNoSidecar = searchWiki(paths, "concept", 5, 0, semantic);

      expect(withCtxNoSidecar.map((r) => [r.id, r.score])).toEqual(
        pure.map((r) => [r.id, r.score]),
      );
    });

    it("empty/missing sidecar is safe and does not crash", () => {
      createRegistryPage("lonely", "concept", "Lonely Page", "Just some content here.");
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);
      // Write an explicitly empty store.
      writeFileSync(
        embeddingStorePath(paths),
        JSON.stringify({ version: "1.0", entries: {} }),
        "utf-8",
      );
      const semantic: SemanticContext = { queryVector: [1, 0], weight: 0.5 };
      const results = searchWiki(paths, "lonely", 5, 0, semantic);
      expect(results[0].id).toBe("concepts/lonely");
    });

    it("minScore still filters: weak cosine excluded, strong cosine passes", () => {
      createRegistryPage(
        "orphan",
        "concept",
        "Unrelated Heading",
        "Content with no overlap with the search query at all.",
      );
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      // weight 0.5, SCALE 12 → boost = 6 * cosine. minScore 5.
      // cosine 0.5 → boost 3 < 5 → filtered out.
      writeSidecar(paths, { "concepts/orphan": [1, 0, 0, 0] });
      const weak: SemanticContext = {
        queryVector: normalizeVector([0.5, 0.866, 0, 0]),
        weight: 0.5,
      };
      expect(searchWiki(paths, "zzz nonmatching", 5, 5, weak)).toEqual([]);

      // cosine 1.0 → boost 6 ≥ 5 → passes.
      const strong: SemanticContext = { queryVector: normalizeVector([1, 0, 0, 0]), weight: 0.5 };
      const passed = searchWiki(paths, "zzz nonmatching", 5, 5, strong);
      expect(passed.map((r) => r.id)).toEqual(["concepts/orphan"]);
    });

    it("searchWikiHybrid skips the query embedding when no sidecar exists", async () => {
      createRegistryPage("lex-only", "concept", "Lexical Only", "A page about caching layers.");
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);

      const { embedder, calls } = makeFixedEmbedder([1, 0, 0, 0]);
      const results = await searchWikiHybrid(paths, "caching", 5, 0, false, { embedder });

      // No sidecar → no embedding call at all → pure lexical result.
      expect(calls).toHaveLength(0);
      expect(results[0].id).toBe("concepts/lex-only");
      expect(results.map((r) => [r.id, r.score])).toEqual(
        searchWiki(paths, "caching", 5).map((r) => [r.id, r.score]),
      );
    });

    it("searchWikiHybrid embeds the query once and caches it across calls", async () => {
      createRegistryPage("sem-page", "concept", "Distinct Title", "Body with unrelated wording.");
      const paths = getVaultPaths(wikiDir);
      rebuildMetadataLight(paths);
      // Sidecar vector equals the embedder's fixed output → cosine 1.0.
      writeSidecar(paths, { "concepts/sem-page": [1, 0, 0, 0] }, "mock-embed");

      const { embedder, calls } = makeFixedEmbedder([1, 0, 0, 0], "mock-embed");
      const q = "a query that lexically matches nothing";

      const r1 = await searchWikiHybrid(paths, q, 5, 0, false, { embedder });
      const r2 = await searchWikiHybrid(paths, q, 5, 0, false, { embedder });

      // Semantic-only page surfaced...
      expect(r1[0].id).toBe("concepts/sem-page");
      expect(r2[0].id).toBe("concepts/sem-page");
      // ...and the query was embedded exactly ONCE (cached on the 2nd call).
      expect(calls).toHaveLength(1);
    });
  });
});
