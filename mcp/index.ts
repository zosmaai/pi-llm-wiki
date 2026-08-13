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
import { getVaultPaths, resolveVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { createExecApi } from "./exec.js";
import {
  bootstrapOperation,
  captureSourceOperation,
  recallOperation,
  reindexOperation,
  retroOperation,
  searchOperation,
  statusOperation,
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
    const result = await retroOperation(paths, slug, title, body, category);

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
