import { open } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "./utils.js";

export type ExtractionStatus = "success" | "failed" | "unsupported";

export interface ExtractedContent {
  extracted: string;
  title?: string;
  extractor?: string;
  extraction_status?: ExtractionStatus;
  content_type?: string;
}

export interface FileExtractor {
  format: string;
  shouldReadText: boolean;
  extractorName?: string;
  content_type?: string;
  matches(filePath: string): boolean;
  extract(args: FileExtractArgs): Promise<string> | string;
}

interface FileExtractArgs {
  pi: ExtensionAPI;
  filePath: string;
  content: string;
  signal?: AbortSignal;
}

interface UrlExtractor {
  matches(url: string): boolean;
  extract(args: UrlExtractArgs): Promise<ExtractedContent>;
}

interface UrlExtractArgs {
  pi: ExtensionAPI;
  url: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Binary magic byte detection
// ---------------------------------------------------------------------------

const BINARY_SIGNATURES: Array<{ bytes: number[]; format: string }> = [
  // Archives & documents
  { bytes: [0x50, 0x4b, 0x03, 0x04], format: "zip" }, // ZIP / DOCX / XLSX / PPTX / JAR
  { bytes: [0x25, 0x50, 0x44, 0x46], format: "pdf" }, // %PDF
  { bytes: [0x37, 0x7a, 0xbc, 0xaf], format: "7z" }, // 7-Zip
  { bytes: [0x1f, 0x8b], format: "gzip" }, // gzip / .tar.gz
  // Images
  { bytes: [0x89, 0x50, 0x4e, 0x47], format: "png" }, // PNG
  { bytes: [0xff, 0xd8, 0xff], format: "jpeg" }, // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38], format: "gif" }, // GIF8
  { bytes: [0x42, 0x4d], format: "bmp" }, // BMP
  { bytes: [0x49, 0x49, 0x2a, 0x00], format: "tiff" }, // TIFF (little-endian)
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], format: "tiff" }, // TIFF (big-endian)
  { bytes: [0x52, 0x49, 0x46, 0x46], format: "riff" }, // RIFF (WAV / AVI / WebP)
  // Executables & binaries
  { bytes: [0x4d, 0x5a], format: "exe" }, // Windows PE (EXE / DLL)
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], format: "macho" }, // Mach-O 64-bit LE
  { bytes: [0xce, 0xfa, 0xed, 0xfe], format: "macho" }, // Mach-O 32-bit LE
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], format: "macho" }, // Mach-O 64-bit BE
  { bytes: [0xfe, 0xed, 0xfa, 0xce], format: "macho" }, // Mach-O 32-bit BE
  { bytes: [0xca, 0xfe, 0xba, 0xbe], format: "class" }, // Java .class / Mach-O FAT
  { bytes: [0x7f, 0x45, 0x4c, 0x46], format: "elf" }, // ELF binary
  { bytes: [0x00, 0x61, 0x73, 0x6d], format: "wasm" }, // WebAssembly
  // Data & media
  { bytes: [0x53, 0x51, 0x4c, 0x69], format: "sqlite" }, // SQLite
  { bytes: [0x49, 0x44, 0x33], format: "mp3" }, // MP3 (ID3 tag)
];

/**
 * Reads the first 8 bytes of `filePath` and checks them against known binary
 * magic byte signatures. Returns the detected format name or `null` for text.
 */
export async function detectBinaryMagicBytes(filePath: string): Promise<string | null> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await open(filePath, "r");
    const buf = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buf, 0, 8, 0);
    const header = buf.subarray(0, bytesRead);

    for (const { bytes, format } of BINARY_SIGNATURES) {
      if (bytes.every((b, i) => header[i] === b)) return format;
    }
    return null;
  } catch {
    return null; // Unreadable file — let the extractor deal with it
  } finally {
    await handle?.close();
  }
}

export function binaryExtractionFailureMessage(format: string): string {
  return `_Binary file could not be converted to markdown (detected format: ${format}).\nCapture a text-based version or a URL pointing to readable content instead._\n`;
}

// ---------------------------------------------------------------------------

const DEFAULT_MARKITDOWN_TIMEOUT_MS = 180_000;
const DEFAULT_CURL_TIMEOUT_SECONDS = 30;

const FILE_EXTRACTORS: FileExtractor[] = [
  {
    format: "pdf",
    shouldReadText: false,
    extractorName: "markitdown",
    content_type: "application/pdf",
    matches: hasExtension(".pdf"),
    extract: ({ pi, filePath, signal }) => extractPdf(pi, filePath, signal),
  },
  textFileExtractor("markdown", [".md"], "text/markdown"),
  textFileExtractor("text", [".txt"], "text/plain"),
  textFileExtractor("html", [".html", ".htm"], "text/html"),
  {
    format: "xml",
    shouldReadText: true,
    extractorName: "xmlToMarkdown",
    content_type: "application/xml",
    matches: hasExtension(".xml"),
    extract: ({ content }) => xmlToMarkdown(content),
  },
  {
    format: "json",
    shouldReadText: true,
    extractorName: "jsonToMarkdown",
    content_type: "application/json",
    matches: hasExtension(".json"),
    extract: ({ content }) => jsonToMarkdown(content),
  },
  {
    format: "docx",
    shouldReadText: false,
    extractorName: "markitdown",
    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    matches: hasExtension(".docx"),
    extract: ({ pi, filePath, signal }) => extractDocx(pi, filePath, signal),
  },
  textFileExtractor("file", []),
];

