import { readFileSync, writeFileSync } from "node:fs";
import { type Document, isAlias, isMap, isScalar, isSeq, parseAllDocuments, stringify } from "yaml";

export const FRONTMATTER_MAX_BYTES = 128 * 1024;
export const FRONTMATTER_MAX_DEPTH = 32;

export type DiagnosticSeverity = "warning" | "error";
export type DiagnosticCode =
  | "config_invalid_knowledge_format"
  | "frontmatter_missing"
  | "frontmatter_parse_error"
  | "frontmatter_duplicate_key"
  | "frontmatter_alias_forbidden"
  | "frontmatter_custom_tag_forbidden"
  | "frontmatter_multiple_documents"
  | "frontmatter_limit_bytes"
  | "frontmatter_limit_depth"
  | "concept_missing_type"
  | "concept_identity_collision"
  | "concept_reserved_name"
  | "okf_version_mismatch"
  | "link_path_escape"
  | "link_unresolved"
  | "event_source_missing"
  | "event_source_unreadable"
  | "event_invalid_json"
  | "event_invalid_timestamp"
  | "event_missing_kind"
  | "config_invalid_vault_id"
  | "qmd_index_missing"
  | "qmd_index_stale"
  | "qmd_index_error"
  | "qmd_index_busy"
  | "qmd_manifest_invalid"
  | "qmd_swap_interrupted";

