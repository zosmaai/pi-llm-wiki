import { existsSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import type { Registry } from "./metadata.js";
import {
  type QmdGeneratedStatus,
  type QmdIndexProgress,
  type QmdIndexState,
  type QmdReindexResult,
  awaitQmdIndexQueue,
  readQmdIndexStatus,
  reindexQmdVault,
} from "./qmd-indexing.js";
import { QMD_PACKAGE_VERSION, resolveQmdModels } from "./qmd-store.js";
import { getPersonalWikiPaths, isPersonalVault, readJson } from "./utils.js";
import type { VaultPaths } from "./utils.js";
import type { KnowledgeFormat } from "./vault-format.js";
import {
  compareCodePoint,
  discoverKnowledgeDocuments,
  inspectVaultFormat,
  inspectWritableVault,
} from "./vault-format.js";

/**
 * Shared wiki service functions consumed by Pi and MCP.
 *
 * These are pure adapters over the shared document model and registry.
 * No YAML parsing, file scanning, or page serialization here.
 */

export interface RegistrySearchResult {
  matches: Array<{ id: string; title: string; type: string }>;
  diagnostics: KnowledgeDiagnostic[];
}

export interface WikiStatusSnapshot {
  knowledgeFormat: KnowledgeFormat;
  totalPages: number;
  byType: Record<string, number>;
  blockingDiagnostics: KnowledgeDiagnostic[];
  lastUpdated: string;
  qmd: QmdGeneratedStatus;
}

/**
 * Search the registry for matching concepts.
 *
 * Matches ID, semantic title, type, category, domain, tags, aliases, and recall triggers.
 * Preserves unknown types as strings.
 */
export function searchRegistry(
  paths: VaultPaths,
  query: string,
  typeFilter?: string,
): RegistrySearchResult {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const vaultState = inspectVaultFormat(paths);
  diagnostics.push(...vaultState.diagnostics);

  const registryPath = join(paths.meta, "registry.json");
  if (!existsSync(registryPath)) {
    return { matches: [], diagnostics };
  }

  const registry = readJson<Registry>(registryPath, {
    version: "1.0",
    last_updated: "",
    pages: {},
  });
  const normalizedQuery = query.toLowerCase();

  const matches: Array<{ id: string; title: string; type: string }> = [];

  for (const [id, entry] of Object.entries(registry.pages)) {
    // Apply type filter
    if (typeFilter && String(entry.type).toLowerCase() !== typeFilter.toLowerCase()) {
      continue;
    }

    // Check if query matches any searchable field
    if (matchesField(id, entry, normalizedQuery)) {
      matches.push({
        id,
        title: String(entry.title || id),
        type: String(entry.type || "unknown"),
      });
    }
  }

  // Sort by code point order for determinism
  matches.sort((a, b) => compareCodePoint(a.id, b.id));

  return { matches, diagnostics };
}

function matchesField(id: string, entry: Record<string, unknown>, query: string): boolean {
  // Match ID
  if (id.toLowerCase().includes(query)) return true;

  // Match title
  if (
    String(entry.title || "")
      .toLowerCase()
      .includes(query)
  )
    return true;

  // Match type
  if (
    String(entry.type || "")
      .toLowerCase()
      .includes(query)
  )
    return true;

  // Match category/domain
  if (
    String(entry.category || "")
      .toLowerCase()
      .includes(query)
  )
    return true;
  if (
    String(entry.domain || "")
      .toLowerCase()
      .includes(query)
  )
    return true;

  // Match tags (array or string)
  const tags = entry.tags;
  if (Array.isArray(tags)) {
    if (tags.some((t) => String(t).toLowerCase().includes(query))) return true;
  } else if (typeof tags === "string" && tags.toLowerCase().includes(query)) {
    return true;
  }

  // Match aliases (array or string)
  const aliases = entry.aliases;
  if (Array.isArray(aliases)) {
    if (aliases.some((a) => String(a).toLowerCase().includes(query))) return true;
  } else if (typeof aliases === "string" && aliases.toLowerCase().includes(query)) {
    return true;
  }

  // Match recall_triggers (array or string)
  const triggers = entry.recall_triggers;
  if (Array.isArray(triggers)) {
    if (triggers.some((t) => String(t).toLowerCase().includes(query))) return true;
  } else if (typeof triggers === "string" && triggers.toLowerCase().includes(query)) {
    return true;
  }

  return false;
}

/**
 * Get a status snapshot of the wiki.
 *
 * Reports resolved knowledge_format, page counts, blocking diagnostics, and
 * generated QMD index status (read without opening any QMD store).
 */
export async function getWikiStatus(paths: VaultPaths): Promise<WikiStatusSnapshot> {
  const vaultState = inspectVaultFormat(paths);
  const diagnostics = [...vaultState.diagnostics];

  // Also check discovery for current concept health
  const discovery = discoverKnowledgeDocuments(paths);
  diagnostics.push(...discovery.diagnostics);

  const registryPath = join(paths.meta, "registry.json");
  let registry: Registry | undefined;
  if (existsSync(registryPath)) {
    registry = readJson<Registry>(registryPath, { version: "1.0", last_updated: "", pages: {} });
  }

  const byType: Record<string, number> = {};
  let totalPages = 0;

  if (registry) {
    for (const entry of Object.values(registry.pages)) {
      totalPages++;
      const type = String(entry.type || "unknown");
      byType[type] = (byType[type] || 0) + 1;
    }
  }

  return {
    knowledgeFormat: vaultState.knowledgeFormat,
    totalPages,
    byType,
    blockingDiagnostics: diagnostics.filter((d) => d.severity === "error"),
    lastUpdated: registry?.last_updated || "",
    qmd: await readQmdIndexStatus(paths),
  };
}

// ─── Shared QMD reindex operation ─────────────────────────

export type WikiReindexVault = "active" | "personal" | "project" | "all";

export interface WikiReindexInput {
  scope?: "changed" | "all";
  components?: Array<"lexical" | "vectors">;
  force?: boolean;
  vault?: WikiReindexVault;
  signal?: AbortSignal;
  onProgress?: (progress: { vault: string; progress: QmdIndexProgress }) => void;
}

export interface WikiReindexResult {
  vault: WikiReindexVault;
  results: Array<{
    root: string;
    label: "active" | "personal" | "project";
    result: QmdReindexResult;
  }>;
}

function blockedReindexResult(
  scope: "changed" | "all",
  components: Array<"lexical" | "vectors">,
  code: string,
  message: string,
): QmdReindexResult {
  return {
    ok: false,
    scope,
    components,
    documents: { indexed: 0, updated: 0, unchanged: 0, removed: 0 },
    vectors: { generated: 0, skipped: 0, errors: 0 },
    elapsedMs: 0,
    status: {
      state: "error" as QmdIndexState,
      qmdVersion: QMD_PACKAGE_VERSION,
      models: resolveQmdModels(),
      totalDocuments: 0,
      canonicalDocuments: 0,
      evidenceDocuments: 0,
      needsEmbedding: 0,
      hasVectorIndex: false,
      repairComponents: [],
      issues: [{ code, message }],
    },
    warnings: [],
    errors: [{ code, message }],
  };
}

/**
 * Reindex QMD stores for selected vaults, sequentially. Validates each vault
 * immediately before work. One vault's failure does not prevent the others.
 */
export async function reindexWiki(
  activePaths: VaultPaths,
  input: WikiReindexInput,
): Promise<WikiReindexResult> {
  const scope = input.scope ?? "changed";
  const components = input.components ?? ["lexical", "vectors"];
  const force = input.force ?? false;
  const vault = input.vault ?? "active";
  const signal = input.signal;
  const onProgress = input.onProgress;

  const personalPaths = getPersonalWikiPaths();
  const activeIsPersonal = isPersonalVault(activePaths);

  const targets: Array<{ paths: VaultPaths; label: "active" | "personal" | "project" }> = [];
  switch (vault) {
    case "active":
      targets.push({ paths: activePaths, label: activeIsPersonal ? "personal" : "active" });
      break;
    case "personal":
      targets.push({ paths: personalPaths, label: "personal" });
      break;
    case "project":
      if (!activeIsPersonal) targets.push({ paths: activePaths, label: "project" });
      break;
    case "all":
      if (!activeIsPersonal) targets.push({ paths: activePaths, label: "project" });
      targets.push({ paths: personalPaths, label: "personal" });
      break;
  }

  const seen = new Set<string>();
  const results: WikiReindexResult["results"] = [];
  for (const target of targets) {
    if (seen.has(target.paths.root)) continue;
    seen.add(target.paths.root);

    const check = inspectWritableVault(target.paths);
    if (!check.ok) {
      results.push({
        root: target.paths.root,
        label: target.label,
        result: blockedReindexResult(
          scope,
          components,
          check.diagnostics[0]?.code ?? "config_invalid_knowledge_format",
          check.diagnostics[0]?.message ?? "Vault is not writable",
        ),
      });
      continue;
    }

    const result = await reindexQmdVault(target.paths, {
      scope,
      components,
      force,
      signal,
      onProgress: (p) => onProgress?.({ vault: target.paths.root, progress: p }),
    });
    results.push({ root: target.paths.root, label: target.label, result });
  }

  return { vault, results };
}

/** Test-only: drain/await in-process QMD reindex queue work for a vault root. */
export function awaitWikiQmdIndexQueue(root: string): Promise<unknown> {
  return awaitQmdIndexQueue(root);
}
