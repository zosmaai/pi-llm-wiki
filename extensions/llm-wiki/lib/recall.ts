import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { Registry } from "./metadata.js";
import { type VaultPaths, getVaultPaths, readJson, readText, resolveVaultRoot } from "./utils.js";

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
}

/**
 * Search the wiki registry for pages matching a query.
 * Returns up to `maxResults` matches, each with a content preview.
 */
export function searchWiki(paths: VaultPaths, query: string, maxResults = 5): RecallResult[] {
  const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
    version: "1.0",
    last_updated: "",
    pages: {},
  });

  const q = query.toLowerCase();
  const terms = q
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 10);

  if (terms.length === 0) return [];

  type Scored = { id: string; entry: Registry["pages"][string]; score: number };
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

    // Boost if query terms appear in tags/categories
    const tags = String(entry.tags || entry.category || entry.domain || "");
    for (const term of terms) {
      if (tags.toLowerCase().includes(term)) score += 2;
    }

    if (score > 0) {
      scored.push({ id, entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxResults);

  return top.map(({ id, entry }) => {
    // Try to read page content for preview
    let preview = "";
    const pagePath = join(paths.wiki, `${id}.md`);
    if (existsSync(pagePath)) {
      const content = readFileSync(pagePath, "utf-8");
      // Strip frontmatter
      const body = content.replace(/^---[\s\S]*?---\n/, "").trim();
      preview = body.slice(0, 200).replace(/\n/g, " ");
    }

    return {
      id,
      title: String(entry.title || id),
      type: String(entry.type || "page"),
      preview,
      path: pagePath,
    };
  });
}

/**
 * Format recall results as a compact system-prompt section.
 */
export function formatRecallContext(results: RecallResult[]): string {
  if (results.length === 0) return "";

  const lines: string[] = [
    "## Relevant Wiki Knowledge",
    "",
    `_${results.length} page(s) matched your query — reviewed automatically by LLM Wiki._`,
    "",
  ];

  for (const r of results) {
    lines.push(`- **[[${r.id}]]** — *${r.type}* — ${r.title}`);
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
    async execute(_toolCallId, params) {
      const root = resolveVaultRoot(process.cwd());
      const paths = getVaultPaths(root);

      if (!existsSync(join(root, ".wiki", "config.json"))) {
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
      const results = searchWiki(paths, params.query, maxResults);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No wiki pages found matching "${params.query}". Use wiki_search for broader results.`,
            },
          ],
          details: { query: params.query, matches: [] } as Record<string, unknown>,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `🧠 **${results.length} wiki page(s) relevant** to "${params.query}":`,
              "",
              ...results.map(
                (r) =>
                  `- [[${r.id}]] — *${r.type}* — ${r.title}${
                    r.preview ? `\n  > ${r.preview.slice(0, 150)}` : ""
                  }`,
              ),
              "",
              "Use `read` on any page for full content.",
              "Use `wiki_retro` to save new insights from this task.",
            ].join("\n"),
          },
        ],
        details: { query: params.query, matches: results.map((r) => r.id) } as Record<
          string,
          unknown
        >,
      };
    },
  });
}
