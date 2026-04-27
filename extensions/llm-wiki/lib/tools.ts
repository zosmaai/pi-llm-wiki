import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  type Registry,
  appendEvent,
  buildBacklinks,
  buildRegistry,
  rebuildMetadata,
  rebuildMetadataLight,
} from "./metadata.js";
import { captureFile, captureText, captureUrl } from "./source-packet.js";
import {
  type VaultPaths,
  ensureVaultStructure,
  extractWikilinks,
  findWikiPages,
  fmtDate,
  getVaultPaths,
  readJson,
  resolveVaultRoot,
  writeJson,
} from "./utils.js";

/**
 * All LLM Wiki custom tools.
 */

function getPaths(cwd = process.cwd()): VaultPaths {
  const root = resolveVaultRoot(cwd);
  return getVaultPaths(root);
}

function requireVault(paths: VaultPaths): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(join(paths.root, ".wiki", "config.json"))) {
    return { ok: false, reason: `No wiki found at ${paths.root}. Run wiki_bootstrap first.` };
  }
  return { ok: true };
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
      const root = params.root ? params.root : (ctx.cwd ?? process.cwd());
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
        "| .wiki/* | human + explicit request | operating rules |",
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
        "",
        "## Linking Style",
        "",
        "- Internal: [[folder/page-name]]",
        "- Citation: [[sources/SRC-YYYY-MM-DD-NNN]]",
        "",
      ].join("\n");
      writeFileSync(join(paths.root, "WIKI_SCHEMA.md"), schema, "utf-8");

      rebuildMetadata(paths);
      appendEvent(paths, { kind: "bootstrap", topic: params.topic, mode });

      return {
        content: [
          {
            type: "text",
            text: [
              `✅ Wiki bootstrapped at \`${paths.root}\``,
              "",
              "**Structure:**",
              "- raw/sources/ — immutable source packets",
              "- wiki/ — editable knowledge pages",
              "- meta/ — auto-generated metadata",
              "- .wiki/ — config and templates",
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

export function registerWikiCaptureSource(pi: ExtensionAPI): void {
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
    async execute(_toolCallId, params, signal) {
      const paths = getPaths();
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

      rebuildMetadataLight(paths);

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

export function registerWikiIngest(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description:
      "Process uningested source packets. Returns a batch of source IDs with extracted content for the LLM to synthesize.",
    promptSnippet: "Ingest source packets: get batch of sources needing synthesis",
    promptGuidelines: [
      "Use wiki_ingest when the user wants to process captured sources.",
      "After calling this tool, read each source's extracted.md, update its source page, create entity/concept pages, and cross-reference.",
      "The extension auto-updates metadata — you do NOT need to edit meta/ files.",
    ],
    parameters: Type.Object({
      source_id: Type.Optional(
        Type.String({ description: "Specific source ID to ingest. Leave empty for all new." }),
      ),
      batch_size: Type.Optional(
        Type.Number({ description: "Max sources to return (default: 3, max: 5)", default: 3 }),
      ),
    }),
    async execute(_toolCallId, params) {
      const paths = getPaths();
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

export function registerWikiEnsurePage(pi: ExtensionAPI): void {
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
      type: Type.String({ description: "Page type: entity | concept | synthesis | analysis" }),
      title: Type.String({ description: "Page title" }),
      content: Type.Optional(
        Type.String({ description: "Optional initial content (otherwise uses template)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const paths = getPaths();
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
    async execute(_toolCallId, params) {
      const paths = getPaths();
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

export function registerWikiLint(pi: ExtensionAPI): void {
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
    async execute(_toolCallId, params) {
      const paths = getPaths();
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

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
      if (params.auto_fix) {
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
        params.auto_fix ? `- Fixes applied: ${fixesApplied}` : "",
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
        auto_fix: params.auto_fix ?? false,
      });

      rebuildMetadataLight(paths);

      return {
        content: [
          {
            type: "text",
            text: [
              "🧹 **Lint complete**",
              "",
              `- Pages: ${pages.length}`,
              `- Orphans: ${orphans}`,
              `- Missing: ${missingPages}`,
              `- Contradictions: ${contradictions}`,
              params.auto_fix ? `- Auto-fixes: ${fixesApplied}` : "",
              "",
              `📄 Report: \`${reportPath}\``,
              gaps.length > 0 ? `💡 ${gaps.length} knowledge gap(s) tracked` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: {
          pages: pages.length,
          orphans,
          missingPages,
          contradictions,
          reportPath,
          gaps: gaps.length,
        } as Record<string, unknown>,
      };
    },
  });
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
    async execute() {
      const paths = getPaths();
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

export function registerWikiRebuildMeta(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_rebuild_meta",
    label: "Wiki Rebuild Meta",
    description: "Force a full metadata rebuild (registry, backlinks, index, log).",
    promptSnippet: "Rebuild all wiki metadata",
    promptGuidelines: ["Use wiki_rebuild_meta if metadata seems out of sync."],
    parameters: Type.Object({}),
    async execute() {
      const paths = getPaths();
      const vaultCheck = requireVault(paths);
      if (!vaultCheck.ok) {
        return {
          content: [{ type: "text", text: vaultCheck.reason }],
          details: { error: vaultCheck.reason } as Record<string, unknown>,
          isError: true,
        };
      }

      rebuildMetadata(paths);
      appendEvent(paths, { kind: "rebuild_meta" });

      const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
        version: "1.0",
        last_updated: "",
        pages: {},
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ Metadata rebuilt. ${Object.keys(registry.pages).length} pages indexed.`,
          },
        ],
        details: { pageCount: Object.keys(registry.pages).length } as Record<string, unknown>,
      };
    },
  });
}

// ─── 9. wiki_log_event ──────────────────────────────────

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
    async execute(_toolCallId, params) {
      const paths = getPaths();
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
    async execute(_toolCallId, params) {
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