export interface KnowledgeDiagnostic {
  severity: DiagnosticSeverity;
  code: DiagnosticCode;
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export type KnowledgeValue =
  | null
  | boolean
  | number
  | string
  | KnowledgeValue[]
  | { [key: string]: KnowledgeValue };

export type KnowledgeCreationFields = {
  type: string;
  sources?: never;
} & Omit<Record<string, KnowledgeValue>, "type" | "sources">;

export type KnowledgeSources =
  | { kind: "absent" }
  | { kind: "canonical"; value: Array<Record<string, KnowledgeValue>> }
  | { kind: "legacy-scalar"; value: string }
  | { kind: "legacy-list"; value: string[] }
  | { kind: "unknown-shape"; value: KnowledgeValue };

export interface KnowledgeFrontmatter {
  type: string;
  title?: KnowledgeValue;
  description?: KnowledgeValue;
  resource?: KnowledgeValue;
  tags?: KnowledgeValue;
  generated?: KnowledgeValue;
  verified?: KnowledgeValue;
  status?: KnowledgeValue;
  stale_after?: KnowledgeValue;
  category?: KnowledgeValue;
  domain?: KnowledgeValue;
  aliases?: KnowledgeValue;
  recall_triggers?: KnowledgeValue;
  created?: KnowledgeValue;
  updated?: KnowledgeValue;
  summary?: KnowledgeValue;
  raw_path?: KnowledgeValue;
  source_id?: KnowledgeValue;
  [key: string]: KnowledgeValue | undefined;
}

export interface KnowledgeDocument {
  id: string;
  path: string;
  frontmatter: KnowledgeFrontmatter;
  sources: KnowledgeSources;
  extensions: Record<string, KnowledgeValue>;
  body: string;
  compatibility: {
    legacyFields: string[];
    hasLegacyWikilinks: boolean;
  };
}

export type ParseKnowledgeResult =
  | { ok: true; document: KnowledgeDocument; diagnostics: KnowledgeDiagnostic[] }
  | { ok: false; diagnostics: KnowledgeDiagnostic[] };

export type ParseFrontmatterResult =
  | {
      ok: true;
      mapping: Record<string, KnowledgeValue>;
      body: string;
      diagnostics: KnowledgeDiagnostic[];
    }
  | { ok: false; diagnostics: KnowledgeDiagnostic[] };

export interface KnowledgePatchFields {
  type?: string;
  title?: KnowledgeValue;
  description?: KnowledgeValue;
  resource?: KnowledgeValue;
  tags?: KnowledgeValue;
  generated?: KnowledgeValue;
  verified?: KnowledgeValue;
  status?: KnowledgeValue;
  stale_after?: KnowledgeValue;
  category?: KnowledgeValue;
  domain?: KnowledgeValue;
  aliases?: KnowledgeValue;
  recall_triggers?: KnowledgeValue;
  created?: KnowledgeValue;
  updated?: KnowledgeValue;
  summary?: KnowledgeValue;
  raw_path?: KnowledgeValue;
  source_id?: KnowledgeValue;
}

export interface KnowledgePatch {
  fields?: KnowledgePatchFields;
  body?: string;
}

const STANDARD_FIELDS = new Set([
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "sources",
  "generated",
  "verified",
  "status",
  "stale_after",
  "category",
  "domain",
  "aliases",
  "recall_triggers",
  "created",
  "updated",
  "summary",
  "raw_path",
  "source_id",
]);

const LEGACY_COMPAT_FIELDS = new Set(["created", "updated", "summary", "raw_path", "source_id"]);

function diag(
  severity: DiagnosticSeverity,
  code: DiagnosticCode,
  path: string,
  message: string,
  line?: number,
  column?: number,
): KnowledgeDiagnostic {
  return { severity, code, path, message, line, column };
}

function classifySources(raw: KnowledgeValue | undefined): KnowledgeSources {
  if (raw === undefined) return { kind: "absent" };
  if (raw === null) return { kind: "unknown-shape", value: null };
  if (typeof raw === "string") return { kind: "legacy-scalar", value: raw };
  if (Array.isArray(raw)) {
    if (raw.every((v) => typeof v === "string")) {
      return { kind: "legacy-list", value: raw };
    }
    if (raw.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      return { kind: "canonical", value: raw as Array<Record<string, KnowledgeValue>> };
    }
  }
  return { kind: "unknown-shape", value: raw };
}

function hasAlias(node: unknown): boolean {
  if (isAlias(node)) return true;
  if (isMap(node)) {
    return node.items.some((item) => hasAlias(item.key) || hasAlias(item.value));
  }
  if (isSeq(node)) {
    return node.items.some((item) => hasAlias(item));
  }
  return false;
}

function hasCustomTag(node: unknown): boolean {
  if (node && typeof node === "object" && "tag" in node && typeof node.tag === "string") {
    if (node.tag.startsWith("!")) return true;
  }
  if (isMap(node)) {
    return node.items.some((item) => hasCustomTag(item.key) || hasCustomTag(item.value));
  }
  if (isSeq(node)) {
    return node.items.some((item) => hasCustomTag(item));
  }
  return false;
}

function maxDepth(node: unknown, current: number): number {
  if (isMap(node)) {
    let deepest = current + 1;
    for (const item of node.items) {
      deepest = Math.max(
        deepest,
        maxDepth(item.key, current + 1),
        maxDepth(item.value, current + 1),
      );
    }
    return deepest;
  }
  if (isSeq(node)) {
    let deepest = current + 1;
    for (const item of node.items) {
      deepest = Math.max(deepest, maxDepth(item, current + 1));
    }
    return deepest;
  }
  return current;
}

function toKnowledgeValue(node: unknown): KnowledgeValue {
  if (node === null) return null;
  if (isScalar(node)) {
    const v = node.value;
    if (v === null) return null;
    if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
    return String(v);
  }
  if (isSeq(node)) {
    return node.items.map(toKnowledgeValue);
  }
  if (isMap(node)) {
    const obj: Record<string, KnowledgeValue> = Object.create(null);
    for (const item of node.items) {
      const key = String(isScalar(item.key) ? item.key.value : item.key);
      obj[key] = toKnowledgeValue(item.value);
    }
    return obj;
  }
  return null;
}

function detectLegacyWikilinks(body: string): boolean {
  return /\[\[[^\]]+\]\]/.test(body);
}

