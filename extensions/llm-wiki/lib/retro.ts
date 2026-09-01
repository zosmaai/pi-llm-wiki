import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { scheduleReindex } from "./indexing.js";
import { createKnowledgeDocument, writeKnowledgeDocumentFile } from "./knowledge-document.js";
import { applyWikilinkGate, buildWikilinkIndex } from "./knowledge-links.js";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import type { Runtime } from "./runtime.js";
import { loadTaskConfig, resolveWikilinkValidation } from "./task-config.js";
import { fmtDate, readJson, resolveVaultPaths, type VaultPaths } from "./utils.js";
import { assertWritableVault, inspectWritableVault } from "./vault-format.js";

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
function insightPath(paths: VaultPaths, slug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug === "index" || slug === "log") {
    throw new Error(`Invalid insight slug: ${slug}`);
  }
  const directory = resolve(paths.wiki, "sources");
  const target = resolve(directory, `${slug}.md`);
  if (dirname(target) !== directory) throw new Error(`Invalid insight slug: ${slug}`);
  return target;
}

export function saveInsight(
  paths: VaultPaths,
  slug: string,
  title: string,
  body: string,
  category?: string,
  opts?: { rebuild?: boolean },
): RetroResult {
  assertWritableVault(paths);
  const today = fmtDate();

  const sourcePagePath = insightPath(paths, slug);

  const pageBody = `# ${title}

${body}

${category ? `*Category: ${category}*` : ""}

---
*Captured: ${today}*

## Related

_Add links to related pages._`;

  const doc = createKnowledgeDocument(
    `sources/${slug}.md`,
    {
      type: "source",
      title,
      slug,
      status: "insight",
      created: today,
      updated: today,
      ...(category ? { category } : {}),
    },
    pageBody,
  );
  writeKnowledgeDocumentFile(sourcePagePath, doc);

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

      const vaultCheck = inspectWritableVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}`,
            },
          ],
          details: {
            error: vaultCheck.diagnostics[0].code,
            diagnostics: vaultCheck.diagnostics,
          } as Record<string, unknown>,
          isError: true,
        };
      }

      // Pre-write wikilink gate (#172): validate/normalize caller-supplied body.
      const mode = resolveWikilinkValidation(loadTaskConfig(ctx.cwd ?? process.cwd()));
      let body = params.body;
      let wikilinkIssues: string[] = [];
      if (mode !== "off") {
        const registry = readJson<{ pages: Record<string, unknown> }>(
          join(paths.meta, "registry.json"),
          { pages: {} },
        );
        const gate = applyWikilinkGate(
          body,
          buildWikilinkIndex(Object.keys(registry.pages)),
          `sources/${params.slug}`,
          mode,
        );
        wikilinkIssues = gate.diagnostics.map((d) => d.message);
        if (!gate.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Rejected write — unresolved/ambiguous wikilinks:\n${wikilinkIssues
                  .map((m) => `- ${m}`)
                  .join("\n")}`,
              },
            ],
            details: { error: "link_validation", issues: wikilinkIssues } as Record<
              string,
              unknown
            >,
            isError: true,
          };
        }
        if (mode === "normalize") body = gate.body;
      }
      let result: RetroResult;
      try {
        result = saveInsight(paths, params.slug, params.title, body, params.category, {
          rebuild: !runtime,
        });
      } catch (error: unknown) {
        if ((error as Error).message.startsWith("Invalid insight slug:")) {
          return {
            content: [{ type: "text", text: (error as Error).message }],
            details: { error: "invalid_insight_slug" } as Record<string, unknown>,
            isError: true,
          };
        }
        throw error;
      }
      if (runtime) {
        scheduleReindex(runtime, { hasUI: ctx.hasUI, ui: ctx.ui }, paths);
      }

      const gateNote = wikilinkIssues.length
        ? `\n\n⚠️ ${wikilinkIssues.length} wikilink issue(s):\n${wikilinkIssues.map((m) => `- ${m}`).join("\n")}`
        : "";
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
              gateNote,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: {
          slug: params.slug,
          title: params.title,
          category: params.category || null,
          wikilinkIssues,
        } as Record<string, unknown>,
      };
    },
  });
}
