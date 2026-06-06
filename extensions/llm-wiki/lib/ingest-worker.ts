import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import { runSubAgent } from "./subagent.js";
import { type VaultPaths, fmtDate, slugify } from "./utils.js";

/**
 * Background ingest synthesis (issue #65, part of epic #63).
 *
 * Moves the work the main agent used to do during `wiki_ingest` — reading a
 * captured source's extracted text and writing the source page + entity /
 * concept pages — onto a background sub-agent, so capturing/ingesting never
 * stalls the user.
 *
 * Design: the sub-agent produces ONE structured `commit_synthesis` call; the
 * persistence (`commitSynthesis`) is fully deterministic and unit-testable
 * without an LLM. This mirrors pi-observational-memory's single-structured-tool
 * pattern and keeps the file-writing logic verifiable in isolation.
 */

// ── structured synthesis schema ───────────────────────────
export const CommitSynthesisSchema = Type.Object({
  summary: Type.String({
    minLength: 1,
    description: "2-3 paragraph summary of the source's key content.",
  }),
  key_takeaways: Type.Array(Type.String({ minLength: 1 }), {
    description: "The most important points, one per item.",
  }),
  entities: Type.Array(
    Type.Object({
      title: Type.String({
        minLength: 1,
        description: "Entity name (person, org, tool, product).",
      }),
      description: Type.String({ description: "One-line description of the entity." }),
    }),
    { description: "Named entities mentioned in the source." },
  ),
  concepts: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1, description: "Concept name (idea, pattern, framework)." }),
      definition: Type.String({ description: "One-line definition of the concept." }),
    }),
    { description: "Concepts discussed in the source." },
  ),
  quotes: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ minLength: 1 }),
        attribution: Type.Optional(Type.String()),
      }),
      { description: "Notable verbatim quotes." },
    ),
  ),
  contradictions: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Tensions/contradictions with existing wiki content, if any.",
    }),
  ),
});

export type SynthesisData = Static<typeof CommitSynthesisSchema>;

export interface CommitResult {
  sourceId: string;
  sourcePage: string;
  entitiesCreated: string[];
  conceptsCreated: string[];
  entitiesLinked: string[];
  conceptsLinked: string[];
  contradictions: number;
}

// ── deterministic persistence (no LLM) ────────────────────

function buildEntityPage(
  title: string,
  description: string,
  date: string,
  sourceId: string,
): string {
  const desc = description.trim() || "One-line description.";
  return `---\ntype: entity\ncreated: ${date}\nupdated: ${date}\nsources: [[[sources/${sourceId}]]]\n---\n\n# ${title}\n\n${desc}\n\n## Overview\n\n[Key facts]\n\n## Links\n\n- [[sources/${sourceId}]]\n`;
}

function buildConceptPage(
  title: string,
  definition: string,
  date: string,
  sourceId: string,
): string {
  const def = definition.trim() || "One-line definition.";
  return `---\ntype: concept\ncreated: ${date}\nupdated: ${date}\nsources: [[[sources/${sourceId}]]]\n---\n\n# ${title}\n\n${def}\n\n## Definition\n\n[Clear explanation]\n\n## Links\n\n- [[sources/${sourceId}]]\n`;
}

/** Rebuild the source page from synthesis data, marking it ingested. */
export function buildIngestedSourcePage(
  manifest: Record<string, unknown>,
  data: SynthesisData,
  date: string,
): string {
  const id = String(manifest.id);
  const title = String(manifest.title || id);
  const url = manifest.url ? `\n> _Original: [${manifest.url}](${manifest.url})_` : "";
  const format = String(manifest.format || "unknown");
  const captured = String(manifest.captured || date);

  const takeaways =
    data.key_takeaways.length > 0
      ? data.key_takeaways.map((t) => `- ${t.trim()}`).join("\n")
      : "- [None recorded]";
  const entities =
    data.entities.length > 0
      ? data.entities.map((e) => `- [[${slugify(e.title)}]]`).join("\n")
      : "- [None]";
  const concepts =
    data.concepts.length > 0
      ? data.concepts.map((c) => `- [[${slugify(c.title)}]]`).join("\n")
      : "- [None]";
  const quotes =
    data.quotes && data.quotes.length > 0
      ? data.quotes
          .map((q) => `> ${q.text.trim()}${q.attribution ? ` — ${q.attribution}` : ""}`)
          .join("\n\n")
      : "> [None recorded]";
  const contradictions =
    data.contradictions && data.contradictions.length > 0
      ? `\n## Contradictions\n\n${data.contradictions.map((c) => `⚠️ **Contradiction**: ${c.trim()}`).join("\n")}\n`
      : "";

  return `---\ntype: source\nformat: ${format}\nsource_id: ${id}\nraw_path: raw/sources/${id}/extracted.md\ncaptured: ${captured}\nstatus: ingested\nupdated: ${date}\n---\n\n# ${title}${url}\n\n## Summary\n\n${data.summary.trim()}\n\n## Key Takeaways\n\n${takeaways}\n\n## Entities Mentioned\n\n${entities}\n\n## Concepts Mentioned\n\n${concepts}\n\n## Notable Quotes\n\n${quotes}\n${contradictions}\n## Source Packet\n\n- **ID:** \`[[sources/${id}]]\`\n- **Extracted:** [raw/sources/${id}/extracted.md](../raw/sources/${id}/extracted.md)\n- **Manifest:** [raw/sources/${id}/manifest.json](../raw/sources/${id}/manifest.json)\n`;
}