function parseFrontmatterBlock(
  content: string,
  path: string,
  requireType: boolean,
): ParseFrontmatterResult | ParseKnowledgeResult {
  const diagnostics: KnowledgeDiagnostic[] = [];

  // Normalize line endings
  const normalized = content.replace(/\r\n?/g, "\n");

  // Require opening --- on line 1
  if (!normalized.startsWith("---\n")) {
    return {
      ok: false,
      diagnostics: [
        diag("error", "frontmatter_missing", path, "Missing frontmatter opening delimiter"),
      ],
    };
  }

  // Find closing ---
  // Per spec: when a candidate immediately follows a YAML explicit-end line ...
  // and another delimiter exists later, treat that candidate as an internal
  // second-document marker and continue to the later closing fence.
  let closingIndex = -1;
  let i = 4; // skip opening ---\n
  const candidates: Array<{ index: number; followsExplicitEnd: boolean }> = [];
  let lastLineWasExplicitEnd = false;
  while (i < normalized.length) {
    const newlinePos = normalized.indexOf("\n", i);
    const lineEnd = newlinePos === -1 ? normalized.length : newlinePos;
    const line = normalized.slice(i, lineEnd);
    if (line === "---") {
      candidates.push({ index: i, followsExplicitEnd: lastLineWasExplicitEnd });
      lastLineWasExplicitEnd = false;
    } else if (line === "...") {
      lastLineWasExplicitEnd = true;
    } else {
      lastLineWasExplicitEnd = false;
    }
    i = lineEnd + 1;
  }

  // Find the proper closing fence
  if (candidates.length === 1) {
    closingIndex = candidates[0].index;
  } else if (candidates.length > 1) {
    // If first candidate follows explicit end and there's another later,
    // skip the first (it's a second-document marker)
    if (candidates[0].followsExplicitEnd && candidates.length >= 2) {
      closingIndex = candidates[1].index;
    } else {
      closingIndex = candidates[0].index;
    }
  }

  if (closingIndex === -1) {
    return {
      ok: false,
      diagnostics: [
        diag("error", "frontmatter_parse_error", path, "Missing frontmatter closing delimiter"),
      ],
    };
  }

  const yamlText = normalized.slice(4, closingIndex);

  // Check byte limit
  const byteLength = Buffer.byteLength(yamlText, "utf8");
  if (byteLength > FRONTMATTER_MAX_BYTES) {
    return {
      ok: false,
      diagnostics: [
        diag(
          "error",
          "frontmatter_limit_bytes",
          path,
          `Frontmatter exceeds ${FRONTMATTER_MAX_BYTES} bytes`,
        ),
      ],
    };
  }

  // Parse with yaml library - use lenient mode first, then validate
  let docs: Document[];
  try {
    docs = parseAllDocuments(yamlText, {
      schema: "core",
      merge: false,
      uniqueKeys: true,
    });
  } catch (e: unknown) {
    const err = e as Error & { pos?: number; line?: number; col?: number };
    return {
      ok: false,
      diagnostics: [
        diag(
          "error",
          "frontmatter_parse_error",
          path,
          `YAML parse error: ${err.message}`,
          err.line ?? undefined,
          err.col ?? undefined,
        ),
      ],
    };
  }

  // YAML parser errors must be surfaced before conversion. `yaml` records
  // malformed syntax and nested duplicate keys on the Document instead of
  // throwing from parseAllDocuments.
  const yamlErrors = docs.flatMap((document) => document.errors);
  if (yamlErrors.length > 0) {
    const duplicate = yamlErrors.find((error) => error.code === "DUPLICATE_KEY");
    const error = duplicate ?? yamlErrors[0];
    return {
      ok: false,
      diagnostics: [
        diag(
          "error",
          duplicate ? "frontmatter_duplicate_key" : "frontmatter_parse_error",
          path,
          `YAML parse error: ${error.message}`,
        ),
      ],
    };
  }

  // Check for multiple documents
  if (docs.length !== 1) {
    return {
      ok: false,
      diagnostics: [
        diag(
          "error",
          "frontmatter_multiple_documents",
          path,
          "Multiple YAML documents in frontmatter",
        ),
      ],
    };
  }

  const doc = docs[0];
  const contents = doc.contents;

  // Must be a mapping
  if (!isMap(contents)) {
    return {
      ok: false,
      diagnostics: [
        diag("error", "frontmatter_parse_error", path, "Frontmatter must be a YAML mapping"),
      ],
    };
  }

  // Check for aliases
  if (hasAlias(contents)) {
    return {
      ok: false,
      diagnostics: [
        diag("error", "frontmatter_alias_forbidden", path, "YAML aliases are not allowed"),
      ],
    };
  }

  // Check for custom tags
  if (hasCustomTag(contents)) {
    return {
      ok: false,
      diagnostics: [
        diag("error", "frontmatter_custom_tag_forbidden", path, "Custom YAML tags are not allowed"),
      ],
    };
  }

  // Check for duplicate keys
  const seenKeys = new Set<string>();
  for (const item of contents.items) {
    const key = String(isScalar(item.key) ? item.key.value : item.key);
    if (seenKeys.has(key)) {
      return {
        ok: false,
        diagnostics: [
          diag(
            "error",
            "frontmatter_duplicate_key",
            path,
            `Duplicate key: ${key}`,
            undefined,
            undefined,
          ),
        ],
      };
    }
    seenKeys.add(key);
  }

  // Check depth
  const depth = maxDepth(contents, 0);
  if (depth > FRONTMATTER_MAX_DEPTH) {
    return {
      ok: false,
      diagnostics: [
        diag(
          "error",
          "frontmatter_limit_depth",
          path,
          `Frontmatter nesting exceeds ${FRONTMATTER_MAX_DEPTH}`,
        ),
      ],
    };
  }

  const mapping = toKnowledgeValue(contents) as Record<string, KnowledgeValue>;

  // Build body: remove closing fence and one optional blank separator line
  let body = normalized.slice(closingIndex + 4); // skip closing ---\n
  if (body.startsWith("\n")) {
    // Remove exactly one leading blank separator line; additional leading blanks belong to body
    body = body.slice(1);
  }

  if (!requireType) {
    return {
      ok: true,
      mapping,
      body,
      diagnostics,
    };
  }

  // Require type field
  const rawType = mapping.type;
  if (typeof rawType !== "string" || rawType.trim() === "") {
    return {
      ok: false,
      diagnostics: [diag("error", "concept_missing_type", path, "Missing or empty type field")],
    };
  }

  // Classify sources
  const sources = classifySources(mapping.sources);

  // Split standard fields from extensions
  const frontmatter: KnowledgeFrontmatter = { type: rawType };
  const extensions: Record<string, KnowledgeValue> = Object.create(null);
  const legacyFields: string[] = [];

  for (const [key, value] of Object.entries(mapping)) {
    if (key === "sources") continue; // handled separately
    if (STANDARD_FIELDS.has(key)) {
      (frontmatter as Record<string, unknown>)[key] = value;
      if (LEGACY_COMPAT_FIELDS.has(key)) {
        legacyFields.push(key);
      }
    } else {
      extensions[key] = value;
    }
  }

  // Record legacy source shape
  if (sources.kind === "legacy-scalar" || sources.kind === "legacy-list") {
    legacyFields.push("sources");
  }

  const hasLegacyWikilinks = detectLegacyWikilinks(body);
  if (hasLegacyWikilinks) {
    legacyFields.push("wikilinks");
  }

  return {
    ok: true,
    document: {
      id: path.replace(/\.md$/, ""),
      path,
      frontmatter,
      sources,
      extensions,
      body,
      compatibility: {
        legacyFields,
        hasLegacyWikilinks,
      },
    },
    diagnostics,
  };
}

