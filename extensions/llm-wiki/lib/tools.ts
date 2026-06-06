import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { launchEmbedPages, reindexEmbeddings, resolveEmbedder } from "./embeddings.js";
import { scheduleReindex } from "./indexing.js";
import { runIngestSynthesis } from "./ingest-worker.js";
import {
  type Registry,
  appendEvent,
  buildBacklinks,
  buildRegistry,
  rebuildMetadata,
  rebuildMetadataLight,
} from "./metadata.js";
import type { Runtime } from "./runtime.js";
import { captureFile, captureText, captureUrl } from "./source-packet.js";
import { parseModelRef } from "./task-config.js";
import {
  type VaultPaths,
  detectVaultFormat,
  ensureVaultStructure,
  extractWikilinks,
  findWikiPages,
  fmtDate,
  getVaultPaths,
  readJson,
  resolveVaultPaths,
  writeJson,
} from "./utils.js";

/**
 * All LLM Wiki custom tools.
 */

function getPaths(cwd?: string): VaultPaths {
  return resolveVaultPaths(cwd ?? process.cwd());
}

function requireVault(paths: VaultPaths): { ok: true } | { ok: false; reason: string } {
  if (detectVaultFormat(paths.root) === "none") {
    return { ok: false, reason: `No wiki found at ${paths.root}. Run wiki_bootstrap first.` };
  }
  return { ok: true };
}

type WikiToolResult = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
};

type ToolCtx = {
  cwd?: string;
  hasUI: boolean;
  ui?: { notify: (message: string, type?: string) => void };
};

/**
 * Dispatch a heavy mutating action to the background runtime and report its
 * result (issue #77). The agent turn is never blocked: `work` runs off-thread
 * and the returned one-line summary is surfaced to the user via
 * `runtime.report()`. Returns an immediate, non-blocking tool result.
 *
 * When no runtime is available (unit tests / degraded mode), `work` runs
 * synchronously and its summary is returned inline, preserving prior behavior.
 * Retrieval tools (search/read/recall/status) never use this — the model needs
 * their output inline.
 */
async function dispatchReported(
  runtime: Runtime | undefined,
  ctx: ToolCtx,
  opts: {
    label: string;
    /** Immediate, non-blocking acknowledgement shown while work runs. */
    started: string;
    /** Off-thread work; resolves to the human-readable completion summary. */
    work: () => Promise<string>;
    details?: Record<string, unknown>;
  },
): Promise<WikiToolResult> {
  if (!runtime) {
    const summary = await opts.work();
    return {
      content: [{ type: "text", text: summary }],
      details: { background: false, ...opts.details },
    };
  }
  runtime.launchReported({ hasUI: ctx.hasUI, ui: ctx.ui }, opts.label, opts.work);
  return {
    content: [{ type: "text", text: opts.started }],
    details: { background: true, ...opts.details },
  };
}

// ─── 1. wiki_bootstrap ──────────────────────────────────

