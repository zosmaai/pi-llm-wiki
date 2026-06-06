import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { scheduleReindex } from "./indexing.js";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import type { Runtime } from "./runtime.js";
import { type VaultPaths, fmtDate, resolveVaultPaths } from "./utils.js";

// ─── Public API ────────────────────────────────────────

export interface RetroResult {
  slug: string;
  sourcePagePath: string;
}

/**
 * Save an atomic insight into the wiki as a single markdown file.
 *
 * Unlike wiki_capture_source (which creates a full source packet with
 * manifest.json, extracted.md, and attachments), this is a lightweight
 * path for quick knowledge capture — one file, one call.
 *
 * The 4-layer pipeline (raw → source pages → canonical pages → metadata)
 * is still available via wiki_capture_source → wiki_ingest for deep research.
 */
export function saveInsight(
  paths: VaultPaths,
  slug: string,
  title: string,
  body: string,
  category?: string,
  opts?: { rebuild?: boolean },
): RetroResult {
  const today = fmtDate();

  // Write a single markdown file to wiki/sources/{slug}.md
  const sourcePageDir = join(paths.wiki, "sources");
  mkdirSync(sourcePageDir, { recursive: true });
  const sourcePagePath = join(sourcePageDir, `${slug}.md`);

  const pageContent = [
    "---",
    "type: source",
    `title: "${title}"`,
    `slug: ${slug}`,
    "status: insight",
    `created: ${today}`,
    `updated: ${today}`,
    category ? `category: ${category}` : "",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
    category ? `*Category: ${category}*` : "",
    "",
    "---",
    `*Captured: ${today}*`,
    "",
    "## Related",
    "",
    "_Add links to related pages._",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  writeFileSync(sourcePagePath, pageContent, "utf-8");

  // Log event
  appendEvent(paths, {
    kind: "retro",
    slug,
    title,
    category: category || "uncategorized",
  });

  // Rebuild metadata so the insight is immediately searchable. The wiki_retro
  // tool passes { rebuild: false } and schedules a non-blocking reindex instead.
  if (opts?.rebuild !== false) rebuildMetadataLight(paths);

  return { slug, sourcePagePath };
}

// ─── Tool Registration ──────────────────────────────────

/**
 * Register the `wiki_retro` tool.
 * The model calls this to save an atomic insight from a completed task.
 * Inspired by the memex_retro pattern.
 */
export function registerWikiRetro(pi: ExtensionAPI, runtime?: Runtime): void {
  pi.registerTool({
    name: "wiki_retro",
    label: "Wiki Retro",
    description:
      "Save an atomic insight from a completed task into the wiki. " +
      "Creates a source packet and source page. The insight will be " +
      "surfaced automatically by wiki_recall in future sessions.",
    promptSnippet: "Save atomic insights from completed tasks into the wiki",
    promptGuidelines: [
      "Use wiki_retro at the END of every meaningful task to save what you learned.",
      "Write atomic insights — one insight per call. Use multiple calls for multiple insights.",
      "The insight will be auto-surfaced by wiki_recall in future sessions.",
    ],
    parameters: Type.Object({
      slug: Type.String({
        description:
          "Unique kebab-case identifier (e.g. 'jwt-revocation-pattern'). Used for lookups.",
      }),
      title: Type.String({
        description: "Short descriptive title (60 chars max). Noun phrase, not a sentence.",
      }),
      body: Type.String({
        description:
          "Markdown body with [[wikilinks]] to related wiki pages. Explain what was learned.",
      }),
      category: Type.Optional(
        Type.String({
          description: "Optional category (e.g. frontend, architecture, devops, bugfix, design)",
        }),
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

      const result = saveInsight(paths, params.slug, params.title, params.body, params.category, {
        rebuild: !runtime,
      });
      if (runtime) {
        scheduleReindex(runtime, { hasUI: ctx.hasUI, ui: ctx.ui }, paths);
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `🧠 **Insight saved**: ${params.title}`,
              "",
              `- Page: \`${result.sourcePagePath}\``,
              "",
              "This insight will be auto-surfaced by wiki_recall in future sessions.",
            ].join("\n"),
          },
        ],
        details: {
          slug: params.slug,
          title: params.title,
          category: params.category || null,
        } as Record<string, unknown>,
      };
    },
  });
}
