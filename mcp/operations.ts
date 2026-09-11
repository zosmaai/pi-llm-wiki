/**
 * MCP operation adapters over shared wiki services.
 *
 * Each operation is a thin, testable wrapper around the same services
 * used by Pi tools. No operation parses YAML, scans files, scores
 * registry entries, or builds page strings itself.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bootstrapVault } from "../extensions/llm-wiki/lib/bootstrap.js";
import { reindexEmbeddings, resolveEmbedder } from "../extensions/llm-wiki/lib/embeddings.js";
import {
  createKnowledgeDocument,
  type KnowledgeValue,
  parseMarkdownFrontmatter,
  writeKnowledgeDocumentFile,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import {
  applyWikilinkGate,
  buildWikilinkIndex,
  type WikilinkValidationMode,
} from "../extensions/llm-wiki/lib/knowledge-links.js";
import { runWikiLint } from "../extensions/llm-wiki/lib/lint.js";
import {
  appendEvent,
  type ProjectionResult,
  type Registry,
  rebuildMetadata,
} from "../extensions/llm-wiki/lib/metadata.js";
import { runIngestSynthesis } from "../extensions/llm-wiki/lib/ingest-worker.js";
import { saveObservation } from "../extensions/llm-wiki/lib/observation.js";
import { reindexQmdVault } from "../extensions/llm-wiki/lib/qmd-indexing.js";
import { type RecallResult, searchWikiLayered } from "../extensions/llm-wiki/lib/recall.js";
import { saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { captureFile, captureText, captureUrl } from "../extensions/llm-wiki/lib/source-packet.js";
import {
  loadTaskConfig,
  parseModelRef,
  resolveWikilinkValidation,
} from "../extensions/llm-wiki/lib/task-config.js";
import { buildPageBody, RESERVED_FRONTMATTER } from "../extensions/llm-wiki/lib/tools.js";
import { fmtDate, readJson, slugify, type VaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import {
  inspectVaultFormat,
  inspectWritableVault,
  VaultWriteError,
} from "../extensions/llm-wiki/lib/vault-format.js";
import {
  getWikiStatus,
  reindexWiki,
  searchRegistry,
} from "../extensions/llm-wiki/lib/wiki-service.js";
import { resolveLaneModel } from "./model-lane.js";

function projectionOutcome(
  projection: ProjectionResult,
): { ok: true } | { ok: false; diagnostics: Array<{ code: string; message: string }> } {
  return projection.ok
    ? { ok: true }
    : {
        ok: false,
        diagnostics: projection.diagnostics.map(({ code, message }) => ({ code, message })),
      };
}

/**
 * Enqueue a post-projection lexical QMD pass. Model-free and repairable; never
 * fails the authoritative write. Goes through the per-vault in-process queue.
 */
async function scheduleLexicalQmd(paths: VaultPaths): Promise<void> {
  try {
    await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
    });
  } catch {
    // Generated QMD state is repairable; an authoritative write must not fail.
  }
}

/**
 * Shared bootstrap operation: create (or update) the vault at `paths`.
 *
 * This is the one operation that must work when no vault exists — every other
 * one fails closed naming it. `bootstrapVault` is pure Node (`node:fs`,
 * `node:path` and sibling lib modules), so it needs no model and no
 * credentials, which is what makes it fit the MCP surface.
 *
 * A failed projection rebuild is reported as diagnostics alongside `ok: true`:
 * the vault has been written to disk by then, and `wiki_lint` is the repair
 * path, so failing the call outright would misreport what happened.
 */
export async function bootstrapOperation(
  paths: VaultPaths,
  input: { topic: string; mode?: string },
): Promise<
  | { ok: true; created: boolean; diagnostics: Array<{ code: string; message: string }> }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const result = bootstrapVault(paths, { topic: input.topic, mode: input.mode ?? "personal" });
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map(({ code, message }) => ({ code, message })),
    };
  }
  const projection = projectionOutcome(result.projection);
  return {
    ok: true,
    created: result.created,
    diagnostics: projection.ok ? [] : projection.diagnostics,
  };
}