export function registerWikiBootstrap(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_bootstrap",
    label: "Wiki Bootstrap",
    description:
      "Initialize a new LLM Wiki vault with the 4-layer architecture. " +
      "Creates config, templates, schema, and metadata scaffolding.",
    promptSnippet: "Initialize a new LLM Wiki vault",
    promptGuidelines: ["Use wiki_bootstrap when the user wants to start a new wiki."],
    parameters: Type.Object({
      topic: Type.String({ description: "Main topic of the wiki" }),
      mode: Type.Optional(Type.String({ description: "personal or company (default: personal)" })),
      root: Type.Optional(
        Type.String({ description: "Root directory (default: current directory)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = params.root ?? ctx.cwd ?? process.cwd();
      const mode = params.mode || "personal";
      const paths = getVaultPaths(root);

      ensureVaultStructure(paths);

      const config = {
        name: params.topic,
        mode,
        topic: params.topic,
        created: fmtDate(),
        version: "1.0",
      };
      writeJson(join(paths.dotWiki, "config.json"), config);

      const schema = [
        "# LLM Wiki Schema",
        "",
        "## Ownership Rules",
        "",
        "| Path | Owner | Rule |",
        "|------|-------|------|",
        "| raw/** | extension | immutable after capture |",
        "| wiki/** | model + user | editable knowledge pages |",
        "| meta/* | extension | auto-generated |",
        "| . | human + explicit request | operating rules |",
        "",
        "## Source Packet Format",
        "",
        "```",
        "raw/sources/SRC-YYYY-MM-DD-NNN/",
        "  manifest.json",
        "  original/",
        "  extracted.md",
        "  attachments/",
        "```",
        "",
        "## Page Types",
        "",
        "- **source** — what this specific source says",
        "- **entity** — people, orgs, tools, products",
        "- **concept** — ideas, patterns, frameworks",
        "- **synthesis** — cross-source theses and tensions",
        "- **analysis** — durable filed answers from queries",
        "- **requirement** — atomic requirements with status, priority, and traceability",
        "",
        "## Linking Style",
        "",
        "- Internal: [[folder/page-name]]",
        "- Citation: [[sources/SRC-YYYY-MM-DD-NNN]]",
        "",
      ].join("\n");
      writeFileSync(join(paths.dotWiki, "WIKI_SCHEMA.md"), schema, "utf-8");

      rebuildMetadata(paths);
      appendEvent(paths, { kind: "bootstrap", topic: params.topic, mode });

      return {
        content: [
          {
            type: "text",
            text: [
              `✅ Wiki bootstrapped at \`${paths.root}\``,
              "**Scope:** project-local",
              "",
              "**Structure:**",
              "- .llm-wiki/raw/sources/ — immutable source packets",
              "- .llm-wiki/wiki/ — editable knowledge pages",
              "- .llm-wiki/meta/ — auto-generated metadata",
              "- .llm-wiki/ — config and templates",
              "- .llm-wiki/WIKI_SCHEMA.md — operating rules",
              "",
              "Next: Use wiki_capture_source to add your first source.",
            ].join("\n"),
          },
        ],
        details: { root, mode, topic: params.topic } as Record<string, unknown>,
      };
    },
  });
}

// ─── 2. wiki_capture_source ─────────────────────────────

export function registerWikiCaptureSource(pi: ExtensionAPI, runtime?: Runtime): void {
  pi.registerTool({
    name: "wiki_capture_source",
    label: "Wiki Capture Source",
    description:
      "Capture a URL, local file, or pasted text into an immutable source packet and skeleton source page.",
    promptSnippet: "Capture a source into the wiki as an immutable packet",
    promptGuidelines: [
      "Use wiki_capture_source when the user provides a URL, file, or text to capture.",
      "After capture, read the extracted text and update the skeleton source page.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to capture" })),
      file_path: Type.Optional(Type.String({ description: "Local file path to capture" })),
      text: Type.Optional(Type.String({ description: "Pasted text content" })),
      title: Type.Optional(Type.String({ description: "Title for pasted text" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      let result: {
        sourceId: string;
        packetPath: string;
        sourcePagePath: string;
        extracted: string;
      };

      if (params.url) {
        result = await captureUrl(pi, paths, params.url, signal);
      } else if (params.file_path) {
        result = await captureFile(pi, paths, params.file_path, signal);
      } else if (params.text) {
        result = captureText(paths, params.text, params.title);
      } else {
        return {
          content: [{ type: "text", text: "❌ Provide one of: url, file_path, or text" }],
          details: { error: "missing_source" } as Record<string, unknown>,
          isError: true,
        };
      }

      if (runtime) {
        scheduleReindex(runtime, { hasUI: ctx.hasUI, ui: ctx.ui }, paths);
      } else {
        rebuildMetadataLight(paths);
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `✅ Captured source **${result.sourceId}**`,
              "",
              `- Packet: \`${result.packetPath}\``,
              `- Skeleton page: \`${result.sourcePagePath}\``,
              "",
              "**Next:** Read the extracted text and update the source page with a proper summary, entities, and concepts.",
            ].join("\n"),
          },
        ],
        details: {
          sourceId: result.sourceId,
          packetPath: result.packetPath,
          sourcePagePath: result.sourcePagePath,
          extractedPreview: result.extracted.slice(0, 300),
        } as Record<string, unknown>,
      };
    },
  });
}

// ─── 3. wiki_ingest ─────────────────────────────────────

