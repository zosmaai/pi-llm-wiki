#!/usr/bin/env node

/**
 * LLM Wiki MCP Server
 *
 * Exposes wiki tools over the Model Context Protocol (MCP).
 * Run: node dist/mcp/index.js
 *
 * Environment:
 *   WIKI_ROOT — path to wiki vault (default: auto-detect from cwd)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { recoverQmdIndex } from "../extensions/llm-wiki/lib/qmd-indexing.js";
import {
  loadTaskConfig,
  resolveWikilinkValidation,
} from "../extensions/llm-wiki/lib/task-config.js";
import { getVaultPaths, resolveVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { createExecApi } from "./exec.js";
import {
  bootstrapOperation,
  captureSourceOperation,
  ensurePageOperation,
  ingestOperation,
  lintOperation,
  logEventOperation,
  observeOperation,
  rebuildMetaOperation,
  recallOperation,
  reindexEmbeddingsOperation,
  reindexOperation,
  retroOperation,
  searchOperation,
  statusOperation,
  watchOperation,
} from "./operations.js";

const execApi = createExecApi();

// ─── Vault Detection ────────────────────────────────────

/** Resolve vault paths, same as Pi extension. */
function getPaths(): ReturnType<typeof resolveVaultPaths> {
  const root = process.env.WIKI_ROOT || process.cwd();
  return resolveVaultPaths(root);
}

/**
 * The vault root this server was configured with, without resolution.
 *
 * `getPaths()` RESOLVES an existing vault: on a root that has none it walks up
 * to a parent vault and then falls back to the personal vault. That is right
 * for reading and writing pages, and wrong for creating one — bootstrap must
 * create the vault where the client pointed the server, not wherever
 * resolution lands. The Pi tool draws the same distinction.
 */
function getConfiguredPaths(): ReturnType<typeof getVaultPaths> {
  return getVaultPaths(process.env.WIKI_ROOT || process.cwd());
}

function hasVault(): boolean {
  const paths = getPaths();
  return existsSync(join(paths.dotWiki, "config.json"));
}

// ─── MCP Server ─────────────────────────────────────────

const server = new McpServer({
  name: "llm-wiki",
  version: "1.0.0",
});

// ---- wiki_bootstrap ----
//
// Registered first, and the only tool not gated on an existing vault: the
// other tools fail closed with a message naming this one, which an MCP-only
// client could not act on while it was extension-only (issue #130).

server.registerTool(
  "wiki_bootstrap",
  {
    description:
      "Create an LLM Wiki vault at this server's wiki root (WIKI_ROOT, or the working directory). Writes config, schema, templates and metadata scaffolding. Run this first when no vault exists; safe to re-run on an existing vault, where it updates the config and rebuilds metadata without touching pages.",
    inputSchema: z.object({
      topic: z.string().describe("Main topic of the wiki"),
      mode: z.string().optional().describe("personal or company (default: personal)"),
    }),
  },
  async ({ topic, mode }) => {
    const paths = getConfiguredPaths();
    const result = await bootstrapOperation(paths, { topic, mode });

    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Vault error: ${result.diagnostics[0].message}`,
          },
        ],
        isError: true,
      };
    }

    const warnings = result.diagnostics.map((d) => `⚠️ ${d.code}: ${d.message}`);
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `${result.created ? "Wiki vault created" : "Wiki vault updated"} at ${paths.root}`,
            "Structure: .llm-wiki/{raw,wiki,meta} plus config and WIKI_SCHEMA.md",
            "Next: capture a source with wiki_capture_source, or save an insight with wiki_retro.",
            ...warnings,
          ].join("\n"),
        },
      ],
    };
  },
);

// ---- wiki_recall ----

server.registerTool(
  "wiki_recall",
  {
    description:
      "Search the wiki for pages relevant to a query. Searches the resolved vault and the personal vault (~/.llm-wiki) together, deduplicated, with personal hits labelled. Returns matching page IDs, titles, types, and content previews.",
    inputSchema: z.object({
      query: z.string().describe("Search query — use the user's full request or key terms"),
      max_results: z.number().optional().default(5).describe("Max results (default: 5, max: 10)"),
    }),
  },
  async ({ query, max_results }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }

    const paths = getPaths();
    const result = await recallOperation(paths, query, Math.min(max_results ?? 5, 10));

    const detailLines = result.diagnostics.map((d) => `⚠️ ${d.code}: ${d.message}`);
    const detailText = detailLines.length > 0 ? `\n\n${detailLines.join("\n")}` : "";

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.results, null, 2) + detailText,
        },
      ],
    };
  },
);

// ---- wiki_search ----

server.registerTool(
  "wiki_search",
  {
    description: "Search the wiki registry for pages matching a query.",
    inputSchema: z.object({
      query: z.string().describe("Search term"),
      type: z
        .string()
        .optional()
        .describe("Filter by page type (source, entity, concept, synthesis, analysis)"),
    }),
  },
  async ({ query, type }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }

    const paths = getPaths();
    const result = await searchOperation(paths, query, type);

    if (result.matches.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No pages found for "${query}"` }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.matches, null, 2),
        },
      ],
    };
  },
);