const URL_EXTRACTORS: UrlExtractor[] = [
  {
    matches: isPdfUrl,
    extract: ({ pi, url, signal }) => extractPdfUrl(pi, url, signal),
  },
  {
    matches: () => true,
    extract: ({ pi, url, signal }) => extractTextUrl(pi, url, signal),
  },
];

export function fileExtractorFor(filePath: string): FileExtractor {
  return (
    FILE_EXTRACTORS.find((extractor) => extractor.matches(filePath)) ?? FILE_EXTRACTORS.at(-1)!
  );
}

export function extractUrlContent(
  pi: ExtensionAPI,
  url: string,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  const extractor =
    URL_EXTRACTORS.find((candidate) => candidate.matches(url)) ?? URL_EXTRACTORS.at(-1)!;
  return extractor.extract({ pi, url, signal });
}

export function pdfExtractionFailureMessage(source: string): string {
  return `_PDF content could not be converted to markdown from ${source}. Try increasing WIKI_MARKITDOWN_TIMEOUT_MS._\n`;
}

function textFileExtractor(
  format: string,
  extensions: string[],
  contentType?: string,
): FileExtractor {
  return {
    format,
    shouldReadText: true,
    extractorName: "passthrough",
    content_type: contentType,
    matches: extensions.length ? hasAnyExtension(extensions) : () => true,
    extract: ({ content }) => content,
  };
}

function hasExtension(extension: string): (path: string) => boolean {
  return (path) => path.toLowerCase().endsWith(extension);
}

function hasAnyExtension(extensions: string[]): (path: string) => boolean {
  return (path) => extensions.some((extension) => hasExtension(extension)(path));
}

async function extractPdf(pi: ExtensionAPI, source: string, signal?: AbortSignal): Promise<string> {
  const extracted = await extractWithMarkItDown(pi, source, signal);
  return extracted || pdfExtractionFailureMessage(source);
}

export function docxExtractionFailureMessage(source: string): string {
  return `_DOCX content could not be converted to markdown from ${source}. Ensure uvx and markitdown are installed._\n`;
}

async function extractDocx(
  pi: ExtensionAPI,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  const extracted = await extractWithMarkItDown(pi, source, signal);
  return extracted || docxExtractionFailureMessage(source);
}

async function extractPdfUrl(
  pi: ExtensionAPI,
  url: string,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  const extracted = await extractPdf(pi, url, signal);
  const failed = extracted.includes("could not be converted");
  return {
    extracted,
    title: titleFromMarkdown(extracted),
    extractor: "markitdown",
    extraction_status: failed ? "failed" : "success",
    content_type: "application/pdf",
  };
}

async function extractTextUrl(
  pi: ExtensionAPI,
  url: string,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  const markitdownExtracted = await extractWithMarkItDown(pi, url, signal);
  if (markitdownExtracted) {
    return {
      extracted: markitdownExtracted,
      title: titleFromMarkdown(markitdownExtracted),
      extractor: "markitdown",
      extraction_status: "success",
    };
  }

  const curlExtracted = await fetchTextUrl(pi, url, signal);
  if (!curlExtracted) return { extracted: "", extractor: "none", extraction_status: "failed" };
  if (looksLikePdf(curlExtracted)) {
    return {
      extracted: pdfExtractionFailureMessage(url),
      extractor: "curl",
      extraction_status: "failed",
      content_type: "application/pdf",
    };
  }
  return {
    extracted: curlExtracted,
    title: titleFromHtml(curlExtracted),
    extractor: "curl",
    extraction_status: "success",
  };
}

async function extractWithMarkItDown(
  pi: ExtensionAPI,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!(await hasMarkItDown(pi, signal))) return "";

  try {
    const mdResult = await exec(
      pi,
      "sh",
      ["-c", `uvx --from 'markitdown[docx,pdf]' markitdown "${source}" 2>/dev/null || echo ""`],
      { signal, timeout: markitdownTimeoutMs() },
    );
    return mdResult.stdout.trim() ? mdResult.stdout : "";
  } catch {
    return "";
  }
}

async function hasMarkItDown(pi: ExtensionAPI, signal?: AbortSignal): Promise<boolean> {
  const markitdown = await exec(
    pi,
    "sh",
    ["-c", `which uvx >/dev/null 2>&1 && echo "yes" || echo "no"`],
    { signal },
  );
  return markitdown.stdout.trim() === "yes";
}

