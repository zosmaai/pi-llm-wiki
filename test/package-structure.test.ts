import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFile, rootDir } from "./helpers.js";

function readProductionFiles(directory: string): string[] {
  const contents: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...readProductionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) contents.push(readFile(path));
  }
  return contents;
}

describe("package structure", () => {
  it("should have a valid package.json with pi manifest", () => {
    const pkg = JSON.parse(readFile(join(rootDir, "package.json")));
    expect(pkg.name).toBe("@zosmaai/pi-llm-wiki");
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi.extensions).toContain("./extensions");
    expect(pkg.pi.skills).toContain("./skills");
    expect(pkg.pi.prompts).toContain("./prompts");
    expect(pkg.peerDependencies).toBeDefined();
    expect(pkg.peerDependencies["@mariozechner/pi-coding-agent"]).toBe("*");
    expect(pkg.peerDependencies.typebox).toBe("*");
  });

  it("should have a SKILL.md with valid frontmatter and schema content", () => {
    const skillPath = join(rootDir, "skills", "llm-wiki", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const content = readFile(skillPath);
    expect(content).toContain("name: llm-wiki");
    expect(content).toContain("## Golden Rules");
    expect(content).toContain("RAW IS IMMUTABLE");
    expect(content).toContain("## Workflows");
    expect(content).toContain("wiki_ingest");
    expect(content).toContain("Obsidian Integration");
    expect(content).toContain("Personal Wiki");
    expect(content).toContain("Company Wiki");
  });

  it("should have all prompt templates with frontmatter", () => {
    const prompts = [
      "wiki-init.md",
      "wiki-ingest.md",
      "wiki-query.md",
      "wiki-lint.md",
      "wiki-discover.md",
      "wiki-run.md",
      "wiki-status.md",
      "wiki-digest.md",
      "wiki-retro.md",
    ];
    for (const prompt of prompts) {
      const path = join(rootDir, "prompts", prompt);
      expect(existsSync(path)).toBe(true);
      const content = readFile(path);
      expect(content).toContain("description:");
      expect(content).toContain("argument-hint:");
      expect(content).toContain("section: LLM Wiki");
      expect(content).toContain("topLevelCli: true");
    }
  });

  it("should include prompt arguments in templates that accept them", () => {
    const promptsWithArgs = [
      "wiki-init.md",
      "wiki-ingest.md",
      "wiki-query.md",
      "wiki-lint.md",
      "wiki-discover.md",
      "wiki-run.md",
      "wiki-digest.md",
    ];
    for (const prompt of promptsWithArgs) {
      const content = readFile(join(rootDir, "prompts", prompt));
      expect(content).toContain("$ARGUMENTS");
    }

    const query = readFile(join(rootDir, "prompts", "wiki-query.md"));
    expect(query).toContain("## User Question");
    expect(query).toContain("$ARGUMENTS");
  });

  it("should have all wiki template files", () => {
    const t = join(rootDir, "skills", "llm-wiki", "templates");
    expect(existsSync(join(t, "INDEX.md"))).toBe(true);
    expect(existsSync(join(t, "LOG.md"))).toBe(true);
    expect(existsSync(join(t, "DASHBOARD.md"))).toBe(true);
    expect(existsSync(join(t, "config.yaml"))).toBe(true);
    expect(existsSync(join(t, "pages", "entity.md"))).toBe(true);
    expect(existsSync(join(t, "pages", "concept.md"))).toBe(true);
    expect(existsSync(join(t, "pages", "source.md"))).toBe(true);
    expect(existsSync(join(t, "pages", "synthesis.md"))).toBe(true);
  });

  it("should have the extension entry point", () => {
    const extPath = join(rootDir, "extensions", "llm-wiki", "index.ts");
    expect(existsSync(extPath)).toBe(true);
    const content = readFile(extPath);
    expect(content).toContain("ExtensionAPI");
    expect(content).toContain("registerWikiBootstrap");
  });

  it("should have all custom tools registered in the extension entry point", () => {
    const indexPath = join(rootDir, "extensions", "llm-wiki", "index.ts");
    expect(existsSync(indexPath)).toBe(true);
    const content = readFile(indexPath);
    const toolRegistrations = [
      "registerWikiBootstrap",
      "registerWikiCaptureSource",
      "registerWikiIngest",
      "registerWikiEnsurePage",
      "registerWikiSearch",
      "registerWikiLint",
      "registerWikiStatus",
      "registerWikiRebuildMeta",
      "registerWikiLogEvent",
      "registerWikiWatch",
      "registerWikiRecall",
      "registerWikiRetro",
    ];
    for (const fn of toolRegistrations) {
      expect(content).toContain(fn);
    }
  });

  it("should keep MarkItDown timeout configurable and avoid PDF byte fallbacks", () => {
    const sourcePacketPath = join(rootDir, "extensions", "llm-wiki", "lib", "source-packet.ts");
    const sourceExtractorsPath = join(
      rootDir,
      "extensions",
      "llm-wiki",
      "lib",
      "source-extractors.ts",
    );
    expect(existsSync(sourcePacketPath)).toBe(true);
    expect(existsSync(sourceExtractorsPath)).toBe(true);

    const sourcePacket = readFile(sourcePacketPath);
    const sourceExtractors = readFile(sourceExtractorsPath);
    expect(sourcePacket).toContain("captureSource");
    expect(sourcePacket).toContain("fileExtractorFor");
    expect(sourcePacket).toContain("extractUrlContent");
    expect(sourceExtractors).toContain("WIKI_MARKITDOWN_TIMEOUT_MS");
    expect(sourceExtractors).toContain("DEFAULT_MARKITDOWN_TIMEOUT_MS = 180_000");
    expect(sourceExtractors).toContain("URL_EXTRACTORS");
    expect(sourceExtractors).toContain("matches: isPdfUrl");
    expect(sourceExtractors).toContain("looksLikePdf(curlExtracted)");
    expect(sourceExtractors).toContain("pdfExtractionFailureMessage");
  });

  it("should document opt-in trajectory workflow in docs/api.md (issue #80, criterion #7)", () => {
    const api = readFile(join(rootDir, "docs", "api.md"));
    expect(api).toContain("wiki_capture_trajectory");
    expect(api).toContain("wiki_retro");
    expect(api).toContain("wiki_observe");
    expect(api).toContain("opt-in");
    expect(api).toContain("off by default");
    expect(api).toContain("working-memory");
  });

  it("has no obsolete YAML or wikilink scanners", () => {
    const utils = readFile(join(rootDir, "extensions/llm-wiki/lib/utils.ts"));
    expect(utils).not.toContain("parseFrontmatter(");
    expect(utils).not.toContain("findWikiPages(");
    expect(utils).not.toContain("extractWikilinks(");
  });

  it("routes every authoritative writer through strict vault validation", () => {
    const files = [
      "source-packet.ts",
      "ingest-worker.ts",
      "observation.ts",
      "retro.ts",
      "trajectory.ts",
      "metadata.ts",
      "embeddings.ts",
    ];
    for (const file of files) {
      const source = readFile(join(rootDir, "extensions/llm-wiki/lib", file));
      expect(source, file).toContain("assertWritableVault");
    }
  });

  it("keeps Foundation free of later-phase operation surfaces", () => {
    const source = [join(rootDir, "extensions"), join(rootDir, "mcp")]
      .flatMap(readProductionFiles)
      .join("\n");
    for (const forbidden of [
      "wiki_okf_import",
      "wiki_okf_export",
      "wiki_okf_migrate",
      "transaction journal",
      "trust factor",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("should have a comprehensive README with install instructions", () => {
    const readme = readFile(join(rootDir, "README.md"));
    expect(readme).toContain("@zosmaai/pi-llm-wiki");
    expect(readme).toContain("pi install npm:@zosmaai/pi-llm-wiki");
    expect(readme).toContain("Karpathy");
    expect(readme).toContain("Obsidian");
  });

  it("documents the runnable MCP entry point in every README (issue #129)", () => {
    const pkg = JSON.parse(readFile(join(rootDir, "package.json")));
    // The manifest command is the one test/mcp-package.test.ts actually spawns,
    // so tying the docs to it keeps every README pointed at runnable JavaScript
    // rather than at mcp/, which ships only TypeScript.
    const entry = (pkg.pi.mcpservers["llm-wiki"] as string).replace(/^node\s+\.\//, "");
    expect(entry).toBe("dist/mcp/index.js");

    const documented = /@zosmaai\/pi-llm-wiki\/\S*mcp\/index\.js/g;
    const english = readFile(join(rootDir, "README.md"));
    expect([...english.matchAll(documented)].length).toBeGreaterThan(0);

    const readmes = readdirSync(rootDir).filter((name) => /^README(\.[a-z]{2})?\.md$/.test(name));
    for (const name of readmes) {
      for (const [path] of readFile(join(rootDir, name)).matchAll(documented)) {
        expect(path, `${name} documents a path that ships no JavaScript`).toContain(entry);
      }
    }
  });
});

// ─── SKILL.md Frontmatter Validation ────────────────────

describe("skill frontmatter validation", () => {
  const skillPath = join(rootDir, "skills", "llm-wiki", "SKILL.md");

  it("should have name matching directory, lowercase with hyphens only", () => {
    const content = readFile(skillPath);
    const match = content.match(/^---\n([\s\S]*?)\n---/) as RegExpMatchArray | null;
    expect(match).not.toBeNull();
    const frontmatter = match![1];
    expect(frontmatter).toContain("name: llm-wiki");

    const nameMatch = frontmatter.match(/name:\s*(\S+)/);
    expect(nameMatch).not.toBeNull();
    const name = nameMatch![1];
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toContain("--");
    expect(name).not.toMatch(/^-|-$/);
  });

  it("should contain the agent working-memory decision table (issue #80, criterion #7)", () => {
    const content = readFile(skillPath);
    expect(content).toContain("When to use which memory tool");
    expect(content).toContain("wiki_capture_trajectory");
    expect(content).toContain("wiki_retro");
    expect(content).toContain("wiki_observe");
    expect(content).toContain("replayable");
    expect(content).toContain("prose **insight");
  });

  it("should have a description under 1024 characters", () => {
    const content = readFile(skillPath);
    const match = content.match(/^---\n([\s\S]*?)\n---/) as RegExpMatchArray | null;
    expect(match).not.toBeNull();
    const descMatch = match![1].match(/description:\s*(.+)/);
    expect(descMatch).not.toBeNull();
    expect(descMatch![1].length).toBeLessThanOrEqual(1024);
  });
});
