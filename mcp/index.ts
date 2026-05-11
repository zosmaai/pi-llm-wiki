#!/usr/bin/env node

/**
 * LLM Wiki MCP Server
 *
 * Exposes wiki tools over the Model Context Protocol (MCP).
 * Run: node mcp/index.js
 * Or via package.json: pi install npm:@zosmaai/pi-llm-wiki && node mcp/index.js
 *
 * Environment:
 *   WIKI_ROOT — path to wiki vault (default: auto-detect from cwd)
 *   WIKI_MARKITDOWN_TIMEOUT_MS — PDF extraction timeout (default: 180000)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

// ─── Wiki Vault Detection ──────────────────────────────

interface VaultPaths {
  root: string;
  rawSources: string;
  wiki: string;
  meta: string;
}

function resolveVaultRoot(cwd: string): string | null {
  if (existsSync(join(cwd, ".wiki", "config.json"))) return cwd;
  const parts = cwd.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const dir = parts.slice(0, i + 1).join("/") || "/";
    if (existsSync(join(dir, ".wiki", "config.json"))) return dir;
  }
  return null;
}

function getPaths(): VaultPaths {
  const root = process.env.WIKI_ROOT || resolveVaultRoot(process.cwd()) || process.cwd();
  return {
    root,
    rawSources: join(root, "raw", "sources"),
    wiki: join(root, "wiki"),
    meta: join(root, "meta"),
  };
}

function hasVault(): boolean {
  return existsSync(join(getPaths().root, ".wiki", "config.json"));
}

// ─── Helpers ────────────────────────────────────────────

function readJson<T>(path: string, defaultVal: T): T {
  try {
    if (!existsSync(path)) return defaultVal;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return defaultVal;
  }
}

function fmtDate(d = new Date()): string {
  return d.toISOString().split("T")[0];
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
    const registry = readJson<{
      pages: Record<string, { type: string; title: string; [key: string]: unknown }>;
    }>(join(paths.meta, "registry.json"), { pages: {} });

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 10);

    if (terms.length === 0) {
      return {
        content: [{ type: "text" as const, text: "Query too short." }],
      };
    }

    type Scored = { id: string; score: number };
    const scored: Scored[] = [];

    for (const [id, entry] of Object.entries(registry.pages)) {
      let score = 0;
      const title = String(entry.title || "").toLowerCase();
      const type = String(entry.type || "").toLowerCase();

      for (const term of terms) {
        if (id.toLowerCase().includes(term)) score += 3;
        if (title.includes(term)) score += 4;
        if (type.includes(term)) score += 1;
      }

      const tags = String(entry.tags || entry.category || entry.domain || "").toLowerCase();
      for (const term of terms) {
        if (tags.includes(term)) score += 2;
      }

      if (score > 0) scored.push({ id, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.min(max_results ?? 5, 10));

    const results = top.map(({ id }) => {
      const entry = registry.pages[id];
      let preview = "";
      const pagePath = join(paths.wiki, `${id}.md`);
      if (existsSync(pagePath)) {
        const content = readFileSync(pagePath, "utf-8");
        preview = content
          .replace(/^---[\s\S]*?---\n/, "")
          .trim()
          .slice(0, 200)
          .replace(/\n/g, " ");
      }
      return {
        id,
        title: String(entry?.title || id),
        type: String(entry?.type || "page"),
        preview,
      };
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
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
    const registry = readJson<{
      pages: Record<string, { type: string; title: string; [key: string]: unknown }>;
    }>(join(paths.meta, "registry.json"), { pages: {} });

    const q = query.toLowerCase();
    const matches = Object.entries(registry.pages)
      .filter(([id, entry]) => {
        const matchesQuery =
          id.toLowerCase().includes(q) ||
          String(entry.title).toLowerCase().includes(q) ||
          String(entry.type).toLowerCase().includes(q);
        const matchesType = !type || String(entry.type).toLowerCase() === type.toLowerCase();
        return matchesQuery && matchesType;
      })
      .map(([id, entry]) => ({
        id,
        title: entry.title,
        type: entry.type,
      }));

    return {
      content: [
        {
          type: "text" as const,
          text:
            matches.length > 0 ? JSON.stringify(matches, null, 2) : `No pages found for "${query}"`,
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
    const registry = readJson<{
      version: string;
      last_updated: string;
      pages: Record<string, { type: string; title: string; [key: string]: unknown }>;
    }>(join(paths.meta, "registry.json"), {
      version: "1.0",
      last_updated: "",
      pages: {},
    });

    const config = readJson<Record<string, unknown>>(join(paths.root, ".wiki", "config.json"), {});

    const byType: Record<string, number> = {};
    for (const entry of Object.values(registry.pages)) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              topic: config.topic || "Unknown",
              mode: config.mode || "personal",
              totalPages: Object.keys(registry.pages).length,
              byType,
              lastUpdated: registry.last_updated || "Never",
            },
            null,
            2,
          ),
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
      "Save an atomic insight from a completed task into the wiki. Creates a source packet and source page.",
    inputSchema: z.object({
      slug: z.string().describe("Unique kebab-case identifier (e.g. 'jwt-revocation-pattern')"),
      title: z.string().describe("Short descriptive title (60 chars max)"),
      body: z
        .string()
        .describe(
          "Markdown body explaining what was learned. Include [[wikilinks]] to related pages.",
        ),
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

    const { saveInsight } = (await import("../extensions/llm-wiki/lib/retro.js")) as {
      saveInsight: (
        paths: Record<string, string>,
        slug: string,
        title: string,
        body: string,
        category?: string,
      ) => { sourceId: string; packetPath: string; sourcePagePath: string };
    };

    const vaultPaths = {
      ...getPaths(),
      raw: join(getPaths().root, "raw"),
      dotWiki: join(getPaths().root, ".wiki"),
      outputs: join(getPaths().root, "outputs"),
      discoveries: join(getPaths().root, ".discoveries"),
    };

    const result = saveInsight(vaultPaths, slug, title, body, category);

    return {
      content: [
        {
          type: "text" as const,
          text: `Insight saved: ${result.sourceId} — ${title}`,
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
  async ({ text, url: urlParam, file_path, title }) => {
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

    const vaultPaths = {
      ...getPaths(),
      raw: join(getPaths().root, "raw"),
      dotWiki: join(getPaths().root, ".wiki"),
      outputs: join(getPaths().root, "outputs"),
      discoveries: join(getPaths().root, ".discoveries"),
    };

    let result: { sourceId: string };

    if (urlParam) {
      // For MCP, use simple curl-based capture
      const { captureUrl } = (await import("../extensions/llm-wiki/lib/source-packet.js")) as {
        captureUrl: (
          pi: never,
          paths: Record<string, string>,
          url: string,
          signal?: AbortSignal,
        ) => Promise<{ sourceId: string }>;
      };
      result = await captureUrl(
        { exec: async () => ({ stdout: "", stderr: "", code: 0 }) } as never,
        vaultPaths,
        urlParam,
      );
    } else if (file_path) {
      const { captureFile } = (await import("../extensions/llm-wiki/lib/source-packet.js")) as {
        captureFile: (
          pi: never,
          paths: Record<string, string>,
          filePath: string,
          signal?: AbortSignal,
        ) => Promise<{ sourceId: string }>;
      };
      result = await captureFile(
        { exec: async () => ({ stdout: "", stderr: "", code: 0 }) } as never,
        vaultPaths,
        file_path,
      );
    } else if (text) {
      const { captureText } = (await import("../extensions/llm-wiki/lib/source-packet.js")) as {
        captureText: (
          paths: Record<string, string>,
          text: string,
          title?: string,
        ) => { sourceId: string };
      };
      result = captureText(vaultPaths, text, title);
    } else {
      return {
        content: [
          {
            type: "text" as const,
            text: "Provide one of: text, url, or file_path",
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
