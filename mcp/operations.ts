/**
 * MCP operation adapters over shared wiki services.
 *
 * Each operation is a thin, testable wrapper around the same services
 * used by Pi tools. No operation parses YAML, scans files, scores
 * registry entries, or builds page strings itself.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bootstrapVault } from "../extensions/llm-wiki/lib/bootstrap.js";
import { type ProjectionResult, rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { reindexQmdVault } from "../extensions/llm-wiki/lib/qmd-indexing.js";
import { type RecallResult, searchWikiLayered } from "../extensions/llm-wiki/lib/recall.js";
import { saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { captureFile, captureText, captureUrl } from "../extensions/llm-wiki/lib/source-packet.js";
import type { VaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import {
  VaultWriteError,
  inspectVaultFormat,
  inspectWritableVault,
} from "../extensions/llm-wiki/lib/vault-format.js";
import {
  getWikiStatus,
  reindexWiki,
  searchRegistry,
} from "../extensions/llm-wiki/lib/wiki-service.js";

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
  try {
    const result = saveInsight(paths, slug, title, body, category, { rebuild: false });
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
