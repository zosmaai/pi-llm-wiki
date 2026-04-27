import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendEvent } from "./metadata.js";
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

/** Capture a URL into a source packet. */
export async function captureUrl(
  pi: ExtensionAPI,
  paths: VaultPaths,
  url: string,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const sourceId = nextSourceId(paths);
  const packetPath = join(paths.rawSources, sourceId);
  mkdirSync(packetPath, { recursive: true });
  mkdirSync(join(packetPath, "original"), { recursive: true });
  mkdirSync(join(packetPath, "attachments"), { recursive: true });

  // Try to fetch and extract content
  let extracted = "";
  let title = url;

  // Try markitdown first
  const markitdown = await exec(
    pi,
    "sh",
    ["-c", `which uvx >/dev/null 2>&1 && echo "yes" || echo "no"`],
    { signal },
  );

  if (markitdown.stdout.trim() === "yes") {
    try {
      const mdResult = await exec(
        pi,
        "sh",
        ["-c", `uvx --from 'markitdown[pdf]' markitdown "${url}" 2>/dev/null || echo ""`],
        { signal, timeout: 30_000 },
      );
      if (mdResult.stdout.trim()) {
        extracted = mdResult.stdout;
        // Try to extract title from first h1
        const h1Match = extracted.match(/^#\s+(.+)$/m);
        if (h1Match) title = h1Match[1].trim();
      }
    } catch {
      // markitdown failed, fall through
    }
  }

  // Fallback: try fetch_content equivalent via curl
  if (!extracted) {
    try {
      const curlResult = await exec(pi, "curl", ["-sL", "--max-time", "30", url], {
        signal,
        timeout: 35_000,
      });
      if (curlResult.stdout) {
        extracted = curlResult.stdout;
        // Try to extract title from HTML
        const titleMatch = extracted.match(/<title>([^<]*)<\/title>/i);
        if (titleMatch) title = titleMatch[1].trim();
      }
    } catch {
      // curl failed too
    }
  }

  // Write extracted text
  writeFileSync(
    join(packetPath, "extracted.md"),
    extracted || `_Content could not be extracted from ${url}_\n`,
    "utf-8",
  );

  // Write manifest
  const manifest = {
    id: sourceId,
    title,
    url,
    captured: fmtDate(),
    format: "web",
    packet_version: "1.0",
  };
  writeJson(join(packetPath, "manifest.json"), manifest);

  // Create skeleton source page in wiki
  const sourcePagePath = join(paths.wiki, "sources", `${sourceId}.md`);
  const sourcePageContent = buildSourcePageSkeleton(manifest, extracted);
  writeFileSync(sourcePagePath, sourcePageContent, "utf-8");

  // Log event
  appendEvent(paths, { kind: "capture", source_id: sourceId, url, format: "web" });

  return { sourceId, packetPath, sourcePagePath, extracted };
}

/** Capture a local file into a source packet. */
export async function captureFile(
  pi: ExtensionAPI,
  paths: VaultPaths,
  filePath: string,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const sourceId = nextSourceId(paths);
  const packetPath = join(paths.rawSources, sourceId);
  mkdirSync(packetPath, { recursive: true });
  mkdirSync(join(packetPath, "original"), { recursive: true });
  mkdirSync(join(packetPath, "attachments"), { recursive: true });

  const content = readText(filePath);
  const fileName = filePath.split("/").pop() || "unknown";

  // Try markitdown for PDFs
  let extracted = content;
  if (filePath.toLowerCase().endsWith(".pdf")) {
    const markitdown = await exec(
      pi,
      "sh",
      ["-c", `which uvx >/dev/null 2>&1 && echo "yes" || echo "no"`],
      { signal },
    );

    if (markitdown.stdout.trim() === "yes") {
      try {
        const mdResult = await exec(
          pi,
          "sh",
          ["-c", `uvx --from 'markitdown[pdf]' markitdown "${filePath}" 2>/dev/null || echo ""`],
          { signal, timeout: 30_000 },
        );
        if (mdResult.stdout.trim()) extracted = mdResult.stdout;
      } catch {
        // fallback to original
      }
    }
  }

  // Copy original to packet
  try {
    await exec(pi, "cp", [filePath, join(packetPath, "original", fileName)], { signal });
  } catch {
    // If cp fails, just write the content
    writeFileSync(join(packetPath, "original", fileName), content, "utf-8");
  }

  // Write extracted text
  writeFileSync(join(packetPath, "extracted.md"), extracted, "utf-8");

  // Write manifest
  const manifest = {
    id: sourceId,
    title: fileName,
    file_path: filePath,
    captured: fmtDate(),
    format: guessFormat(filePath),
    packet_version: "1.0",
  };
  writeJson(join(packetPath, "manifest.json"), manifest);

  // Create skeleton source page
  const sourcePagePath = join(paths.wiki, "sources", `${sourceId}.md`);
  const sourcePageContent = buildSourcePageSkeleton(manifest, extracted);
  writeFileSync(sourcePagePath, sourcePageContent, "utf-8");

  // Log event
  appendEvent(paths, {
    kind: "capture",
    source_id: sourceId,
    file_path: filePath,
    format: manifest.format,
  });

  return { sourceId, packetPath, sourcePagePath, extracted };
}

/** Capture pasted text into a source packet. */
export function captureText(paths: VaultPaths, text: string, title?: string): CaptureResult {
  const sourceId = nextSourceId(paths);
  const packetPath = join(paths.rawSources, sourceId);
  mkdirSync(packetPath, { recursive: true });
  mkdirSync(join(packetPath, "attachments"), { recursive: true });

  // Write extracted text
  writeFileSync(join(packetPath, "extracted.md"), text, "utf-8");

  // Write manifest
  const manifest = {
    id: sourceId,
    title: title || `Pasted text — ${fmtDate()}`,
    captured: fmtDate(),
    format: "text",
    packet_version: "1.0",
  };
  writeJson(join(packetPath, "manifest.json"), manifest);

  // Create skeleton source page
  const sourcePagePath = join(paths.wiki, "sources", `${sourceId}.md`);
  const sourcePageContent = buildSourcePageSkeleton(manifest, text);
  writeFileSync(sourcePagePath, sourcePageContent, "utf-8");

  // Log event
  appendEvent(paths, { kind: "capture", source_id: sourceId, format: "text" });

  return { sourceId, packetPath, sourcePagePath, extracted: text };
}

/** Build a skeleton source page from manifest and extracted text. */
function buildSourcePageSkeleton(manifest: Record<string, unknown>, extracted: string): string {
  const id = String(manifest.id);
  const title = String(manifest.title || id);
  const url = manifest.url ? `\n> _Original: ${manifest.url}_` : "";
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

function guessFormat(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".txt")) return "text";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".docx")) return "docx";
  return "file";
}
