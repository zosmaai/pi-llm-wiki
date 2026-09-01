import { existsSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import type { Registry } from "./metadata.js";
import type { VaultPaths } from "./utils.js";
import { readJson } from "./utils.js";
import type { KnowledgeFormat } from "./vault-format.js";
import {
  compareCodePoint,
  discoverKnowledgeDocuments,
  inspectVaultFormat,
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
 * Reports resolved knowledge_format, page counts, and blocking diagnostics.
 */
export function getWikiStatus(paths: VaultPaths): WikiStatusSnapshot {
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
  };
}