/**
 * Persist a synthesis deterministically: rewrite the source page (status →
 * ingested), create missing entity/concept pages (existing pages are linked,
 * never overwritten), and log the event. Pure file I/O — no LLM, no network.
 */
export function commitSynthesis(
  paths: VaultPaths,
  sourceId: string,
  manifest: Record<string, unknown>,
  data: SynthesisData,
  date: string = fmtDate(),
): CommitResult {
  const result: CommitResult = {
    sourceId,
    sourcePage: join(paths.wiki, "sources", `${sourceId}.md`),
    entitiesCreated: [],
    conceptsCreated: [],
    entitiesLinked: [],
    conceptsLinked: [],
    contradictions: data.contradictions?.length ?? 0,
  };

  // Source page (always rewritten from skeleton → ingested).
  mkdirSync(join(paths.wiki, "sources"), { recursive: true });
  writeFileSync(result.sourcePage, buildIngestedSourcePage(manifest, data, date), "utf-8");

  // Entity pages — create if absent, link if present.
  mkdirSync(join(paths.wiki, "entities"), { recursive: true });
  for (const e of data.entities) {
    const slug = slugify(e.title);
    if (!slug) continue;
    const pagePath = join(paths.wiki, "entities", `${slug}.md`);
    if (existsSync(pagePath)) {
      result.entitiesLinked.push(slug);
    } else {
      writeFileSync(pagePath, buildEntityPage(e.title, e.description, date, sourceId), "utf-8");
      result.entitiesCreated.push(slug);
    }
  }

  // Concept pages — create if absent, link if present.
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  for (const c of data.concepts) {
    const slug = slugify(c.title);
    if (!slug) continue;
    const pagePath = join(paths.wiki, "concepts", `${slug}.md`);
    if (existsSync(pagePath)) {
      result.conceptsLinked.push(slug);
    } else {
      writeFileSync(pagePath, buildConceptPage(c.title, c.definition, date, sourceId), "utf-8");
      result.conceptsCreated.push(slug);
    }
  }

  appendEvent(paths, {
    kind: "ingest",
    source_id: sourceId,
    entities_created: result.entitiesCreated.length,
    concepts_created: result.conceptsCreated.length,
    contradictions: result.contradictions,
    background: true,
  });

  return result;
}

// ── sub-agent synthesis (LLM) ─────────────────────────────

export const INGEST_SYSTEM = `You are the LLM Wiki ingestion synthesizer. You turn a single captured source's extracted text into structured wiki knowledge.

Read the source content, then call \`commit_synthesis\` EXACTLY ONCE with:
- summary: a faithful 2-3 paragraph summary (no fabrication).
- key_takeaways: the most important points.
- entities: named people, organizations, tools, products actually mentioned.
- concepts: ideas, patterns, frameworks actually discussed.
- quotes: notable verbatim quotes (optional).
- contradictions: tensions with general knowledge or noted in the text (optional).

Rules:
- Never fabricate. Only include entities/concepts present in the source.
- Keep descriptions to one line.
- After calling commit_synthesis once, reply with a one-line confirmation and stop.`;

export interface RunIngestSynthesisArgs {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  paths: VaultPaths;
  sourceId: string;
  manifest: Record<string, unknown>;
  extracted: string;
  /** Cap on extracted chars fed to the model (avoid huge prompts). Default 24k. */
  maxChars?: number;
  signal?: AbortSignal;
}

/**
 * Run the synthesis sub-agent for a single source, then commit + rebuild
 * metadata. Returns the commit result, or undefined if the model produced no
 * synthesis.
 */
export async function runIngestSynthesis(
  args: RunIngestSynthesisArgs,
): Promise<CommitResult | undefined> {
  const { model, apiKey, headers, paths, sourceId, manifest, extracted, maxChars, signal } = args;
  const content = extracted.slice(0, maxChars ?? 24_000);
  if (!content.trim()) return undefined;

  let committed: CommitResult | undefined;

  const commitTool: AgentTool<typeof CommitSynthesisSchema> = {
    name: "commit_synthesis",
    label: "Commit synthesis",
    description:
      "Persist the structured synthesis of this source into wiki pages. Call exactly once.",
    parameters: CommitSynthesisSchema,
    execute: async (_id, params) => {
      committed = commitSynthesis(paths, sourceId, manifest, params);
      const ack = `Committed: source page + ${committed.entitiesCreated.length} new entit${
        committed.entitiesCreated.length === 1 ? "y" : "ies"
      }, ${committed.conceptsCreated.length} new concept${
        committed.conceptsCreated.length === 1 ? "" : "s"
      }. Reply with a one-line confirmation and stop.`;
      return { content: [{ type: "text", text: ack }], details: { sourceId } };
    },
  };

  const title = String(manifest.title || sourceId);
  const userPrompt = `Synthesize this captured source into wiki knowledge by calling commit_synthesis once.\n\nSOURCE: ${title} (${sourceId})\n\nEXTRACTED CONTENT:\n${content}`;

  await runSubAgent({
    model,
    apiKey,
    headers,
    systemPrompt: INGEST_SYSTEM,
    userPrompt,
    tools: [commitTool as AgentTool],
    signal,
  });

  if (committed) rebuildMetadataLight(paths);
  return committed;
}