export function parseMarkdownFrontmatter(content: string, path: string): ParseFrontmatterResult {
  const result = parseFrontmatterBlock(content, path, false);
  if ("ok" in result && result.ok && "mapping" in result) {
    return result;
  }
  return result as ParseFrontmatterResult;
}

export function parseKnowledgeDocument(content: string, path: string): ParseKnowledgeResult {
  const result = parseFrontmatterBlock(content, path, true);
  return result as ParseKnowledgeResult;
}

export function serializeKnowledgeDocument(document: KnowledgeDocument): string {
  // Rebuild mapping from frontmatter, sources, and extensions
  const mapping: Record<string, KnowledgeValue> = Object.create(null);

  // Standard frontmatter fields (excluding sources)
  for (const key of STANDARD_FIELDS) {
    if (key === "sources") continue;
    const value = document.frontmatter[key as keyof KnowledgeFrontmatter];
    if (value !== undefined) {
      mapping[key] = value;
    }
  }

  // Sources
  if (document.sources.kind !== "absent") {
    mapping.sources = document.sources.value;
  }

  // Extensions
  for (const [key, value] of Object.entries(document.extensions)) {
    mapping[key] = value;
  }

  const yaml = stringify(mapping, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  })
    .replace(/\r\n?/g, "\n")
    .replace(/\n*$/, "\n");

  const body = document.body.replace(/\r\n?/g, "\n").replace(/\n*$/, "");
  return body ? `---\n${yaml}---\n\n${body}\n` : `---\n${yaml}---\n`;
}