// ---- wiki_status ----

server.registerTool(
  "wiki_status",
  {
    description: "Show wiki health and stats: page counts, orphans, recent activity.",
    inputSchema: z.object({}),
  },
  async () => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }

    const paths = getPaths();
    const status = await statusOperation(paths);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  },
);

// ---- wiki_reindex ----

server.registerTool(
  "wiki_reindex",
  {
    description:
      "Rebuild or repair the generated QMD search index (meta/qmd) for the vault. " +
      "Lexical indexing is model-free; selecting vectors may download approximately 2 GB " +
      "of models on first use. Options: scope (changed|all), components (lexical|vectors), " +
      "force, vault (active|personal|project|all).",
    inputSchema: z.object({
      scope: z.enum(["changed", "all"]).optional().default("changed").describe("changed or all"),
      components: z
        .array(z.enum(["lexical", "vectors"]))
        .min(1)
        .optional()
        .describe("Index components (lexical|vectors)"),
      force: z.boolean().optional().describe("Force full rebuild of selected components"),
      vault: z
        .enum(["active", "personal", "project", "all"])
        .optional()
        .default("active")
        .describe("Which vaults to reindex"),
    }),
  },
  async ({ scope, components, force, vault }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }

    const paths = getPaths();
    const result = await reindexOperation(paths, {
      scope,
      components,
      force,
      vault,
    });

    const ok = result.results.every((r) => r.result.ok);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      ...(ok ? {} : { isError: true as const }),
    };
  },
);

// ---- wiki_retro ----

server.registerTool(
  "wiki_retro",
  {
    description:
      "Save an atomic insight from a completed task into the wiki. Creates a source page.",
    inputSchema: z.object({
      slug: z.string().describe("Unique kebab-case identifier (e.g. 'jwt-revocation-pattern')"),
      title: z.string().describe("Short descriptive title (60 chars max)"),
      body: z.string().describe("Markdown body explaining what was learned."),
      category: z
        .string()
        .optional()
        .describe("Category (e.g. frontend, architecture, devops, bugfix)"),
    }),
  },
  async ({ slug, title, body, category }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }

    const paths = getPaths();
    const result = await retroOperation(
      paths,
      slug,
      title,
      body,
      category,
      resolveWikilinkValidation(loadTaskConfig(process.cwd())),
    );

    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Vault error: ${result.diagnostics[0].message}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Insight saved: ${result.slug} — ${title}`,
        },
      ],
    };
  },
);

// ---- wiki_capture_source ----

server.registerTool(
  "wiki_capture_source",
  {
    description: "Capture a URL, local file, or pasted text into an immutable source packet.",
    inputSchema: z.object({
      text: z.string().optional().describe("Text content to capture"),
      url: z.string().optional().describe("URL to capture"),
      file_path: z.string().optional().describe("Local file path to capture"),
      title: z.string().optional().describe("Title for the captured source"),
    }),
  },
  async ({ text, url, file_path, title }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }

    const paths = getPaths();
    const result = await captureSourceOperation(
      paths,
      { text, url, filePath: file_path, title },
      execApi,
    );

    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: result.diagnostics[0].message,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Source captured: ${result.sourceId}`,
        },
      ],
    };
  },
);

// ---- wiki_ensure_page ----

server.registerTool(
  "wiki_ensure_page",
  {
    description:
      "Resolve or safely create a canonical wiki page. Returns the page path. " +
      "Content may begin with a YAML frontmatter block; its fields are merged into " +
      "the page frontmatter, and generated fields (type, title, created, updated, " +
      "sources) are reserved and ignored.",
    inputSchema: z.object({
      type: z.string().describe("Page type"),
      title: z.string().describe("Page title"),
      content: z.string().optional().describe("Optional Markdown body"),
    }),
  },
  async ({ type, title, content }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }
    const paths = getPaths();
    const result = await ensurePageOperation(paths, { type, title, content });
    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Vault error: ${result.diagnostics[0].message}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: result.created
            ? `✅ Created ${result.path}`
            : `✅ Page already exists: \`${result.path}\``,
        },
      ],
    };
  },
);

// ---- wiki_lint ----