export function registerWikiIngest(pi: ExtensionAPI, runtime?: Runtime): void {
  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description:
      "Process uningested source packets. By default synthesis runs in the background (non-blocking) on the configured task model; pass background=false to return extracted content for the main agent to synthesize itself.",
    promptSnippet: "Ingest source packets (background synthesis by default)",
    promptGuidelines: [
      "Use wiki_ingest when the user wants to process captured sources.",
      "By default ingestion runs in the BACKGROUND — you'll get a notification, not extracted content. Do NOT synthesize those sources yourself.",
      "If the tool returns extracted content (background unavailable, or background=false), then read each source's extracted.md, update its source page, create entity/concept pages, and cross-reference.",
      "The extension auto-updates metadata — you do NOT need to edit meta/ files.",
    ],
    parameters: Type.Object({
      source_id: Type.Optional(
        Type.String({ description: "Specific source ID to ingest. Leave empty for all new." }),
      ),
      batch_size: Type.Optional(
        Type.Number({ description: "Max sources to process (default: 3, max: 5)", default: 3 }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Synthesize in the background without blocking (default: true). Set false to return extracted content for the main agent to synthesize.",
          default: true,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Per-call model override as 'provider/id' (e.g. anthropic/claude-haiku). Overrides the configured wiki taskModel for this call; defaults to the configured/session model.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      const batchSize = Math.min(params.batch_size ?? 3, 5);

      if (!existsSync(paths.rawSources)) {
        return {
          content: [
            {
              type: "text",
              text: "No raw/sources/ directory. Capture sources first with wiki_capture_source.",
            },
          ],
          details: { error: "no_sources" } as Record<string, unknown>,
        };
      }

      const packets = readdirSync(paths.rawSources)
        .filter((d) => d.startsWith("SRC-"))
        .sort();

      const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
        version: "1.0",
        last_updated: "",
        pages: {},
      });
      const ingested = new Set<string>();
      for (const [id, entry] of Object.entries(registry.pages)) {
        if (entry.type === "source" && (entry as Record<string, unknown>).status !== "skeleton") {
          const base = id.split("/").pop();
          if (base) ingested.add(base);
        }
      }

      let toProcess = packets.filter((p) => !ingested.has(p));

      if (params.source_id) {
        if (!toProcess.includes(params.source_id) && !packets.includes(params.source_id)) {
          return {
            content: [
              { type: "text", text: `Source ${params.source_id} not found or already ingested.` },
            ],
            details: { source_id: params.source_id, status: "not_found" } as Record<
              string,
              unknown
            >,
          };
        }
        toProcess = [params.source_id];
      }

      const batch = toProcess.slice(0, batchSize);

      if (batch.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "✅ All sources ingested. Use wiki_capture_source to add new ones.",
            },
          ],
          details: { ingested: ingested.size, total: packets.length } as Record<string, unknown>,
        };
      }

      const sources = batch.map((id) => {
        const extractedPath = join(paths.rawSources, id, "extracted.md");
        const manifestPath = join(paths.rawSources, id, "manifest.json");
        const extracted = existsSync(extractedPath) ? readFileSync(extractedPath, "utf-8") : "";
        const manifest = readJson<Record<string, unknown>>(manifestPath, {});
        return { id, extracted, manifest };
      });

      // ── Background synthesis (issue #65) ──────────────────
      // Default path: dispatch each source to a background sub-agent so the
      // main agent is not blocked. Falls back to the synchronous return below
      // when no runtime/model is available (resolveModel ok:false).
      const wantBackground = params.background !== false;
      if (wantBackground && runtime) {
        runtime.ensureConfig(ctx.cwd);
        // Per-call model override (issue #69): 'provider/id' beats the
        // configured taskModel; a malformed/unknown ref degrades to the
        // configured/session model inside resolveModel.
        const override = params.model ? parseModelRef(params.model) : undefined;
        const resolved = await runtime.resolveModel(ctx, override);
        if (resolved.ok) {
          const launchCtx = { hasUI: ctx.hasUI, ui: ctx.ui };
          for (const s of sources) {
            runtime.launchTask(launchCtx, `ingest:${s.id}`, async () => {
              const committed = await runIngestSynthesis({
                model: resolved.model as Parameters<typeof runIngestSynthesis>[0]["model"],
                apiKey: resolved.apiKey,
                headers: resolved.headers,
                paths,
                sourceId: s.id,
                manifest: s.manifest,
                extracted: s.extracted,
              });
              if (committed) {
                // Background semantic embeddings (#66): embed the pages this
                // ingest just wrote, off-thread. No-op when unconfigured.
                const pageIds = [
                  `sources/${committed.sourceId}`,
                  ...committed.entitiesCreated.map((e) => `entities/${e}`),
                  ...committed.entitiesLinked.map((e) => `entities/${e}`),
                  ...committed.conceptsCreated.map((c) => `concepts/${c}`),
                  ...committed.conceptsLinked.map((c) => `concepts/${c}`),
                ];
                launchEmbedPages(runtime, launchCtx, paths, pageIds, `embed:ingest:${s.id}`);
              }
              const summary = committed
                ? `LLM Wiki: ingested ${s.id} → ${committed.entitiesCreated.length} entit${committed.entitiesCreated.length === 1 ? "y" : "ies"}, ${committed.conceptsCreated.length} concept${committed.conceptsCreated.length === 1 ? "" : "s"}`
                : `LLM Wiki: ${s.id} produced no synthesis`;
              if (ctx.hasUI) {
                ctx.ui.notify(summary, committed ? "info" : "warning");
              }
              // Persistent, user-visible completion report (issue #77) in
              // addition to the transient toast above. Notices-gated.
              runtime.report(committed ? `✅ ${summary}` : `⚠️ ${summary}`);
            });
          }
          return {
            content: [
              {
                type: "text",
                text: [
                  `🔄 **Ingesting ${sources.length} source(s) in the background** (${toProcess.length - batch.length} remaining).`,
                  "",
                  ...sources.map((s) => `- **${s.id}**: ${s.manifest.title || s.id}`),
                  "",
                  "Synthesis runs on the configured task model without blocking. You'll be notified as each source completes — do NOT synthesize these yourself.",
                ].join("\n"),
              },
            ],
            details: {
              background: true,
              dispatched: sources.map((s) => s.id),
              remaining: toProcess.length - batch.length,
            } as Record<string, unknown>,
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `📥 **${batch.length} source(s) ready** (${toProcess.length - batch.length} remaining)`,
              "",
              ...sources.map((s) =>
                [
                  `- **${s.id}**: ${s.manifest.title || s.id}`,
                  `  - Extracted: ${s.extracted.length} chars`,
                  `  - Read: \`raw/sources/${s.id}/extracted.md\``,
                ].join("\n"),
              ),
              "",
              "**Next steps for each source:**",
              "1. Read extracted.md",
              "2. Update the skeleton source page in wiki/sources/",
              "3. Create/update entity pages in wiki/entities/",
              "4. Create/update concept pages in wiki/concepts/",
              "5. Add [[wikilinks]] cross-references",
              "6. Flag contradictions",
              "",
              "The extension will auto-update metadata when you're done.",
            ].join("\n"),
          },
        ],
        details: {
          batch: sources.map((s) => s.id),
          remaining: toProcess.length - batch.length,
        } as Record<string, unknown>,
      };
    },
  });
}

