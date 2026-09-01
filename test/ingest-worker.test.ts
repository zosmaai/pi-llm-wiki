import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIngestedSourcePage,
  commitSynthesis,
  type SynthesisData,
} from "../extensions/llm-wiki/lib/ingest-worker.js";
import { parseKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const MANIFEST = {
  id: "SRC-001",
  title: "Attention Is All You Need",
  format: "pdf",
  url: "https://example.com/paper",
  captured: "2026-06-01",
};

const DATA: SynthesisData = {
  summary:
    "A paper introducing the Transformer architecture.\n\nIt replaces recurrence with attention.",
  key_takeaways: ["Self-attention scales well", "No recurrence needed"],
  entities: [
    { title: "Google Brain", description: "Research lab" },
    { title: "Ashish Vaswani", description: "Lead author" },
  ],
  concepts: [
    { title: "Self-Attention", definition: "Tokens attend to each other" },
    { title: "Transformer", definition: "Attention-based seq model" },
  ],
  quotes: [{ text: "Attention is all you need", attribution: "Vaswani et al." }],
  contradictions: ["Earlier work claimed recurrence was essential"],
};

describe("buildIngestedSourcePage", () => {
  it("produces a non-skeleton page with all sections filled", () => {
    const page = buildIngestedSourcePage(MANIFEST, DATA, "2026-06-06");
    expect(page).toContain("status: ingested");
    expect(page).not.toContain("[LLM:");
    expect(page).toContain("# Attention Is All You Need");
    expect(page).toContain("Transformer architecture");
    expect(page).toContain("- Self-attention scales well");
    expect(page).toContain("[Self-Attention](/concepts/self-attention.md)");
    expect(page).toContain("[Google Brain](/entities/google-brain.md)");
    expect(page).toContain("> Attention is all you need — Vaswani et al.");
    expect(page).toContain("⚠️ **Contradiction**");
    expect(page).toContain("[https://example.com/paper]");
  });

  it("degrades gracefully with empty arrays", () => {
    const page = buildIngestedSourcePage(
      { id: "SRC-X", title: "Empty" },
      { summary: "s", key_takeaways: [], entities: [], concepts: [] },
      "2026-06-06",
    );
    expect(page).toContain("status: ingested");
    expect(page).toContain("- [None]");
    expect(page).not.toContain("## Contradictions");
  });
});

describe("commitSynthesis", () => {
  let tmpDir: string;
  let wikiDir: string;

  beforeEach(() => {
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `ingest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    wikiDir = join(tmpDir, "vault");
    mkdirSync(wikiDir, { recursive: true });
    ensureVaultStructure(getVaultPaths(wikiDir));
    writeFileSync(
      join(getVaultPaths(wikiDir).dotWiki, "config.json"),
      JSON.stringify({ name: "Ingest test" }),
    );
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("writes the source page (ingested) and creates entity/concept pages", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sourcePage = readFileSync(join(paths.wiki, "sources", "SRC-001.md"), "utf-8");
    expect(sourcePage).toContain("status: ingested");

    expect(res.entitiesCreated.sort()).toEqual(["ashish-vaswani", "google-brain"]);
    expect(res.conceptsCreated.sort()).toEqual(["self-attention", "transformer"]);
    expect(existsSync(join(paths.wiki, "entities", "google-brain.md"))).toBe(true);
    expect(existsSync(join(paths.wiki, "concepts", "transformer.md"))).toBe(true);
    expect(sourcePage).toContain("`raw/sources/SRC-001/extracted.md`");
    expect(sourcePage).toContain("`raw/sources/SRC-001/manifest.json`");
    expect(sourcePage).not.toContain("](../raw/");

    const projection = rebuildMetadata(paths);
    expect(
      projection.diagnostics.filter((diagnostic) =>
        ["link_unresolved", "link_path_escape"].includes(diagnostic.code),
      ),
    ).toEqual([]);
    expect(res.contradictions).toBe(1);
  });

  it("creates entity/concept pages without unfilled placeholder sections (issue #170)", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const entity = readFileSync(join(paths.wiki, "entities", "google-brain.md"), "utf-8");
    const concept = readFileSync(join(paths.wiki, "concepts", "transformer.md"), "utf-8");
    // No unfilled placeholder sections left behind.
    expect(entity).not.toContain("[Key facts]");
    expect(entity).not.toContain("## Overview");
    expect(concept).not.toContain("[Clear explanation]");
    expect(concept).not.toContain("## Definition");
    // The one-liner still leads the page, exactly once.
    expect(entity).toContain("Research lab");
    expect(concept).toContain("Attention-based seq model");
    // Source link preserved.
    expect(entity).toContain("[SRC-001](/sources/SRC-001.md)");
    expect(concept).toContain("[SRC-001](/sources/SRC-001.md)");
  });

  it("links (does not overwrite) pages that already exist", () => {
    const paths = getVaultPaths(wikiDir);
    const existing = join(paths.wiki, "entities", "google-brain.md");
    mkdirSync(join(paths.wiki, "entities"), { recursive: true });
    writeFileSync(existing, "PRE-EXISTING CONTENT", "utf-8");

    const res = commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entitiesLinked).toContain("google-brain");
    expect(res.entitiesCreated).not.toContain("google-brain");
    expect(readFileSync(existing, "utf-8")).toBe("PRE-EXISTING CONTENT");
  });

  it("uses stable canonical slugs when linking existing pages", () => {
    const paths = getVaultPaths(wikiDir);
    writeFileSync(join(paths.wiki, "entities", "①.md"), "NUMBERED ENTITY", "utf-8");
    writeFileSync(join(paths.wiki, "concepts", "abc.md"), "ASCII CONCEPT", "utf-8");

    const res = commitSynthesis(
      paths,
      "SRC-001",
      MANIFEST,
      {
        summary: "s",
        key_takeaways: [],
        entities: [{ title: "①", description: "Numbered entity" }],
        concepts: [{ title: "ＡＢＣ", definition: "Full-width concept" }],
      },
      "2026-06-06",
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entitiesLinked).toEqual(["①"]);
    expect(res.conceptsLinked).toEqual(["abc"]);
    expect(res.entitiesCreated).toEqual([]);
    expect(res.conceptsCreated).toEqual([]);
    expect(existsSync(join(paths.wiki, "entities", "1.md"))).toBe(false);
  });

  it("appends an ingest event and rebuilds registry on metadata rebuild", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");
    expect(res.ok).toBe(true);
    const events = readFileSync(join(paths.meta, "events.jsonl"), "utf-8");
    expect(events).toContain('"kind":"ingest"');
    expect(events).toContain('"source_id":"SRC-001"');
    expect(events).toContain('"background":true');
  });

  it.each([
    ["scalar", "sources: sources/SRC-legacy"],
    ["list", "sources: [sources/SRC-a, sources/SRC-b]"],
  ])("patches an existing %s-source page without migration or field loss", (_label, sources) => {
    const paths = getVaultPaths(wikiDir);
    const page = join(paths.wiki, "sources", "SRC-001.md");
    mkdirSync(join(paths.wiki, "sources"), { recursive: true });
    writeFileSync(
      page,
      [
        "---",
        "type: source",
        "title: Original title",
        sources,
        "producer_data:",
        "  nested:",
        "    keep: true",
        "status: skeleton",
        "---",
        "",
        "Old body.",
        "",
      ].join("\n"),
    );

    const before = parseKnowledgeDocument(readFileSync(page, "utf8"), "sources/SRC-001.md");
    expect(before.ok).toBe(true);
    const result = commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");
    expect(result.ok).toBe(true);
    const after = parseKnowledgeDocument(readFileSync(page, "utf8"), "sources/SRC-001.md");
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.document.sources).toEqual(before.document.sources);
    expect(after.document.extensions.producer_data).toEqual(
      before.document.extensions.producer_data,
    );
    expect(after.document.frontmatter.title).toBe("Original title");
    expect(after.document.frontmatter.status).toBe("ingested");
    expect(after.document.frontmatter.updated).toBe("2026-06-06");
  });

  it("skips entries with empty slugs without throwing", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(
      paths,
      "SRC-002",
      { id: "SRC-002", title: "T" },
      {
        summary: "s",
        key_takeaways: [],
        entities: [{ title: "!!!", description: "junk" }],
        concepts: [],
      },
      "2026-06-06",
    );
    // Non-alphanumeric titles fall back to "untitled" slug.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entitiesCreated).toEqual(["untitled"]);
  });

  describe("commitSynthesis wikilink gate", () => {
    function makeData(summary: string): SynthesisData {
      return {
        summary,
        key_takeaways: ["a"],
        entities: [{ title: "Alice", description: "A person." }],
        concepts: [{ title: "Transformer", definition: "An architecture." }],
      };
    }

    it("strict blocks the write and returns ok:false on an unresolved link", () => {
      const paths = getVaultPaths(wikiDir);
      const res = commitSynthesis(
        paths,
        "SRC-001",
        MANIFEST,
        makeData("See [[ghost-page]] for details."),
        "2026-06-06",
        undefined,
        "strict",
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.diagnostics.map((d) => d.code)).toContain("link_unresolved");
      }
      // Nothing was written:
      expect(existsSync(join(paths.wiki, "sources", "SRC-001.md"))).toBe(false);
      expect(existsSync(join(paths.wiki, "entities", "alice.md"))).toBe(false);
    });

    it("warn writes and attaches wikilinkDiagnostics", () => {
      const paths = getVaultPaths(wikiDir);
      const res = commitSynthesis(
        paths,
        "SRC-001",
        MANIFEST,
        makeData("See [[ghost-page]] for details."),
        "2026-06-06",
        undefined,
        "warn",
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.wikilinkDiagnostics?.map((d) => d.code)).toContain("link_unresolved");
      }
      expect(existsSync(join(paths.wiki, "sources", "SRC-001.md"))).toBe(true);
    });

    it("normalize rewrites resolvable links to canonical ids in the written page", () => {
      const paths = getVaultPaths(wikiDir);
      // [[transformer]] resolves because makeData() creates a "Transformer" concept
      // in the SAME commit — buildIngestAuditIndex adds concepts/transformer to the
      // index, so no pre-existing page is needed (this also proves same-batch links resolve).
      const res = commitSynthesis(
        paths,
        "SRC-001",
        MANIFEST,
        makeData("The [[transformer|T]] changed everything."),
        "2026-06-06",
        undefined,
        "normalize",
      );
      expect(res.ok).toBe(true);
      const written = readFileSync(join(paths.wiki, "sources", "SRC-001.md"), "utf-8");
      expect(written).toContain("[[concepts/transformer\\|T]]");
    });

    it("off is a no-op (writes verbatim, no diagnostics)", () => {
      const paths = getVaultPaths(wikiDir);
      const res = commitSynthesis(
        paths,
        "SRC-001",
        MANIFEST,
        makeData("See [[ghost-page]] for details."),
        "2026-06-06",
        undefined,
        "off",
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.wikilinkDiagnostics).toBeUndefined();
      const written = readFileSync(join(paths.wiki, "sources", "SRC-001.md"), "utf-8");
      expect(written).toContain("[[ghost-page]]");
    });

    it("defaults to warn when mode is omitted", () => {
      const paths = getVaultPaths(wikiDir);
      const res = commitSynthesis(
        paths,
        "SRC-001",
        MANIFEST,
        makeData("See [[ghost-page]] for details."),
        "2026-06-06",
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.wikilinkDiagnostics?.length).toBeGreaterThan(0);
    });
  });
});