server.registerTool(
  "wiki_lint",
  {
    description:
      "Health check the wiki. Scans for orphans, missing pages, contradictions, gaps. Optionally auto-fixes.",
    inputSchema: z.object({
      auto_fix: z.boolean().optional().describe("Auto-fix orphans and missing pages"),
    }),
  },
  async ({ auto_fix }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }
    const paths = getPaths();
    const result = await lintOperation(paths, auto_fix === true);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Vault error: ${result.diagnostics[0].message}`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: result.report }] };
  },
);

// ---- wiki_log_event ----

server.registerTool(
  "wiki_log_event",
  {
    description: "Append a structured event to meta/events.jsonl and regenerate meta/log.md.",
    inputSchema: z.object({
      kind: z.string().describe("Event kind (e.g., ingest, query, decision)"),
      details: z.record(z.string(), z.unknown()).optional().describe("Additional event fields"),
    }),
  },
  async ({ kind, details }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }
    const paths = getPaths();
    const result = logEventOperation(paths, { kind, details });
    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: result.message }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: result.message }] };
  },
);

// ---- wiki_observe ----

server.registerTool(
  "wiki_observe",
  {
    description:
      "Record an atomic observation from the current session into the wiki. " +
      "Observations are timestamped, relevance-rated, and searchable via wiki_recall.",
    inputSchema: z.object({
      title: z.string().describe("Short descriptive title (<=80 chars). Noun phrase."),
      content: z.string().describe("The observation in plain prose"),
      relevance: z
        .enum(["low", "medium", "high", "critical"])
        .optional()
        .default("medium")
        .describe("Relevance level"),
      tags: z.string().optional().describe("Optional space-separated tags"),
      source_context: z.string().optional().describe("What was being worked on"),
    }),
  },
  async ({ title, content, relevance, tags, source_context }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }
    const paths = getPaths();
    const result = observeOperation(paths, {
      title,
      content,
      relevance: relevance ?? "medium",
      tags,
      source_context,
    });
    if (!result.ok) {
      return {
        content: [{ type: "text" as const, text: result.message }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: result.message }] };
  },
);

// ---- wiki_rebuild_meta ----

server.registerTool(
  "wiki_rebuild_meta",
  {
    description:
      "Force a full metadata rebuild (registry, backlinks, index, log). Use if metadata seems out of sync.",
    inputSchema: z.object({}),
  },
  async () => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }
    const paths = getPaths();
    const result = await rebuildMetaOperation(paths);
    return { content: [{ type: "text" as const, text: result.report }] };
  },
);

// ---- wiki_reindex_embeddings ----

server.registerTool(
  "wiki_reindex_embeddings",
  {
    description:
      "Backfill / refresh semantic embeddings for the vault. Embeds pages that are new " +
      "or stale (content changed); pass force to re-embed everything. No-op when no " +
      "embedding provider is configured.",
    inputSchema: z.object({
      force: z.boolean().optional().describe("Re-embed every page, ignoring staleness"),
    }),
  },
  async ({ force }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }
    const paths = getPaths();
    const result = await reindexEmbeddingsOperation(paths, force === true);
    return {
      content: [{ type: "text" as const, text: result.message }],
      ...(result.ok ? {} : { isError: true as const }),
    };
  },
);

// ---- wiki_watch ----

server.registerTool(
  "wiki_watch",
  {
    description:
      "Print a ready-to-paste crontab line for scheduling automatic wiki updates " +
      "(discover -> ingest -> lint). Does NOT schedule anything itself.",
    inputSchema: z.object({
      interval: z.enum(["daily", "weekly", "hourly", "stop"]).describe("Cron interval"),
    }),
  },
  async ({ interval }) => {
    const result = watchOperation({ interval });
    return {
      content: [{ type: "text" as const, text: result.message }],
      ...(result.ok ? {} : { isError: true as const }),
    };
  },
);

// ---- wiki_ingest ----

server.registerTool(
  "wiki_ingest",
  {
    description:
      "Process uningested source packets (captured with wiki_capture_source) by running " +
      "the synthesis sub-agent over the configured llm-wiki task model, then committing " +
      "pages. Runs synchronously over this server's model lane (llm-wiki.taskModel + " +
      "taskModelApiKey/taskModelBaseUrl). When no model is available, returns the " +
      "extracted content and instructions so the calling agent can synthesize itself.",
    inputSchema: z.object({
      source_id: z.string().optional().describe("Specific source ID to ingest"),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .default(3)
        .describe("Max sources to process (1-5)"),
      model: z.string().optional().describe("Per-call model override as 'provider/id'"),
    }),
  },
  async ({ source_id, batch_size, model }) => {
    if (!hasVault()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No wiki vault found. Set WIKI_ROOT or run wiki_bootstrap first.",
          },
        ],
        isError: true,
      };
    }
    const paths = getPaths();
    const result = await ingestOperation(paths, {
      source_id,
      batch_size,
      model,
    });
    return {
      content: [{ type: "text" as const, text: result.report }],
      ...(result.isError ? { isError: true as const } : {}),
    };
  },
);

// ─── Main ───────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🧠 LLM Wiki MCP Server running on stdio");

  // Fire-and-forget QMD index recovery AFTER the transport is connected so
  // clients are never blocked. A busy/live lock just logs a warning and MCP
  // continues with current state untouched.
  if (hasVault()) {
    const paths = getPaths();
    recoverQmdIndex(paths)
      .then((result) => {
        if (!result.ok) {
          console.error(
            `[llm-wiki] QMD recovery skipped: ${result.diagnostics[0]?.message ?? "locked"}`,
          );
        }
      })
      .catch((err) => console.error(`[llm-wiki] QMD recovery failed: ${(err as Error).message}`));
  }
}

main().catch((err) => {
  console.error("MCP Server error:", err);
  process.exit(1);
});
