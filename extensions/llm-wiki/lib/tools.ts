import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { bootstrapVault } from "./bootstrap.js";
import { launchEmbedPages, reindexEmbeddings, resolveEmbedder } from "./embeddings.js";
import { scheduleReindex } from "./indexing.js";
import { runIngestSynthesis } from "./ingest-worker.js";
import {
  createKnowledgeDocument,
  serializeKnowledgeDocument,
  writeKnowledgeDocumentFile,
} from "./knowledge-document.js";
import { buildResolvedBacklinks } from "./knowledge-links.js";
import { repairLegacyKnowledgeDocuments } from "./legacy-repair.js";
import { type Registry, appendEvent, rebuildMetadata, rebuildMetadataLight } from "./metadata.js";
import { readQmdIndexStatus, reindexQmdVault } from "./qmd-indexing.js";
import type { Runtime } from "./runtime.js";
import { captureFile, captureText, captureUrl } from "./source-packet.js";
import { parseModelRef } from "./task-config.js";
import {
  type VaultPaths,
  detectVaultFormat,
  fmtDate,
  getVaultPaths,
  readJson,
  resolveVaultPaths,
  slugify,
  writeJson,
} from "./utils.js";
import {
  assertWritableVault,
  compareCodePoint,
  discoverKnowledgeDocuments,
  inspectVaultFormat,
  inspectWritableVault,
} from "./vault-format.js";
import { getWikiStatus, reindexWiki, searchRegistry } from "./wiki-service.js";

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
      const result = bootstrapVault(paths, { topic: params.topic, mode });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Wiki vault error: ${result.diagnostics[0].message}` }],
          details: {
            error: result.diagnostics[0].code,
            diagnostics: result.diagnostics,
          } as Record<string, unknown>,
          isError: true,
        };
      }
      if (!result.projection.ok) {
        return {
          content: [
            {
              type: "text",
              text: `✅ Wiki bootstrapped but projection rebuild had issues: ${result.projection.diagnostics
                .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
                .join("; ")}`,
            },
          ],
          details: {
            root,
            mode,
            topic: params.topic,
            diagnostics: result.projection.diagnostics,
          } as Record<string, unknown>,
        };
      }

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
      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
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
      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
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
        // Vault-relative path used in tool messages so the read tool can open
        // the file from the vault root (fix #101: agent previously got
        // "raw/sources/..." and failed on new-layout vaults).
        const relRaw = relative(paths.root, paths.rawSources);
        return { id, extracted, manifest, relRaw };
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
                synthesisLanguage: runtime.config.synthesisLanguage,
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
                  `  - Read: \`${s.relRaw}/${s.id}/extracted.md\``,
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
        description:
          "Page type: entity | concept | synthesis | analysis | requirement | skill | case",
      }),
      title: Type.String({ description: "Page title" }),
      content: Type.Optional(
        Type.String({ description: "Optional initial content (otherwise uses template)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
          isError: true,
        };
      }

      const type = params.type as
        | "entity"
        | "concept"
        | "synthesis"
        | "analysis"
        | "requirement"
        | "skill"
        | "case";
      const slug = slugify(params.title);

      const folderMap: Record<string, string> = {
        entity: "entities",
        concept: "concepts",
        synthesis: "syntheses",
        analysis: "analyses",
        requirement: "requirements",
        skill: "skills",
        case: "cases",
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
      const body = params.content ?? buildPageBody(type, params.title);
      const doc = createKnowledgeDocument(
        `${folder}/${slug}.md`,
        {
          type,
          title: params.title,
          created: today,
          updated: today,
        },
        body,
      );
      mkdirSync(join(paths.wiki, folder), { recursive: true });
      writeKnowledgeDocumentFile(pagePath, doc);

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

function buildPageBody(type: string, title: string): string {
  if (type === "entity") {
    return `# ${title}

One-line description.

## Overview

[Key facts]

## Links

- [related-page](/concepts/related-page.md)`;
  }
  if (type === "concept") {
    return `# ${title}

One-line definition.

## Definition

[Clear explanation]

## Links

- [related-page](/concepts/related-page.md)`;
  }
  if (type === "synthesis") {
    return `# ${title}

Cross-cutting analysis.

## Question

[What drove this?]

## Links

- [related-page](/concepts/related-page.md)`;
  }
  if (type === "analysis") {
    return `# ${title}

Durable answer from a query.

## Question

[Original question]

## Links

- [related-page](/concepts/related-page.md)`;
  }
  if (type === "skill") {
    return `# ${title}

_One-line summary of the reusable pattern this skill captures._

## When to Use

[Trigger conditions — when this pattern applies]

## Procedure

1. [Step 1]
2. [Step 2]

## Pitfalls

- [Known failure mode or caveat]

## Distilled From

_Trajectories this skill was generalized from._

- [trajectories/TRJ-...](/trajectories/TRJ-....md)`;
  }
  if (type === "case") {
    return `# ${title}

_One-line summary of the specific task this case records._

## Task

[What was requested]

## Approach

[How the agent solved it — key steps and decisions]

## Outcome

[Result, and anything worth reusing or avoiding next time]

## Trajectory

- [trajectories/TRJ-...](/trajectories/TRJ-....md) — captured tool-call run`;
  }
  if (type === "requirement") {
    return `# ${title}

## Description

[Clear description of what this requirement entails]

## Acceptance Criteria

- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Dependencies

_Pages this requirement depends on._

## Implementation Notes

[Optional notes]

## Sources

- [sources/SRC-...](/sources/SRC-....md) — original concept capture`;
  }
  return `# ${title}

[Description to be filled]

## Links

- [related-page](/concepts/related-page.md)`;
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
      const result = searchRegistry(paths, params.query, params.type);

      if (result.matches.length === 0) {
        return {
          content: [{ type: "text", text: `No pages found for "${params.query}"` }],
          details: { query: params.query, matches: [], diagnostics: result.diagnostics } as Record<
            string,
            unknown
          >,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `🔍 **${result.matches.length} result(s)** for "${params.query}":`,
              "",
              ...result.matches.map((m) => `- [[${m.id}]] — *${m.type}* — ${m.title}`),
            ].join("\n"),
          },
        ],
        details: {
          query: params.query,
          matches: result.matches,
          diagnostics: result.diagnostics,
        } as Record<string, unknown>,
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
      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
          isError: true,
        };
      }

      // Full-vault scan (+ optional auto-fix writes + reindex) is O(pages):
      // run it in the background and report the health summary (issue #77).
      return dispatchReported(runtime, ctx as ToolCtx, {
        label: `lint:${paths.root}`,
        started:
          "\u{1F9F9} LLM Wiki: lint started in the background — the health report will be posted with your next message.",
        work: async () => runWikiLint(paths, params.auto_fix === true),
      });
    },
  });
}