// ─── 4. wiki_ensure_page ────────────────────────────────

export function registerWikiEnsurePage(pi: ExtensionAPI, runtime?: Runtime): void {
  pi.registerTool({
    name: "wiki_ensure_page",
    label: "Wiki Ensure Page",
    description: "Resolve or safely create a canonical wiki page. Returns the page path.",
    promptSnippet: "Create a canonical wiki page if it doesn't exist",
    promptGuidelines: [
      "Use wiki_ensure_page before creating pages to avoid duplicates.",
      "Search existing pages first with wiki_search.",
    ],
    parameters: Type.Object({
      type: Type.String({
        description: "Page type: entity | concept | synthesis | analysis | requirement",
      }),
      title: Type.String({ description: "Page title" }),
      content: Type.Optional(
        Type.String({ description: "Optional initial content (otherwise uses template)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      const type = params.type as "entity" | "concept" | "synthesis" | "analysis";
      const slug = params.title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80);

      const folderMap: Record<string, string> = {
        entity: "entities",
        concept: "concepts",
        synthesis: "syntheses",
        analysis: "analyses",
        requirement: "requirements",
      };
      const folder = folderMap[type] || "concepts";
      const pagePath = join(paths.wiki, folder, `${slug}.md`);

      if (existsSync(pagePath)) {
        return {
          content: [{ type: "text", text: `✅ Page already exists: \`${pagePath}\`` }],
          details: { path: pagePath, created: false } as Record<string, unknown>,
        };
      }

      const today = fmtDate();
      const template = buildPageTemplate(type, params.title, today, params.content);
      mkdirSync(join(paths.wiki, folder), { recursive: true });
      writeFileSync(pagePath, template, "utf-8");

      appendEvent(paths, {
        kind: "ensure_page",
        page_type: type,
        title: params.title,
        path: `${folder}/${slug}`,
      });

      // Register the new page so retrieval + embeddings can see it. When a
      // background runtime is available, the rebuild + embeddings run off the
      // tool's critical path; otherwise fall back to a synchronous rebuild.
      if (runtime) {
        scheduleReindex(runtime, { hasUI: ctx.hasUI, ui: ctx.ui }, paths);
      } else {
        rebuildMetadataLight(paths);
      }

      return {
        content: [{ type: "text", text: `✅ Created ${type} page: \`${pagePath}\`` }],
        details: { path: pagePath, created: true } as Record<string, unknown>,
      };
    },
  });
}

function buildPageTemplate(
  type: string,
  title: string,
  date: string,
  customContent?: string,
): string {
  if (customContent) return customContent;

  const base = `---\ntype: ${type}\ncreated: ${date}\nupdated: ${date}\nsources: []\n---\n\n# ${title}\n\n[Description to be filled]\n\n## Links\n\n- [[related-page]]\n`;

  if (type === "entity") {
    return base
      .replace("[Description to be filled]", "One-line description.\n\n## Overview\n\n[Key facts]")
      .replace("type: entity", "type: entity\ncategory: organization");
  }
  if (type === "concept") {
    return base
      .replace(
        "[Description to be filled]",
        "One-line definition.\n\n## Definition\n\n[Clear explanation]",
      )
      .replace("type: concept", "type: concept\ndomain: ai");
  }
  if (type === "synthesis") {
    return base
      .replace(
        "[Description to be filled]",
        "Cross-cutting analysis.\n\n## Question\n\n[What drove this?]",
      )
      .replace("sources: []", "sources_count: 0");
  }
  if (type === "analysis") {
    return base.replace(
      "[Description to be filled]",
      "Durable answer from a query.\n\n## Question\n\n[Original question]",
    );
  }
  if (type === "requirement") {
    return [
      "---",
      "type: requirement",
      `created: ${date}`,
      `updated: ${date}`,
      "status: draft",
      "priority: p2",
      "source_id: ",
      "depends_on: []",
      "---",
      "",
      `# ${title}`,
      "",
      "## Description",
      "",
      "[Clear description of what this requirement entails]",
      "",
      "## Acceptance Criteria",
      "",
      "- [ ] [Criterion 1]",
      "- [ ] [Criterion 2]",
      "",
      "## Dependencies",
      "",
      "_Pages this requirement depends on._",
      "",
      "## Implementation Notes",
      "",
      "[Optional notes]",
      "",
      "## Sources",
      "",
      "- [[sources/SRC-...]] — original concept capture",
      "",
    ].join("\n");
  }
  return base;
}

// ─── 5. wiki_search ─────────────────────────────────────

export function registerWikiSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_search",
    label: "Wiki Search",
    description: "Search the wiki registry for pages matching a query.",
    promptSnippet: "Search the wiki registry for pages",
    promptGuidelines: ["Use wiki_search to find existing pages before creating duplicates."],
    parameters: Type.Object({
      query: Type.String({ description: "Search term" }),
      type: Type.Optional(Type.String({ description: "Filter by page type" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
        version: "1.0",
        last_updated: "",
        pages: {},
      });
      const q = params.query.toLowerCase();

      const matches = Object.entries(registry.pages)
        .filter(([id, entry]) => {
          const matchesQuery =
            id.toLowerCase().includes(q) ||
            String(entry.title).toLowerCase().includes(q) ||
            String(entry.type).toLowerCase().includes(q);
          const matchesType =
            !params.type || String(entry.type).toLowerCase() === params.type.toLowerCase();
          return matchesQuery && matchesType;
        })
        .map(([id, entry]) => ({ id, title: entry.title, type: entry.type }));

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: `No pages found for "${params.query}"` }],
          details: { query: params.query, matches: [] } as Record<string, unknown>,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `🔍 **${matches.length} result(s)** for "${params.query}":`,
              "",
              ...matches.map((m) => `- [[${m.id}]] — *${m.type}* — ${m.title}`),
            ].join("\n"),
          },
        ],
        details: { query: params.query, matches } as Record<string, unknown>,
      };
    },
  });
}