async function fetchTextUrl(pi: ExtensionAPI, url: string, signal?: AbortSignal): Promise<string> {
  try {
    const curlResult = await exec(
      pi,
      "curl",
      ["-sL", "--max-time", String(DEFAULT_CURL_TIMEOUT_SECONDS), url],
      {
        signal,
        timeout: (DEFAULT_CURL_TIMEOUT_SECONDS + 5) * 1_000,
      },
    );
    return curlResult.stdout || "";
  } catch {
    return "";
  }
}

function markitdownTimeoutMs(): number {
  return positiveIntegerFromEnv("WIKI_MARKITDOWN_TIMEOUT_MS", DEFAULT_MARKITDOWN_TIMEOUT_MS);
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return url.toLowerCase().split(/[?#]/, 1)[0].endsWith(".pdf");
  }
}

function looksLikePdf(content: string): boolean {
  return content.trimStart().startsWith("%PDF-");
}

function titleFromMarkdown(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function titleFromHtml(html: string): string | undefined {
  return html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
}

/** Basic XML to markdown conversion: strip tags while preserving text structure. */
function xmlToMarkdown(xml: string): string {
  let title = "";
  const titleMatch = xml.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) title = titleMatch[1].trim();

  let text = xml.replace(/<\?xml[^>]*\?>\s*/gi, "");
  text = text.replace(/<!DOCTYPE[^>]*>\s*/gi, "");
  text = text.replace(/<\/(p|div|section|article|li|h\d|tr|blockquote|pre)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  let prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(/<[a-zA-Z\/!?][^>]*>/g, "");
  }
  text = text.replace(/</g, "");

  text = text.replace(/&(?:amp|lt|gt|quot|#\d+);/gi, (entity) => {
    const map: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' };
    const lower = entity.toLowerCase();
    if (map[lower]) return map[lower];
    if (lower.startsWith("&#")) return String.fromCodePoint(Number.parseInt(entity.slice(2, -1)));
    return entity;
  });

  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return xml;

  const lines = [];
  if (title) lines.push(`# ${title}\n`);
  lines.push(text);
  return lines.join("\n\n");
}

function jsonToMarkdown(json: string): string {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return json;
  }

  const lines: string[] = [];
  const title = titleFromValue(value) || "JSON Extract";
  lines.push(`# ${title}`, "");
  renderJsonValue(value, lines, 0);

  const markdown = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown || json;
}

function titleFromValue(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["title", "name", "id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderJsonValue(value: unknown, lines: string[], depth: number, label?: string): void {
  if (Array.isArray(value)) {
    renderJsonArray(value, lines, depth, label);
    return;
  }

  if (isRecord(value)) {
    renderJsonObject(value, lines, depth, label);
    return;
  }

  if (label) lines.push(`${indent(depth)}- **${humanizeKey(label)}:** ${formatJsonScalar(value)}`);
  else lines.push(`${indent(depth)}- ${formatJsonScalar(value)}`);
}

function renderJsonObject(
  object: Record<string, unknown>,
  lines: string[],
  depth: number,
  label?: string,
): void {
  if (label) {
    lines.push(`${heading(depth)} ${humanizeKey(label)}`, "");
  }

  for (const [key, value] of Object.entries(object)) {
    if (Array.isArray(value) || isRecord(value)) {
      const childDepth = label ? depth + 1 : depth;
      renderJsonValue(value, lines, childDepth, key);
    } else {
      lines.push(`${indent(depth)}- **${humanizeKey(key)}:** ${formatJsonScalar(value)}`);
    }
  }
  lines.push("");
}

function renderJsonArray(array: unknown[], lines: string[], depth: number, label?: string): void {
  if (label) lines.push(`${heading(depth)} ${humanizeKey(label)}`, "");

  if (array.length === 0) {
    lines.push(`${indent(depth)}- _(empty)_`, "");
    return;
  }

  for (const [index, item] of array.entries()) {
    if (isRecord(item)) {
      const itemTitle = titleFromValue(item) || `Item ${index + 1}`;
      const itemDepth = label ? depth + 1 : depth;
      lines.push(`${heading(itemDepth)} ${itemTitle}`, "");
      renderJsonObject(item, lines, itemDepth);
    } else if (Array.isArray(item)) {
      lines.push(`${indent(depth)}- Item ${index + 1}:`);
      renderJsonArray(item, lines, depth + 1);
    } else {
      lines.push(`${indent(depth)}- ${formatJsonScalar(item)}`);
    }
  }
  lines.push("");
}

function formatJsonScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value);
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function heading(depth: number): string {
  return "#".repeat(Math.min(depth + 2, 6));
}

function indent(depth: number): string {
  return "  ".repeat(Math.max(0, depth));
}