/**
 * Run the wiki health scan (issue #77 extracted it from the tool body so it can
 * run off-thread via `dispatchReported`). Returns the human-readable summary.
 */
async function runWikiLint(paths: VaultPaths, autoFix: boolean): Promise<string> {
  assertWritableVault(paths);
  const qmdStatus = await readQmdIndexStatus(paths);
  let repair: ReturnType<typeof repairLegacyKnowledgeDocuments> | undefined;
  if (autoFix) {
    let projection = rebuildMetadata(paths);
    repair = !projection.ok ? repairLegacyKnowledgeDocuments(paths) : undefined;
    if (repair?.repaired) projection = rebuildMetadata(paths);
    if (!projection.ok) {
      return [
        "# Wiki Lint Report",
        "",
        repair?.repaired ? `Legacy pages repaired: ${repair.repaired}` : "",
        repair?.manifestPath ? `Repair manifest: ${repair.manifestPath}` : "",
        "Projection-blocking diagnostics:",
        ...projection.diagnostics.map(
          (diagnostic) => `- ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`,
        ),
      ]
        .filter(Boolean)
        .join("\n");
    }
  } else {
    const vault = inspectVaultFormat(paths);
    const audit = discoverKnowledgeDocuments(paths);
    const diagnostics = [...vault.diagnostics, ...audit.diagnostics];
    if (vault.blocking || audit.blocking) {
      return [
        "# Wiki Lint Report",
        "",
        "Projection-blocking diagnostics:",
        ...diagnostics.map(
          (diagnostic) => `- ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`,
        ),
      ].join("\n");
    }
  }

  const discovery = discoverKnowledgeDocuments(paths);
  const pages = discovery.documents;
  const knownIds = new Set(pages.map((page) => page.id));
  const inbound = Object.fromEntries(pages.map((page) => [page.id, 0]));
  const gapSources = new Map<string, Set<string>>();
  const findings: string[] = [];
  let missingPages = 0;
  let contradictions = 0;

  for (const page of pages) {
    const resolved = buildResolvedBacklinks(page.id, page.body, knownIds);
    for (const target of resolved.targets) inbound[target]++;
    for (const unresolved of resolved.unresolved) {
      const sources = gapSources.get(unresolved.target) ?? new Set<string>();
      sources.add(page.id);
      gapSources.set(unresolved.target, sources);
      missingPages++;
      findings.push(`Missing page: ${unresolved.target} (in ${page.id})`);
    }
  }

  let orphans = 0;
  for (const page of pages) {
    if (inbound[page.id] === 0) {
      orphans++;
      findings.push(`Orphan: ${page.id} has no inbound links`);
    }
    if (page.body.includes("⚠️ **Contradiction")) {
      contradictions++;
      findings.push(`Contradiction flagged in ${page.id}`);
    }
  }

  const gaps = [...gapSources.entries()]
    .map(([topic, sources]) => ({ topic, mentionedBy: [...sources].sort(compareCodePoint) }))
    .sort((left, right) => compareCodePoint(left.topic, right.topic));
  let fixesApplied = 0;
  if (autoFix) {
    for (const gap of gaps) {
      if (gap.mentionedBy.length < 2) continue;
      const parts = gap.topic.split("/");
      const name =
        parts.length === 1
          ? parts[0]
          : parts.length === 2 && parts[0] === "concepts"
            ? parts[1]
            : "";
      if (!name || slugify(name) !== name) continue;
      const pagePath = join(paths.wiki, "concepts", `${name}.md`);
      mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
      const document = createKnowledgeDocument(
        `concepts/${name}.md`,
        {
          type: "concept",
          title: name.replace(/-/g, " "),
          created: fmtDate(),
          updated: fmtDate(),
          status: "stub",
        },
        `_Stub auto-created by lint. Expand with content from: ${gap.mentionedBy
          .map((source) => `[${source}](/${source}.md)`)
          .join(", ")}_`,
      );
      try {
        writeFileSync(pagePath, serializeKnowledgeDocument(document), {
          encoding: "utf8",
          flag: "wx",
        });
        fixesApplied++;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  const reportLines = [
    "# Wiki Lint Report",
    `Generated: ${fmtDate()}`,
    "",
    "## Summary",
    `- Total pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing pages: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    autoFix ? `- Missing-page fixes applied: ${fixesApplied}` : "",
    repair?.repaired ? `- Legacy pages repaired: ${repair.repaired}` : "",
    repair?.manifestPath ? `- Repair manifest: ${repair.manifestPath}` : "",
    "",
    "## Findings",
    findings.length ? findings.map((finding) => `- ${finding}`).join("\n") : "✅ No issues found!",
    "",
  ].filter(Boolean);
  const reportPath = autoFix ? join(paths.outputs, `lint-${fmtDate()}.md`) : undefined;
  // The gap snapshot is generated discovery metadata consumed by wiki_status:
  // persist it on every successful lint so status never reports a stale count.
  // Corrective actions below (report, event, meta rebuild) stay autoFix-only.
  writeJson(join(paths.discoveries, "gaps.json"), {
    gaps,
    generated: new Date().toISOString(),
  });
  if (autoFix && reportPath) {
    mkdirSync(paths.outputs, { recursive: true });
    writeFileSync(reportPath, `${reportLines.join("\n")}\n`, "utf8");
    appendEvent(paths, {
      kind: "lint",
      orphans,
      missing_pages: missingPages,
      contradictions,
      auto_fix: true,
      legacy_pages_repaired: repair?.repaired ?? 0,
    });
    rebuildMetadataLight(paths);
  }

  const qmdFindings: string[] = [];
  if (qmdStatus.state === "stale") {
    const components = JSON.stringify(
      qmdStatus.repairComponents.length > 0 ? qmdStatus.repairComponents : ["lexical"],
    );
    qmdFindings.push(
      `- QMD index stale (${qmdStatus.indexedManifestHash ? "manifest or model changed" : ""}): repair with \`wiki_reindex(scope=\"changed\", components=${components}, vault=\"active\")\``,
    );
  } else if (qmdStatus.state === "recovering") {
    qmdFindings.push(
      `- QMD swap interrupted (${qmdStatus.swapPhase ?? ""}): restart recovery via \`wiki_reindex(vault=\"active\")\``,
    );
  } else if (qmdStatus.state === "error") {
    qmdFindings.push(
      `- QMD index error: ${qmdStatus.issues[0]?.message ?? "repair with wiki_reindex"} — \`wiki_reindex(scope=\"changed\", components=${JSON.stringify(qmdStatus.repairComponents.length > 0 ? qmdStatus.repairComponents : ["lexical"])}, vault=\"active\")\``,
    );
  } else if (qmdStatus.state === "missing") {
    qmdFindings.push("- QMD index not built yet (informational): run wiki_reindex to build it");
  }

  return [
    "🧹 **LLM Wiki lint complete**",
    "",
    `- Pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    autoFix ? `- Missing-page fixes: ${fixesApplied}` : "",
    repair?.repaired ? `- Legacy pages repaired: ${repair.repaired}` : "",
    "",
    reportPath ? `📄 Report: \`${reportPath}\`` : "",
    repair?.manifestPath ? `🛟 Repair manifest: \`${repair.manifestPath}\`` : "",
    gaps.length ? `💡 ${gaps.length} knowledge gap(s) tracked` : "",
    "",
    "## QMD Index",
    `- State: ${qmdStatus.state}`,
    ...qmdFindings,
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

      const status = await getWikiStatus(paths);
      const config = readJson<Record<string, unknown>>(join(paths.dotWiki, "config.json"), {});
      const backlinks = readJson<Record<string, string[]>>(join(paths.meta, "backlinks.json"), {});

      const orphanCount = Object.entries(backlinks).filter(
        ([, inbound]) => inbound.length === 0,
      ).length;
      const gaps = readJson<{ gaps?: unknown[] }>(join(paths.discoveries, "gaps.json"), {
        gaps: [],
      });

      const health =
        status.totalPages === 0 ? "🔴 Empty" : orphanCount > 5 ? "⚠️ Warning" : "✅ Good";

      const diagLines =
        status.blockingDiagnostics.length > 0
          ? [
              "",
              "⚠️ Blocking diagnostics:",
              ...status.blockingDiagnostics.map((d) => `  - ${d.code}: ${d.message}`),
            ]
          : [];

      const lines = [
        "📊 LLM Wiki Status",
        "══════════════════",
        `Topic: ${config.topic || "Unknown"}`,
        `Mode: ${config.mode || "personal"}`,
        `Knowledge format: ${status.knowledgeFormat}`,
        `Pages: ${status.totalPages}`,
        ...Object.entries(status.byType).map(([t, c]) => `  - ${t}s: ${c}`),
        `Orphans: ${orphanCount}`,
        `Gaps: ${gaps.gaps?.length || 0}`,
        `Health: ${health}`,
        `Last updated: ${status.lastUpdated || "Never"}`,
        `QMD index: ${status.qmd.state}`,
        `QMD documents: ${status.qmd.totalDocuments} (${status.qmd.canonicalDocuments} canonical, ${status.qmd.evidenceDocuments} evidence)`,
        `QMD embeddings pending: ${status.qmd.needsEmbedding}`,
        `QMD package: ${status.qmd.qmdVersion}`,
        ...diagLines,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          topic: config.topic,
          mode: config.mode,
          knowledgeFormat: status.knowledgeFormat,
          totalPages: status.totalPages,
          byType: status.byType,
          orphans: orphanCount,
          gaps: gaps.gaps?.length || 0,
          health,
          blockingDiagnostics: status.blockingDiagnostics,
          qmd: status.qmd,
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
      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
          isError: true,
        };
      }

      // Heavy O(pages) rebuild — dispatch off the agent's critical path and
      // report on completion (issue #77).
      return dispatchReported(runtime, ctx as ToolCtx, {
        label: `rebuild_meta:${paths.root}`,
        started:
          "\u{1F9E0} LLM Wiki: metadata rebuild started in the background — the result will be reported with your next message.",
        work: async () => {
          const result = rebuildMetadata(paths);
          // No rebuild_meta event — rebuild is a projection, not an authoritative mutation
          if (!result.ok) {
            return `⚠️ LLM Wiki: rebuild had issues — ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`;
          }
          const warnings = result.diagnostics.filter(
            (diagnostic) => diagnostic.severity === "warning",
          );
          // After a successful projection, keep the generated QMD index in sync
          // (model-free lexical pass). A QMD failure is a warning, never a
          // projection failure.
          const qmdResult = await reindexQmdVault(paths, {
            scope: "changed",
            components: ["lexical"],
            force: false,
          });
          if (!qmdResult.ok) {
            warnings.push({
              severity: "warning" as const,
              code: "qmd_index_error" as const,
              path: paths.qmd,
              message: qmdResult.errors[0]?.message ?? "QMD indexing failed",
            });
          }
          if (warnings.length > 0) {
            return `⚠️ LLM Wiki: metadata rebuilt with warnings — ${warnings
              .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
              .join("; ")}`;
          }
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
      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
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
        started: `\u{1F9E0} LLM Wiki: embedding reindex started in the background (${embedder.model}) — stats will be reported with your next message.`,
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

export function registerWikiReindex(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_reindex",
    label: "Wiki Reindex QMD",
    description:
      "Rebuild or repair the generated QMD index (meta/qmd) for the vault. " +
      "Lexical indexing is model-free; selecting vectors may download " +
      "approximately 2 GB of models on first use. Repair stale/error state. " +
      "Active recall still uses the legacy heuristic until Phase 3.",
    promptSnippet: "Rebuild the QMD search index",
    promptGuidelines: [
      "Use wiki_reindex to repair a stale, error, or recovering QMD index.",
      "Lexical-only reindexing never loads a model.",
      "Vector reindexing may download approximately 2 GB of models on first use.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal("changed"), Type.Literal("all")], { default: "changed" }),
      ),
      components: Type.Optional(
        Type.Array(Type.Union([Type.Literal("lexical"), Type.Literal("vectors")]), {
          minItems: 1,
          uniqueItems: true,
          default: ["lexical", "vectors"],
        }),
      ),
      force: Type.Optional(Type.Boolean({ default: false })),
      vault: Type.Optional(
        Type.Union(
          [
            Type.Literal("active"),
            Type.Literal("personal"),
            Type.Literal("project"),
            Type.Literal("all"),
          ],
          { default: "active" },
        ),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const paths = getPaths(ctx.cwd);
      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
          isError: true,
        };
      }

      const scope = params.scope ?? "changed";
      const components = params.components ?? ["lexical", "vectors"];
      const force = params.force === true;
      const vault = params.vault ?? "active";
      const lexicalOnly = components.length === 1 && components[0] === "lexical";

      // Warn before any vector work so the operator expects a large download.
      if (components.includes("vectors") && signal && signal.aborted) {
        return {
          content: [{ type: "text", text: "QMD reindex cancelled before it started." }],
          details: { cancelled: true } as Record<string, unknown>,
          isError: true,
        };
      }

      const result = await reindexWiki(paths, {
        scope,
        components,
        force,
        vault,
        signal,
      });

      const ok = result.results.every((r) => r.result.ok);
      const lines = [
        ok ? "✅ QMD indexing complete" : "⚠️ QMD indexing completed with errors",
        ...result.results.map((r) => {
          const st = r.result.status;
          return `- ${r.label} (${r.root}): state=${st.state}, documents=${st.totalDocuments}, indexed=${r.result.documents.indexed}, updated=${r.result.documents.updated}, removed=${r.result.documents.removed}, vectors=${r.result.vectors.generated}`;
        }),
      ];
      if (lexicalOnly) lines.push("Model-free lexical indexing — no model was downloaded.");
      if (components.includes("vectors")) {
        lines.push("⚠️ Vector indexing may download approximately 2 GB of models on first use.");
      }
      for (const r of result.results) {
        for (const e of r.result.errors) lines.push(`- [${r.label}] ${e.code}: ${e.message}`);
        for (const w of r.result.warnings) lines.push(`- [${r.label}] ${w.code}: ${w.message}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { scope, components, ...result } as Record<string, unknown>,
        ...(ok ? {} : { isError: true }),
      };
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
      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
          isError: true,
        };
      }

      const kind = typeof params.kind === "string" ? params.kind.trim() : "";
      if (!kind) {
        return {
          content: [{ type: "text", text: "Event kind must be a non-empty string" }],
          details: { error: "event_missing_kind" } as Record<string, unknown>,
          isError: true,
        };
      }
      const details = params.details ?? {};
      if (Object.hasOwn(details, "kind") || Object.hasOwn(details, "timestamp")) {
        return {
          content: [{ type: "text", text: "Event details cannot override kind or timestamp" }],
          details: { error: "event_reserved_field" } as Record<string, unknown>,
          isError: true,
        };
      }

      appendEvent(paths, { kind, ...details });

      // Regenerate projections
      rebuildMetadata(paths);

      return {
        content: [{ type: "text", text: `✅ Event logged: ${kind}` }],
        details: { kind } as Record<string, unknown>,
      };
    },
  });
}

// ─── 10. wiki_watch ─────────────────────────────────────

export function registerWikiWatch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_watch",
    label: "Wiki Watch",
    description:
      "Print a ready-to-paste crontab line for scheduling automatic wiki updates (discover → ingest → lint). Does NOT schedule anything itself — it returns the command for the user to install.",
    promptSnippet: "Schedule auto-updates for the wiki",
    promptGuidelines: [
      "Use wiki_watch when the user wants the wiki to stay current automatically.",
      "wiki_watch only PRINTS a cron line — surface the output to the user verbatim so they can install it. Do not claim the schedule is active.",
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
                "🛑 To stop wiki auto-updates, remove the cron line you installed earlier:",
                "",
                "```bash",
                "crontab -e   # then delete the line tagged '# llm-wiki-autoupdate'",
                "```",
                "",
                "Or list current jobs to confirm:",
                "",
                "```bash",
                "crontab -l | grep llm-wiki-autoupdate",
                "```",
              ].join("\n"),
            },
          ],
          details: { action: "stop_instructions" } as Record<string, unknown>,
        };
      }

      // 5-field POSIX crontab expressions (min hour dom month dow).
      const intervals: Record<string, { cron: string; label: string }> = {
        daily: { cron: "0 8 * * *", label: "Daily at 8:00 AM" },
        weekly: { cron: "0 9 * * 1", label: "Weekly on Monday at 9:00 AM" },
        hourly: { cron: "0 * * * *", label: "Every hour" },
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

      // Robustness for global crontab environments:
      //   * `/bin/bash -lc` runs a LOGIN shell that sources /etc/profile +
      //     ~/.profile / ~/.bash_profile, so npm-global / bun / nvm PATH
      //     additions are imported — cron's default PATH is only
      //     `/usr/bin:/bin` and would not find `pi`.
      //   * `mkdir -p` makes the log dir self-healing for users with only
      //     a project vault (no `~/.llm-wiki/` yet).
      //   * All `$HOME` references are double-quoted to survive paths with spaces.
      //   * `# llm-wiki-autoupdate` tags the line so the user can find and
      //     remove it via `crontab -e` later (see `interval=stop`).
      const cronLine = `${config.cron} /bin/bash -lc 'mkdir -p "$HOME/.llm-wiki" && pi -p "/wiki-run" >> "$HOME/.llm-wiki/cron.log" 2>&1' # llm-wiki-autoupdate`;

      return {
        content: [
          {
            type: "text",
            text: [
              `⏰ To set up ${config.label} wiki updates, add this line to your crontab.`,
              "**This tool only prints the line — it does not install it.**",
              "",
              "```bash",
              "crontab -e",
              "```",
              "",
              "Then append:",
              "",
              "```cron",
              cronLine,
              "```",
              "",
              `The line uses \`/bin/bash -lc\` so your shell profile (and the \`pi\` binary on npm-global / bun PATH) is loaded. Output goes to \`~/.llm-wiki/cron.log\`. If your system has no \`/bin/bash\`, replace with \`/bin/sh -c\` and ensure \`pi\` is in cron's PATH yourself.`,
            ].join("\n"),
          },
        ],
        details: {
          interval: params.interval,
          cronSchedule: config.cron,
          label: config.label,
          cronLine,
          installed: false,
        } as Record<string, unknown>,
      };
    },
  });
}