/**
 * Shared recall operation: layered search plus vault diagnostics.
 *
 * Layering is the shared contract, not an extension-only feature: MCP clients
 * get the same personal + project merge the Pi `wiki_recall` tool does.
 * `searchWikiLayered` appends personal-vault hits, deduplicates by page ID and
 * tags personal results with `vaultLabel`. It is a no-op when no personal vault
 * exists, or when the resolved vault IS the personal vault.
 */
export async function recallOperation(
  paths: VaultPaths,
  query: string,
  maxResults = 5,
): Promise<{
  results: RecallResult[];
  diagnostics: Array<{ code: string; message: string }>;
}> {
  const results = searchWikiLayered(paths, query, maxResults);
  const vaultState = inspectVaultFormat(paths);
  return {
    results,
    diagnostics: vaultState.diagnostics.map((d) => ({ code: d.code, message: d.message })),
  };
}

/** Shared search operation: delegates directly to wiki-service. */
export async function searchOperation(
  paths: VaultPaths,
  query: string,
  type?: string,
): Promise<{
  matches: Array<{ id: string; title: string; type: string }>;
  diagnostics: Array<{ code: string; message: string }>;
}> {
  const result = searchRegistry(paths, query, type);
  return {
    matches: result.matches,
    diagnostics: result.diagnostics.map((d) => ({ code: d.code, message: d.message })),
  };
}

/** Shared reindex operation: delegates to the shared reindexWiki operation. */
export async function reindexOperation(
  paths: VaultPaths,
  input: {
    scope?: "changed" | "all";
    components?: Array<"lexical" | "vectors">;
    force?: boolean;
    vault?: "active" | "personal" | "project" | "all";
    signal?: AbortSignal;
  },
): Promise<import("../extensions/llm-wiki/lib/wiki-service.js").WikiReindexResult> {
  return reindexWiki(paths, input);
}

/** Shared status operation: delegates directly to wiki-service. */
export async function statusOperation(paths: VaultPaths): Promise<{
  knowledgeFormat: string;
  totalPages: number;
  byType: Record<string, number>;
  blockingDiagnostics: Array<{ code: string; message: string }>;
  lastUpdated: string;
  qmd: import("../extensions/llm-wiki/lib/qmd-indexing.js").QmdGeneratedStatus;
}> {
  const status = await getWikiStatus(paths);
  return {
    knowledgeFormat: status.knowledgeFormat,
    totalPages: status.totalPages,
    byType: status.byType,
    blockingDiagnostics: status.blockingDiagnostics.map((d) => ({
      code: d.code,
      message: d.message,
    })),
    lastUpdated: status.lastUpdated,
    qmd: status.qmd,
  };
}

/** Shared retro operation: validates vault then delegates to saveInsight. */
export async function retroOperation(
  paths: VaultPaths,
  slug: string,
  title: string,
  body: string,
  category?: string,
  wikilinkValidation?: WikilinkValidationMode,
): Promise<
  | { ok: true; slug: string; sourcePagePath: string }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      diagnostics: vaultCheck.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    };
  }
  // Pre-write wikilink gate (#172): validate/normalize caller-supplied body.
  const mode = resolveWikilinkValidation({ wikilinkValidation });
  let gateBody = body;
  if (mode !== "off") {
    const registry = readJson<{ pages: Record<string, unknown> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    const gate = applyWikilinkGate(
      body,
      buildWikilinkIndex(Object.keys(registry.pages)),
      `sources/${slug}`,
      mode,
    );
    if (!gate.ok) {
      return {
        ok: false,
        diagnostics: gate.diagnostics.map((d) => ({ code: "link_validation", message: d.message })),
      };
    }
    if (mode === "normalize") gateBody = gate.body;
  }
  try {
    const result = saveInsight(paths, slug, title, gateBody, category, { rebuild: false });
    const projection = projectionOutcome(rebuildMetadata(paths));
    if (!projection.ok) return projection;
    await scheduleLexicalQmd(paths);
    return { ok: true, slug: result.slug, sourcePagePath: result.sourcePagePath };
  } catch (error: unknown) {
    if (error instanceof VaultWriteError) {
      return {
        ok: false,
        diagnostics: error.diagnostics.map((d) => ({ code: d.code, message: d.message })),
      };
    }
    if ((error as Error).message.startsWith("Invalid insight slug:")) {
      return {
        ok: false,
        diagnostics: [{ code: "invalid_insight_slug", message: (error as Error).message }],
      };
    }
    throw error;
  }
}

