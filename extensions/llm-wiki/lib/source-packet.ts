import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendEvent } from "./metadata.js";
import {
  type ExtractedContent,
  binaryExtractionFailureMessage,
  detectBinaryMagicBytes,
  extractUrlContent,
  fileExtractorFor,
} from "./source-extractors.js";
import { type VaultPaths, exec, fmtDate, nextSourceId, readText, writeJson } from "./utils.js";

/**
 * Source packet capture and management.
 *
 * Each source is stored as a structured packet:
 *   raw/sources/SRC-YYYY-MM-DD-NNN/
 *     manifest.json    — capture metadata
 *     original/        — original artifact (if file/URL)
 *     extracted.md     — normalized markdown text
 *     attachments/     — downloaded images, PDFs, etc.
 */

export interface CaptureResult {
  sourceId: string;
  packetPath: string;
  sourcePagePath: string;
  extracted: string;
}

interface SourcePacket {
  sourceId: string;
  packetPath: string;
}

interface CaptureSource {
  needsOriginalDir: boolean;
  fallbackText: string;
  preserveOriginal?(packetPath: string): Promise<void>;
  extract(): Promise<ExtractedContent> | ExtractedContent;
  manifest(content: ExtractedContent): Record<string, unknown>;
  event(content: ExtractedContent): Record<string, unknown>;
}

const URL_ORIGINAL_EXTENSIONS = new Set([".html", ".htm", ".md", ".pdf", ".txt", ".xml", ".json"]);

/** Capture a URL into a source packet. */
export async function captureUrl(
  pi: ExtensionAPI,
  paths: VaultPaths,
  url: string,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  return captureSource(paths, urlCaptureSource(pi, url, signal));
}

/** Capture a local file into a source packet. */
export async function captureFile(
  pi: ExtensionAPI,
  paths: VaultPaths,
  filePath: string,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  return captureSource(paths, fileCaptureSource(pi, filePath, signal));
}

/** Capture pasted text into a source packet. */
export function captureText(paths: VaultPaths, text: string, title?: string): CaptureResult {
  return captureSourceSync(paths, textCaptureSource(text, title));
}

async function captureSource(paths: VaultPaths, source: CaptureSource): Promise<CaptureResult> {
  const packet = createSourcePacket(paths, source.needsOriginalDir);
  await source.preserveOriginal?.(packet.packetPath);
  const content = await source.extract();
  return finalizeCapture(paths, packet, source, content);
}

function captureSourceSync(paths: VaultPaths, source: CaptureSource): CaptureResult {
  const packet = createSourcePacket(paths, source.needsOriginalDir);
  const content = source.extract() as ExtractedContent;
  return finalizeCapture(paths, packet, source, content);
}

function urlCaptureSource(pi: ExtensionAPI, url: string, signal?: AbortSignal): CaptureSource {
  return {
    needsOriginalDir: true,
    fallbackText: contentExtractionFailureMessage(url),
    preserveOriginal: (packetPath) => preserveUrlOriginal(pi, packetPath, url, signal),
    extract: () => extractUrlContent(pi, url, signal),
    manifest: (content) => ({
      title: content.title || url,
      url,
      format: "web",
    }),
    event: () => ({ url, format: "web" }),
  };
}

function fileCaptureSource(
  pi: ExtensionAPI,
  filePath: string,
  signal?: AbortSignal,
): CaptureSource {
  const fileName = filePath.split("/").pop() || "unknown";
  const extractor = fileExtractorFor(filePath);
  const content = extractor.shouldReadText ? readText(filePath) : "";

  return {
    needsOriginalDir: true,
    fallbackText: "",
    preserveOriginal: (packetPath) =>
      preserveFileOriginal(pi, packetPath, filePath, fileName, content, signal),
    extract: async () => {
      // Guard: if we hit the generic catch-all extractor, check for binary magic bytes first
      if (extractor.format === "file") {
        const binaryFormat = await detectBinaryMagicBytes(filePath);
        if (binaryFormat) {
          return {
            extracted: binaryExtractionFailureMessage(binaryFormat),
            extractor: "magicBytes",
            extraction_status: "unsupported" as const,
          };
        }
      }

      const extractedStr = await extractor.extract({ pi, filePath, content, signal });
      const failed = extractedStr.includes("could not be converted");
      return {
        extracted: extractedStr,
        extractor: extractor.extractorName ?? "passthrough",
        extraction_status: (failed ? "failed" : "success") as "failed" | "success",
        ...(extractor.content_type ? { content_type: extractor.content_type } : {}),
      };
    },
    manifest: () => ({
      title: fileName,
      file_path: filePath,
      format: extractor.format,
    }),
    event: () => ({ file_path: filePath, format: extractor.format }),
  };
}

