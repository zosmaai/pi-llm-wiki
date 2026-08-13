import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import { type ProjectionResult, appendEvent, rebuildMetadata } from "./metadata.js";
import { type VaultPaths, ensureVaultStructure, fmtDate, writeJson } from "./utils.js";
import { inspectWritableVault, readVaultConfig } from "./vault-format.js";

export const WIKI_SCHEMA = [
  "# LLM Wiki Schema",
  "",
  "## Ownership Rules",
  "",
  "| Path | Owner | Rule |",
  "|------|-------|------|",
  "| raw/** | extension | immutable after capture |",
  "| wiki/** | model + user | editable knowledge pages |",
  "| meta/events.jsonl | extension tools | append-only authoritative state |",
  "| meta/* except events.jsonl | extension | generated projections |",
  "| . | human + explicit request | operating rules |",
  "",
  "Back up `meta/events.jsonl` to preserve activity history. Generated logs cannot reconstruct it.",
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
  "- **requirement** — atomic requirements with status, priority, and traceability",
  "",
  "## Linking Style",
  "",
  "- New internal links: [label](/folder/page.md)",
  "- Legacy readable links: [[folder/page]]",
  "- Source citation: [source](/sources/SRC-YYYY-MM-DD-NNN.md)",
  "",
].join("\n");

export interface BootstrapInput {
  topic: string;
  mode: string;
}

export type BootstrapResult =
  | { ok: true; created: boolean; projection: ProjectionResult }
  | { ok: false; created: false; diagnostics: KnowledgeDiagnostic[] };

export function bootstrapVault(paths: VaultPaths, input: BootstrapInput): BootstrapResult {
  const configPath = join(paths.dotWiki, "config.json");
  const created = !existsSync(paths.dotWiki);
  let existing: Record<string, unknown> = {};

  if (!created) {
    const writable = inspectWritableVault(paths);
    if (!writable.ok) return { ok: false, created: false, diagnostics: writable.diagnostics };
    const config = readVaultConfig(paths);
    if (!config.ok) return { ok: false, created: false, diagnostics: [config.diagnostic] };
    existing = config.config;
  }

  const config: Record<string, unknown> = {
    ...existing,
    name: input.topic,
    mode: input.mode,
    topic: input.topic,
    created: existing.created ?? fmtDate(),
    version: existing.version ?? "1.0",
    vault_id: existing.vault_id ?? randomUUID(),
    ...(created ? { knowledge_format: "okf-0.2" } : {}),
  };

  ensureVaultStructure(paths);
  writeJson(configPath, config);
  writeFileSync(join(paths.dotWiki, "WIKI_SCHEMA.md"), WIKI_SCHEMA, "utf8");
  appendEvent(paths, { kind: "bootstrap", topic: input.topic, mode: input.mode });
  return { ok: true, created, projection: rebuildMetadata(paths) };
}