/** Shared capture operation: validates vault then delegates to capture functions. */
export async function captureSourceOperation(
  paths: VaultPaths,
  input: { text?: string; url?: string; filePath?: string; title?: string },
  execApi: Pick<ExtensionAPI, "exec">,
): Promise<
  | { ok: true; sourceId: string }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      diagnostics: vaultCheck.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    };
  }

  try {
    let sourceId: string;
    if (input.url) {
      sourceId = (await captureUrl(execApi, paths, input.url)).sourceId;
    } else if (input.filePath) {
      sourceId = (await captureFile(execApi, paths, input.filePath)).sourceId;
    } else if (input.text) {
      sourceId = captureText(paths, input.text, input.title).sourceId;
    } else {
      return {
        ok: false,
        diagnostics: [
          {
            code: "event_missing_kind" as const,
            message: "Provide one of: text, url, or filePath",
          },
        ],
      };
    }

    const projection = projectionOutcome(rebuildMetadata(paths));
    if (!projection.ok) return projection;
    await scheduleLexicalQmd(paths);
    return { ok: true, sourceId };
  } catch (error: unknown) {
    if (error instanceof VaultWriteError) {
      return {
        ok: false,
        diagnostics: error.diagnostics.map((d) => ({ code: d.code, message: d.message })),
      };
    }
    throw error;
  }
}

/**
 * Shared ensure-page operation, mirroring the Pi wiki_ensure_page body:
 * vault check → #241 frontmatter consume → wikilink gate → write page →
 * metadata rebuild → lexical QMD pass. Uses the same reserved-field set and
 * template builder as the Pi tool (imported from tools.ts, which has no
 * top-level side effects).
 */
export async function ensurePageOperation(
  paths: VaultPaths,
  input: { type: string; title: string; content?: string },
): Promise<
  | { ok: true; path: string; created: boolean }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      diagnostics: vaultCheck.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    };
  }

  const config = loadTaskConfig(paths.root);
  const folderMap: Record<string, string> = {
    entity: "entities",
    concept: "concepts",
    synthesis: "syntheses",
    analysis: "analyses",
    requirement: "requirements",
    skill: "skills",
    case: "cases",
    ...config.customTypes,
  };
  const slug = slugify(input.title);
  const folder = folderMap[input.type] || "concepts";
  const pagePath = join(paths.wiki, folder, `${slug}.md`);
  if (existsSync(pagePath)) return { ok: true, path: pagePath, created: false };

  const today = fmtDate();
  let body = input.content ?? buildPageBody(input.type, input.title);

  // #241: consume a leading YAML frontmatter block from content (same hardened
  // parser as page reads); reserved fields never merge.
  const extraFrontmatter: Record<string, KnowledgeValue> = {};
  if (body.trimStart().startsWith("---")) {
    const parsed = parseMarkdownFrontmatter(body, `${folder}/${slug}.md`);
    if (parsed.ok) {
      for (const [key, value] of Object.entries(parsed.mapping)) {
        if (!RESERVED_FRONTMATTER.has(key)) extraFrontmatter[key] = value;
      }
      body = parsed.body.trim() ? parsed.body : buildPageBody(input.type, input.title);
    }
  }

  const mode = resolveWikilinkValidation(config);
  if (mode !== "off") {
    const registry = readJson<{ pages: Record<string, unknown> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    const gate = applyWikilinkGate(
      body,
      buildWikilinkIndex(Object.keys(registry.pages)),
      `${folder}/${slug}`,
      mode,
    );
    if (!gate.ok) {
      return {
        ok: false,
        diagnostics: gate.diagnostics.map((d) => ({ code: "link_validation", message: d.message })),
      };
    }
    if (mode === "normalize") body = gate.body;
  }

  const doc = createKnowledgeDocument(
    `${folder}/${slug}.md`,
    {
      type: input.type,
      title: input.title,
      created: today,
      updated: today,
      ...extraFrontmatter,
    },
    body,
  );
  mkdirSync(join(paths.wiki, folder), { recursive: true });
  writeKnowledgeDocumentFile(pagePath, doc);
  appendEvent(paths, {
    kind: "ensure_page",
    page_type: input.type,
    title: input.title,
    path: `${folder}/${slug}`,
  });
  const projection = projectionOutcome(rebuildMetadata(paths));
  if (!projection.ok) return projection;
  await scheduleLexicalQmd(paths);
  return { ok: true, path: pagePath, created: true };
}

