/**
 * Prebuild script: generates Starlight-compatible docs from docs/*.md.
 *
 * Reads each .md file, extracts the first `# Title` heading, prepends
 * YAML frontmatter with title + slug, writes to src/content/docs/.
 *
 * Single source of truth: docs/*.md. This script is the only thing
 * that touches src/content/docs/ (aside from index.md).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const docsDir = join(import.meta.dirname, "..", "docs");
const outDir = join(import.meta.dirname, "..", "src", "content", "docs");

const files = readdirSync(docsDir).filter((f) => f.endsWith(".md"));

for (const file of files) {
  const content = readFileSync(join(docsDir, file), "utf-8");
  const slug = basename(file, ".md");

  // Extract title from first # heading
  const match = content.match(/^#\s+(.+)$/m);
  const title = match ? match[1].trim() : slug;

  // Only add frontmatter if missing
  const hasFrontmatter = content.startsWith("---");
  const body = hasFrontmatter
    ? content
    : `---\ntitle: "${title}"\nslug: ${slug}\n---\n\n${content}`;

  writeFileSync(join(outDir, file), body);
}

console.log(`Synced ${files.length} docs from docs/ → src/content/docs/`);