// ─── 6. wiki_lint ───────────────────────────────────────

export function registerWikiLint(pi: ExtensionAPI, runtime?: Runtime): void {
  pi.registerTool({
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Health check the wiki. Scans for orphans, missing pages, contradictions, gaps. Optionally auto-fixes.",
    promptSnippet: "Lint the wiki for health issues",
    promptGuidelines: [
      "Use wiki_lint when the user asks to check wiki health.",
      "Contradictions always need human review.",
    ],
    parameters: Type.Object({
      auto_fix: Type.Optional(
        Type.Boolean({ description: "Auto-fix orphans and missing pages", default: false }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      // Full-vault scan (+ optional auto-fix writes + reindex) is O(pages):
      // run it in the background and report the health summary (issue #77).
      return dispatchReported(runtime, ctx as ToolCtx, {
        label: `lint:${paths.root}`,
        started:
          "\u{1F9F9} LLM Wiki: lint started in the background — the health report will be posted when it completes.",
        work: async () => runWikiLint(paths, params.auto_fix === true),
      });
    },
  });
}

/**
 * Run the wiki health scan (issue #77 extracted it from the tool body so it can
 * run off-thread via `dispatchReported`). Returns the human-readable summary.
 */
function runWikiLint(paths: VaultPaths, autoFix: boolean): string {
  const pages = findWikiPages(paths.wiki);
  const registry = buildRegistry(paths);
  buildBacklinks(paths, registry); // ensures backlinks.json is current

  const findings: string[] = [];
  let orphans = 0;
  let missingPages = 0;
  let contradictions = 0;
  const gaps: Array<{ topic: string; mentionedBy: string[] }> = [];

  const allPageIds = new Set(pages.map((p) => p.relative));
  const linkCounts: Record<string, number> = {};

  for (const page of pages) {
    const links = extractWikilinks(page.content);
    for (const link of links) {
      if (!allPageIds.has(link)) {
        missingPages++;
        findings.push(`Missing page: [[${link}]] (in [[${page.relative}]])`);
        const existing = gaps.find((g) => g.topic === link);
        if (existing) {
          if (!existing.mentionedBy.includes(page.relative))
            existing.mentionedBy.push(page.relative);
        } else {
          gaps.push({ topic: link, mentionedBy: [page.relative] });
        }
      } else {
        linkCounts[link] = (linkCounts[link] || 0) + 1;
      }
    }
  }

  for (const page of pages) {
    if (!linkCounts[page.relative] || linkCounts[page.relative] === 0) {
      orphans++;
      findings.push(`Orphan: [[${page.relative}]] has no inbound links`);
    }
  }

  for (const page of pages) {
    if (page.content.includes("⚠️ **Contradiction")) {
      contradictions++;
      findings.push(`Contradiction flagged in [[${page.relative}]]`);
    }
  }

  let fixesApplied = 0;
  if (autoFix) {
    for (const gap of gaps) {
      if (gap.mentionedBy.length >= 2) {
        const folder = gap.topic.includes("/") ? gap.topic.split("/")[0] : "concepts";
        const name = gap.topic.includes("/") ? gap.topic.split("/").pop()! : gap.topic;
        const pagePath = join(paths.wiki, folder, `${name}.md`);
        if (!existsSync(pagePath)) {
          mkdirSync(join(paths.wiki, folder), { recursive: true });
          writeFileSync(
            pagePath,
            `---\ntype: concept\ncreated: ${fmtDate()}\nupdated: ${fmtDate()}\nsources: []\nstatus: stub\n---\n\n# ${name.replace(/-/g, " ")}\n\n_Stub auto-created by lint. Expand with content from: ${gap.mentionedBy.map((r) => `[[${r}]]`).join(", ")}_\n`,
            "utf-8",
          );
          fixesApplied++;
        }
      }
    }
  }

  writeJson(join(paths.discoveries, "gaps.json"), {
    gaps,
    generated: new Date().toISOString(),
  });

  const reportLines = [
    "# Wiki Lint Report",
    `Generated: ${fmtDate()}`,
    "",
    "## Summary",
    `- Total pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing pages: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    autoFix ? `- Fixes applied: ${fixesApplied}` : "",
    "",
    "## Findings",
    findings.length > 0 ? findings.map((f) => `- ${f}`).join("\n") : "✅ No issues found!",
    "",
  ].filter(Boolean);

  const reportPath = join(paths.outputs, `lint-${fmtDate()}.md`);
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(reportPath, `${reportLines.join("\n")}\n`, "utf-8");

  appendEvent(paths, {
    kind: "lint",
    orphans,
    missing_pages: missingPages,
    contradictions,
    auto_fix: autoFix,
  });

  rebuildMetadataLight(paths);

  return [
    "🧹 **LLM Wiki lint complete**",
    "",
    `- Pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    autoFix ? `- Auto-fixes: ${fixesApplied}` : "",
    "",
    `📄 Report: \`${reportPath}\``,
    gaps.length > 0 ? `💡 ${gaps.length} knowledge gap(s) tracked` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── 7. wiki_status ─────────────────────────────────────

export function registerWikiStatus(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_status",
    label: "Wiki Status",
    description: "Report wiki health and stats instantly from generated registry.",
    promptSnippet: "Report wiki health and stats",
    promptGuidelines: ["Use wiki_status for a quick overview."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
        version: "1.0",
        last_updated: "",
        pages: {},
      });
      const backlinks = readJson<Record<string, string[]>>(join(paths.meta, "backlinks.json"), {});
      const config = readJson<Record<string, unknown>>(join(paths.dotWiki, "config.json"), {});

      const byType: Record<string, number> = {};
      for (const entry of Object.values(registry.pages)) {
        byType[entry.type] = (byType[entry.type] || 0) + 1;
      }

      const orphanCount = Object.entries(backlinks).filter(
        ([, inbound]) => inbound.length === 0,
      ).length;
      const gaps = readJson<{ gaps?: unknown[] }>(join(paths.discoveries, "gaps.json"), {
        gaps: [],
      });

      const health =
        Object.keys(registry.pages).length === 0
          ? "🔴 Empty"
          : orphanCount > 5
            ? "⚠️ Warning"
            : "✅ Good";

      const lines = [
        "📊 LLM Wiki Status",
        "══════════════════",
        `Topic: ${config.topic || "Unknown"}`,
        `Mode: ${config.mode || "personal"}`,
        `Pages: ${Object.keys(registry.pages).length}`,
        ...Object.entries(byType).map(([t, c]) => `  - ${t}s: ${c}`),
        `Orphans: ${orphanCount}`,
        `Gaps: ${gaps.gaps?.length || 0}`,
        `Health: ${health}`,
        `Last updated: ${registry.last_updated || "Never"}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          topic: config.topic,
          mode: config.mode,
          totalPages: Object.keys(registry.pages).length,
          byType,
          orphans: orphanCount,
          gaps: gaps.gaps?.length || 0,
          health,
        } as Record<string, unknown>,
      };
    },
  });
}

// ─── 8. wiki_rebuild_meta ───────────────────────────────

export function registerWikiRebuildMeta(pi: ExtensionAPI, runtime?: Runtime): void {
  pi.registerTool({
    name: "wiki_rebuild_meta",
    label: "Wiki Rebuild Meta",
    description: "Force a full metadata rebuild (registry, backlinks, index, log).",
    promptSnippet: "Rebuild all wiki metadata",
    promptGuidelines: ["Use wiki_rebuild_meta if metadata seems out of sync."],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      // Heavy O(pages) rebuild — dispatch off the agent's critical path and
      // report on completion (issue #77).
      return dispatchReported(runtime, ctx as ToolCtx, {
        label: `rebuild_meta:${paths.root}`,
        started:
          "\u{1F9E0} LLM Wiki: metadata rebuild started in the background — the result will be reported when it completes.",
        work: async () => {
          rebuildMetadata(paths);
          appendEvent(paths, { kind: "rebuild_meta" });
          const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
            version: "1.0",
            last_updated: "",
            pages: {},
          });
          return `✅ LLM Wiki: metadata rebuilt — ${Object.keys(registry.pages).length} pages indexed.`;
        },
      });
    },
  });
}

// ─── 9. wiki_log_event ──────────────────────────────────

export function registerWikiReindexEmbeddings(pi: ExtensionAPI, runtime?: Runtime): void {
  pi.registerTool({
    name: "wiki_reindex_embeddings",
    label: "Wiki Reindex Embeddings",
    description:
      "Backfill / refresh semantic embeddings for the vault. Embeds pages that " +
      "are new or stale (content changed); pass force to re-embed everything. " +
      "No-op when no embedding provider is configured.",
    promptSnippet: "Backfill semantic embeddings for the wiki",
    promptGuidelines: [
      "Use wiki_reindex_embeddings to embed an existing vault or refresh stale embeddings.",
      "Embeddings are optional: this no-ops cleanly when no embedding provider is configured.",
    ],
    parameters: Type.Object({
      force: Type.Optional(
        Type.Boolean({ description: "Re-embed every page, ignoring staleness (default: false)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      if (runtime) runtime.ensureConfig(ctx.cwd ?? paths.root);
      const embedder = runtime ? resolveEmbedder(runtime.config) : undefined;
      if (!embedder) {
        return {
          content: [
            {
              type: "text",
              text: 'ℹ️ No embedding provider configured — semantic embeddings are disabled. Set `llm-wiki.embeddingProvider` (e.g. "openai") in settings to enable.',
            },
          ],
          details: { enabled: false } as Record<string, unknown>,
        };
      }

      // Embedding is network-bound and O(pages) — run it in the background and
      // report the stats on completion (issue #77).
      return dispatchReported(runtime, ctx as ToolCtx, {
        label: `reindex_embeddings:${paths.root}`,
        started: `\u{1F9E0} LLM Wiki: embedding reindex started in the background (${embedder.model}) — stats will be reported when it completes.`,
        details: { enabled: true, model: embedder.model },
        work: async () => {
          const stats = await reindexEmbeddings(paths, embedder, { force: params.force === true });
          appendEvent(paths, {
            kind: "reindex_embeddings",
            embedded: stats.embedded,
            skipped: stats.skipped,
            pruned: stats.pruned,
            model: embedder.model,
          });
          return `✅ LLM Wiki: embeddings reindexed (${embedder.model}) — ${stats.embedded} embedded, ${stats.skipped} fresh, ${stats.pruned} pruned.`;
        },
      });
    },
  });
}

export function registerWikiLogEvent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_log_event",
    label: "Wiki Log Event",
    description: "Append a structured event to meta/events.jsonl and regenerate meta/log.md.",
    promptSnippet: "Log an event to the wiki activity log",
    promptGuidelines: ["Use wiki_log_event to record significant actions manually."],
    parameters: Type.Object({
      kind: Type.String({ description: "Event kind (e.g., ingest, query, decision)" }),
      details: Type.Optional(Type.Object({}, { description: "Additional event fields" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      appendEvent(paths, { kind: params.kind, ...params.details });

      // Regenerate log.md
      const { buildLogMarkdown } = await import("./metadata.js");
      const log = buildLogMarkdown(paths);
      writeFileSync(join(paths.meta, "log.md"), log, "utf-8");

      return {
        content: [{ type: "text", text: `✅ Event logged: ${params.kind}` }],
        details: { kind: params.kind } as Record<string, unknown>,
      };
    },
  });
}

// ─── 10. wiki_watch ─────────────────────────────────────

export function registerWikiWatch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_watch",
    label: "Wiki Watch",
    description: "Schedule automatic wiki updates (discover → ingest → lint) via pi's cron system.",
    promptSnippet: "Schedule auto-updates for the wiki",
    promptGuidelines: [
      "Use wiki_watch when the user wants the wiki to stay current automatically.",
    ],
    parameters: Type.Object({
      interval: Type.String({ description: "daily, weekly, hourly, or stop" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.interval === "stop") {
        return {
          content: [
            {
              type: "text",
              text: [
                "🛑 To stop wiki auto-updates:",
                "",
                "```",
                "schedule_prompt action=list",
                "```",
                "Find the wiki job IDs, then:",
                "",
                "```",
                "schedule_prompt action=remove jobId=<id>",
                "```",
              ].join("\n"),
            },
          ],
          details: { action: "stop_instructions" } as Record<string, unknown>,
        };
      }

      const intervals: Record<string, { cron: string; label: string }> = {
        daily: { cron: "0 0 8 * * *", label: "Daily at 8:00 AM" },
        weekly: { cron: "0 0 9 * * 1", label: "Weekly on Monday at 9:00 AM" },
        hourly: { cron: "0 0 * * * *", label: "Every hour" },
      };

      const config = intervals[params.interval];
      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: `❌ Unknown interval: "${params.interval}". Use: daily, weekly, hourly, or stop.`,
            },
          ],
          details: { error: "bad_interval" } as Record<string, unknown>,
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `⏰ To set up ${config.label} wiki updates, run:`,
              "",
              "```",
              `schedule_prompt action=add schedule="${config.cron}" prompt="Run /wiki:run for the LLM Wiki" name="llm-wiki-autoupdate"`,
              "```",
              "",
              "This will auto-discover, ingest, and lint on schedule.",
            ].join("\n"),
          },
        ],
        details: {
          interval: params.interval,
          cronSchedule: config.cron,
          label: config.label,
        } as Record<string, unknown>,
      };
    },
  });
}