/** Shared lint operation: the exact Pi health scan, run synchronously. */
export async function lintOperation(
  paths: VaultPaths,
  autoFix: boolean,
): Promise<
  | { ok: true; report: string }
  | { ok: false; diagnostics: Array<{ code: string; message: string }> }
> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      diagnostics: vaultCheck.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    };
  }
  const report = await runWikiLint(paths, autoFix);
  return { ok: true, report };
}

/**
 * Shared rebuild-meta operation: full projection + lexical QMD pass + page
 * count, mirroring the Pi wiki_rebuild_meta background work body.
 */
export async function rebuildMetaOperation(paths: VaultPaths): Promise<{
  report: string;
  warnings: Array<{ code: string; message: string }>;
}> {
  const result = rebuildMetadata(paths);
  if (!result.ok) {
    return {
      report: `⚠️ LLM Wiki: rebuild had issues — ${result.diagnostics
        .map((d) => `${d.code}: ${d.message}`)
        .join("; ")}`,
      warnings: result.diagnostics.map(({ code, message }) => ({ code, message })),
    };
  }
  const warnings = result.diagnostics
    .filter((d) => d.severity === "warning")
    .map(({ code, message }) => ({ code, message }));
  const qmdResult = await reindexQmdVault(paths, {
    scope: "changed",
    components: ["lexical"],
    force: false,
  });
  if (!qmdResult.ok) {
    warnings.push({
      code: "qmd_index_error",
      message: qmdResult.errors[0]?.message ?? "QMD indexing failed",
    });
  }
  if (warnings.length > 0) {
    return {
      report: `⚠️ LLM Wiki: metadata rebuilt with warnings — ${warnings
        .map((w) => `${w.code}: ${w.message}`)
        .join("; ")}`,
      warnings,
    };
  }
  const registry = readJson<Registry>(join(paths.meta, "registry.json"), {
    version: "1.0",
    last_updated: "",
    pages: {},
  });
  return {
    report: `✅ LLM Wiki: metadata rebuilt — ${Object.keys(registry.pages).length} pages indexed.`,
    warnings: [],
  };
}

/**
 * Shared embedding reindex. The Pi tool resolves the embedder from the runtime
 * config; the MCP server reads the same settings file via loadTaskConfig.
 */
export async function reindexEmbeddingsOperation(
  paths: VaultPaths,
  force: boolean,
): Promise<{ ok: boolean; enabled: boolean; message: string }> {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return {
      ok: false,
      enabled: false,
      message: `Wiki vault error: ${vaultCheck.diagnostics[0].message}`,
    };
  }
  const embedder = resolveEmbedder(loadTaskConfig(paths.root));
  if (!embedder) {
    return {
      ok: true,
      enabled: false,
      message:
        'ℹ️ No embedding provider configured — semantic embeddings are disabled. Set `llm-wiki.embeddingProvider` (e.g. "openai") in settings to enable.',
    };
  }
  const stats = await reindexEmbeddings(paths, embedder, { force });
  appendEvent(paths, {
    kind: "reindex_embeddings",
    embedded: stats.embedded,
    skipped: stats.skipped,
    pruned: stats.pruned,
    model: embedder.model,
  });
  return {
    ok: true,
    enabled: true,
    message: `✅ LLM Wiki: embeddings reindexed (${embedder.model}) — ${stats.embedded} embedded, ${stats.skipped} fresh, ${stats.pruned} pruned.`,
  };
}