export function createKnowledgeDocument<T extends KnowledgeCreationFields>(
  path: string,
  fields: T & NoInfer<KnowledgeCreationFields>,
  body: string,
  sources?: Array<Record<string, KnowledgeValue>>,
): KnowledgeDocument {
  if (Object.hasOwn(fields, "sources")) {
    throw new Error("Pass canonical sources as the fourth argument");
  }

  const frontmatter: KnowledgeFrontmatter = { type: fields.type };
  const extensions: Record<string, KnowledgeValue> = Object.create(null);

  for (const [key, value] of Object.entries(fields)) {
    if (key === "type") continue;
    if (STANDARD_FIELDS.has(key)) {
      (frontmatter as Record<string, unknown>)[key] = value;
    } else {
      extensions[key] = value;
    }
  }

  const sourcesUnion = sources
    ? { kind: "canonical" as const, value: sources }
    : { kind: "absent" as const };

  const normalizedBody = body.replace(/\r\n?/g, "\n").replace(/\n*$/, "");

  return {
    id: path.replace(/\.md$/, ""),
    path,
    frontmatter,
    sources: sourcesUnion,
    extensions,
    body: normalizedBody,
    compatibility: {
      legacyFields: [],
      hasLegacyWikilinks: detectLegacyWikilinks(normalizedBody),
    },
  };
}

export function patchKnowledgeDocument(
  document: KnowledgeDocument,
  patch: KnowledgePatch,
): KnowledgeDocument {
  const newFrontmatter = { ...document.frontmatter };
  if (patch.fields) {
    for (const [key, value] of Object.entries(patch.fields)) {
      if (value !== undefined) {
        (newFrontmatter as Record<string, unknown>)[key] = value;
      }
    }
  }

  const newBody = patch.body ?? document.body;

  return {
    ...document,
    frontmatter: newFrontmatter,
    body: newBody,
  };
}

export function readKnowledgeDocumentFile(path: string, id: string): ParseKnowledgeResult {
  const content = readFileSync(path, "utf8");
  return parseKnowledgeDocument(content, id);
}

export function writeKnowledgeDocumentFile(path: string, document: KnowledgeDocument): void {
  const content = serializeKnowledgeDocument(document);
  writeFileSync(path, content, "utf8");
}
