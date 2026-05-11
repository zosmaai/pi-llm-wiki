import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import {
  type VaultPaths,
  fmtDate,
  getVaultPaths,
  nextSourceId,
  resolveVaultRoot,
} from "./utils.js";

// ─── Public API ────────────────────────────────────────

export interface RetroResult {
  sourceId: string;
  packetPath: string;
  sourcePagePath: string;
}

/**
 * Save an atomic insight into the wiki as a source packet + source page.
 * Returns the source ID, packet path, and source page path.
 */
export function saveInsight(
  paths: VaultPaths,
  slug: string,
  title: string,
  body: string,
  category?: string,
): RetroResult {
  const sourceId = nextSourceId(paths);
  const packetPath = join(paths.rawSources, sourceId);
  mkdirSync(packetPath, { recursive: true });
  mkdirSync(join(packetPath, "attachments"), { recursive: true });

  const today = fmtDate();

  // Write manifest
  const manifest = {
    id: sourceId,
    title,
    slug,
    category: category || "uncategorized",
    captured: today,
    format: "insight",
    packet_version: "1.0",
  };
  writeFileSync(
    join(packetPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  // Write extracted text (the insight body in markdown)
  const extracted = [
    `# ${title}`,
    "",
    body,
    "",
    "---",
    `*Captured: ${today}*`,
    category ? `*Category: ${category}*` : "",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(join(packetPath, "extracted.md"), extracted, "utf-8");

  // Create source page
  const sourcePageDir = join(paths.wiki, "sources");
  mkdirSync(sourcePageDir, { recursive: true });
  const sourcePagePath = join(sourcePageDir, `${sourceId}.md`);

  const tagLine = category ? `category: ${category}` : "";
  const sourcePageContent = [
    "---",
    "type: source",
    `title: "${title}"`,
    `source_id: ${sourceId}`,
    "status: insight",
    `created: ${today}`,
    `updated: ${today}`,
    tagLine,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
    "## Source",
    "",
    `- **Packet:** \`${packetPath}\``,
    `- **Captured:** ${today}`,
    category ? `- **Category:** ${category}` : "",
    "",
    "## Related",
    "",
    "_(Add [[wikilinks]] to related pages)_",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  writeFileSync(sourcePagePath, sourcePageContent, "utf-8");

  // Log event
  appendEvent(paths, {
    kind: "retro",
    source_id: sourceId,
    title,
    slug,
    category: category || "uncategorized",
  });

  // Rebuild metadata
  rebuildMetadataLight(paths);

  return { sourceId, packetPath, sourcePagePath };
}

// ─── Tool Registration ──────────────────────────────────

/**
 * Register the `wiki_retro` tool.
 * The model calls this to save an atomic insight from a completed task.
 * Inspired by the memex_retro pattern.
 */
export function registerWikiRetro(pi: ExtensionAPI): void {
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

      const result = saveInsight(paths, params.slug, params.title, params.body, params.category);

      return {
        content: [
          {
            type: "text",
            text: [
              `🧠 **Insight saved**: ${params.title}`,
              "",
              `- Source: \`${result.sourceId}\``,
              `- Packet: \`${result.packetPath}\``,
              `- Page: \`${result.sourcePagePath}\``,
              "",
              "This insight will be auto-surfaced by wiki_recall in future sessions.",
            ].join("\n"),
          },
        ],
        details: {
          sourceId: result.sourceId,
          slug: params.slug,
          title: params.title,
          category: params.category || null,
        } as Record<string, unknown>,
      };
    },
  });
}