/** Shared log-event operation: validates, appends, regenerates projections. */
export function logEventOperation(
  paths: VaultPaths,
  input: { kind: string; details?: Record<string, unknown> },
): { ok: boolean; message: string } {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return { ok: false, message: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` };
  }
  const kind = input.kind.trim();
  if (!kind) return { ok: false, message: "Event kind must be a non-empty string" };
  const details = input.details ?? {};
  if (Object.hasOwn(details, "kind") || Object.hasOwn(details, "timestamp")) {
    return { ok: false, message: "Event details cannot override kind or timestamp" };
  }
  appendEvent(paths, { kind, ...details });
  rebuildMetadata(paths);
  return { ok: true, message: `✅ Event logged: ${kind}` };
}

const WATCH_INTERVALS: Record<string, { cron: string; label: string }> = {
  daily: { cron: "0 8 * * *", label: "Daily at 8:00 AM" },
  weekly: { cron: "0 9 * * 1", label: "Weekly on Monday at 9:00 AM" },
  hourly: { cron: "0 * * * *", label: "Every hour" },
};

/** Shared watch operation: pure cron-line builder (no vault needed). */
export function watchOperation(input: { interval: string }): {
  ok: boolean;
  message: string;
  details: Record<string, unknown>;
} {
  if (input.interval === "stop") {
    return {
      ok: true,
      message: [
        "🛑 To stop wiki auto-updates, remove the cron line you installed earlier:",
        "",
        "```bash",
        "crontab -e   # then delete the line tagged '# llm-wiki-autoupdate'",
        "```",
        "",
        "Or list current jobs to confirm:",
        "",
        "```bash",
        "crontab -l | grep llm-wiki-autoupdate",
        "```",
      ].join("\n"),
      details: { action: "stop_instructions" },
    };
  }
  const config = WATCH_INTERVALS[input.interval];
  if (!config) {
    return {
      ok: false,
      message: `❌ Unknown interval: "${input.interval}". Use: daily, weekly, hourly, or stop.`,
      details: { error: "bad_interval" },
    };
  }
  const cronLine = `${config.cron} /bin/bash -lc 'mkdir -p "$HOME/.llm-wiki" && pi -p "/wiki-run" >> "$HOME/.llm-wiki/cron.log" 2>&1' # llm-wiki-autoupdate`;
  return {
    ok: true,
    message: [
      `⏰ To set up ${config.label} wiki updates, add this line to your crontab.`,
      "**This tool only prints the line — it does not install it.**",
      "",
      "```bash",
      "crontab -e",
      "```",
      "",
      "Then append:",
      "",
      "```cron",
      cronLine,
      "```",
      "",
      "The line uses `/bin/bash -lc` so your shell profile (and the `pi` binary on npm-global / bun PATH) is loaded. Output goes to `~/.llm-wiki/cron.log`.",
    ].join("\n"),
    details: {
      interval: input.interval,
      cronSchedule: config.cron,
      label: config.label,
      cronLine,
      installed: false,
    },
  };
}