function textCaptureSource(text: string, title?: string): CaptureSource {
  return {
    needsOriginalDir: false,
    fallbackText: "",
    extract: () => ({ extracted: text }),
    manifest: () => ({
      title: title || `Pasted text — ${fmtDate()}`,
      format: "text",
    }),
    event: () => ({ format: "text" }),
  };
}

function createSourcePacket(paths: VaultPaths, needsOriginalDir: boolean): SourcePacket {
  const sourceId = nextSourceId(paths);
  const packetPath = join(paths.rawSources, sourceId);
  mkdirSync(packetPath, { recursive: true });
  mkdirSync(join(packetPath, "attachments"), { recursive: true });
  if (needsOriginalDir) mkdirSync(join(packetPath, "original"), { recursive: true });
  return { sourceId, packetPath };
}

function finalizeCapture(
  paths: VaultPaths,
  packet: SourcePacket,
  source: CaptureSource,
  content: ExtractedContent,
): CaptureResult {
  const extracted = content.extracted || source.fallbackText;
  const manifest = {
    id: packet.sourceId,
    captured: fmtDate(),
    packet_version: "1.0",
    ...source.manifest({ ...content, extracted }),
    extractor: content.extractor ?? "passthrough",
    extraction_status: content.extraction_status ?? "success",
    ...(content.content_type ? { content_type: content.content_type } : {}),
  };

  writeFileSync(join(packet.packetPath, "extracted.md"), extracted, "utf-8");
  writeJson(join(packet.packetPath, "manifest.json"), manifest);

  const sourcePagePath = join(paths.wiki, "sources", `${packet.sourceId}.md`);
  writeFileSync(sourcePagePath, buildSourcePageSkeleton(manifest, extracted), "utf-8");

  appendEvent(paths, {
    kind: "capture",
    source_id: packet.sourceId,
    ...source.event({ ...content, extracted }),
  });

  return {
    sourceId: packet.sourceId,
    packetPath: packet.packetPath,
    sourcePagePath,
    extracted,
  };
}

async function preserveFileOriginal(
  pi: ExtensionAPI,
  packetPath: string,
  filePath: string,
  fileName: string,
  fallbackContent: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await exec(pi, "cp", [filePath, join(packetPath, "original", fileName)], { signal });
  } catch {
    // If cp fails, preserve whatever text content was available.
    writeFileSync(join(packetPath, "original", fileName), fallbackContent, "utf-8");
  }
}

async function preserveUrlOriginal(
  pi: ExtensionAPI,
  packetPath: string,
  url: string,
  signal?: AbortSignal,
): Promise<void> {
  const originalPath = join(packetPath, "original", originalFileNameForUrl(url));
  try {
    await exec(pi, "curl", ["-sL", "--max-time", "30", "-o", originalPath, url], {
      signal,
      timeout: 35_000,
    });
  } catch {
    // Preserve best-effort extraction behavior even when the original artifact cannot be saved.
  }
}

function originalFileNameForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const ext = extname(parsed.pathname).toLowerCase();
    if (URL_ORIGINAL_EXTENSIONS.has(ext)) return `source${ext}`;
  } catch {
    const path = url.split(/[?#]/, 1)[0] ?? "";
    const ext = extname(path).toLowerCase();
    if (URL_ORIGINAL_EXTENSIONS.has(ext)) return `source${ext}`;
  }

  return "source.html";
}

function contentExtractionFailureMessage(source: string): string {
  return `_Content could not be extracted from ${source}_\n`;
}

/** Build a skeleton source page from manifest and extracted text. */
function buildSourcePageSkeleton(manifest: Record<string, unknown>, extracted: string): string {
  const id = String(manifest.id);
  const title = String(manifest.title || id);
  const url = manifest.url ? `\n> _Original: [${manifest.url}](${manifest.url})_` : "";
  const format = String(manifest.format || "unknown");
  const captured = String(manifest.captured || fmtDate());

  // Generate a brief auto-summary (first 500 chars)
  const preview = extracted
    .replace(/[#*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

  return `---
type: source
format: ${format}
source_id: ${id}
raw_path: raw/sources/${id}/extracted.md
captured: ${captured}
status: skeleton
---

# ${title}${url}

## Summary

[LLM: Replace with 2-3 paragraph summary of key content]

> _Auto-preview: ${preview}${extracted.length > 500 ? "..." : ""}_

## Key Takeaways

- [LLM: Most important point]
- [LLM: Second important point]
- [LLM: Third important point]

## Entities Mentioned

- [[entity-name]]

## Concepts Mentioned

- [[concept-name]]

## Notable Quotes

> [LLM: Important quote] — attribution

## Source Packet

- **ID:** \`[[sources/${id}]]\`
- **Extracted:** [raw/sources/${id}/extracted.md](../raw/sources/${id}/extracted.md)
- **Manifest:** [raw/sources/${id}/manifest.json](../raw/sources/${id}/manifest.json)
`;
}
