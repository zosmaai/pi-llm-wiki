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
import { resolveVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { createExecApi } from "./exec.js";
import {
  captureSourceOperation,
  recallOperation,
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

function hasVault(): boolean {
  const paths = getPaths();
  return existsSync(join(paths.dotWiki, "config.json"));
}

// ─── MCP Server ─────────────────────────────────────────

const server = new McpServer({
  name: "llm-wiki",
  version: "1.0.0",
});

// ---- wiki_recall ----

server.registerTool(
  "wiki_recall",
  {
    description:
      "Search the wiki for pages relevant to a query. Returns matching page IDs, titles, types, and content previews.",
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
}

main().catch((err) => {
  console.error("MCP Server error:", err);
  process.exit(1);
});