/** Shared observe operation: writes the observation page synchronously. */
export function observeOperation(
  paths: VaultPaths,
  input: {
    title: string;
    content: string;
    relevance: "low" | "medium" | "high" | "critical";
    tags?: string;
    source_context?: string;
  },
): { ok: boolean; message: string } {
  const vaultCheck = inspectWritableVault(paths);
  if (!vaultCheck.ok) {
    return { ok: false, message: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` };
  }
  const result = saveObservation(paths, input, { rebuild: true });
  return {
    ok: true,
    message: `⭐ Observation saved: ${result.slug} — ${input.title}`,
  };
}

/**
 * Shared ingest operation: the exact pi packet-selection rules, run
 * synchronously over the config-first lane. Mirrors pi's background=false
 * "synthesize yourself" fallback when no model/API key resolves.
 */
export async function ingestOperation(
  paths: VaultPaths,
  input: {
    source_id?: string;
    batch_size?: number;
    model?: string;
  },
): Promise<{ report: string; isError?: boolean }> {
  if (!existsSync(paths.rawSources)) {
    return {
      report: "No raw/sources/ directory. Capture sources first with wiki_capture_source.",
      isError: true,
    };
  }

  const packets = readdirSync(paths.rawSources)
    .filter((d) => d.startsWith("SRC-"))
    .sort();
  const registry = readJson<{ pages: Record<string, unknown> }>(
    join(paths.meta, "registry.json"),
    { pages: {} },
  );
  const ingested = new Set<string>();
  for (const [id, entry] of Object.entries(registry.pages)) {
    const page = entry as Record<string, unknown>;
    if (page.type === "source" && page.status !== "skeleton") {
      const base = id.split("/").pop();
      if (base) ingested.add(base);
    }
  }

  let toProcess = packets.filter((p) => !ingested.has(p));
  if (input.source_id) {
    if (!toProcess.includes(input.source_id) && !packets.includes(input.source_id)) {
      return {
        report: `Source ${input.source_id} not found or already ingested.`,
        isError: true,
      };
    }
    toProcess = [input.source_id];
  }

  const batch = toProcess.slice(0, Math.min(input.batch_size ?? 3, 5));
  if (batch.length === 0) {
    return { report: "✅ All sources ingested. Use wiki_capture_source to add new ones." };
  }

  const config = loadTaskConfig(paths.root);
  const override = input.model ? parseModelRef(input.model) : undefined;
  const res = await resolveLaneModel(config, undefined, override);
  if (!res.ok) {
    // Mirror pi's background=false output: hand the extracted content to the
    // calling agent so it can synthesize without a background model.
    const sources = batch.map((id) => {
      const manifest = readJson<Record<string, unknown>>(
        join(paths.rawSources, id, "manifest.json"),
        {},
      );
      const extractedPath = join(paths.rawSources, id, "extracted.md");
      return {
        id,
        title: (manifest.title as string) ?? id,
        extractedChars: existsSync(extractedPath)
          ? readFileSync(extractedPath, "utf-8").length
          : 0,
      };
    });
    return {
      report: [
        `⚠️ No background LLM available (${res.reason}) — synthesize these sources yourself:`,
        "",
        ...sources.map((s) => `- **${s.id}**: ${s.title} (${s.extractedChars} chars extracted)`),
        "",
        "1. Read each source's extracted.md",
        "2. Update the skeleton source page in wiki/sources/",
        "3. Create/update entity pages in wiki/entities/",
        "4. Create/update concept pages in wiki/concepts/",
        "5. Add [[wikilinks]] cross-references",
        "6. Flag contradictions",
        "",
        "The extension will auto-update metadata when you are done.",
      ].join("\n"),
    };
  }

  const summaries: string[] = [];
  for (const id of batch) {
    const extractedPath = join(paths.rawSources, id, "extracted.md");
    const manifestPath = join(paths.rawSources, id, "manifest.json");
    const extracted = existsSync(extractedPath) ? readFileSync(extractedPath, "utf-8") : "";
    const manifest: Record<string, unknown> = readJson(manifestPath, {});
    const committed = await runIngestSynthesis({
      model: res.model as Parameters<typeof runIngestSynthesis>[0]["model"],
      apiKey: res.apiKey,
      headers: res.headers,
      streamFn: res.streamFn as Parameters<typeof runIngestSynthesis>[0]["streamFn"],
      env: res.env,
      paths,
      sourceId: id,
      manifest,
      extracted,
      synthesisLanguage: config.synthesisLanguage,
      wikilinkValidation: config.wikilinkValidation,
    });
    const wl = committed?.wikilinkDiagnostics?.length ?? 0;
    const wlNote = wl > 0 ? `, ${wl} wikilink issue${wl === 1 ? "" : "s"}` : "";
    summaries.push(
      committed
        ? `**${id}**: ingested → ${committed.entitiesCreated.length} entit${committed.entitiesCreated.length === 1 ? "y" : "ies"} created, ${committed.entitiesLinked.length} linked, ${committed.conceptsCreated.length} concept${committed.conceptsCreated.length === 1 ? "" : "s"} created, ${committed.conceptsLinked.length} linked${wlNote}`
        : `**${id}**: model produced no synthesis`,
    );
  }
  return {
    report: `${summaries.join("\n")}\n\nBatch: ${batch.length} source${batch.length === 1 ? "" : "s"} (${toProcess.length} pending, ${toProcess.length - batch.length} remaining).`,
  };
}
