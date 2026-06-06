import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SynthesisData,
  buildIngestedSourcePage,
  commitSynthesis,
} from "../extensions/llm-wiki/lib/ingest-worker.js";
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
    expect(page).toContain("[[self-attention]]");
    expect(page).toContain("[[google-brain]]");
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
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("writes the source page (ingested) and creates entity/concept pages", () => {
    const paths = getVaultPaths(wikiDir);
    const res = commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");

    const sourcePage = readFileSync(join(paths.wiki, "sources", "SRC-001.md"), "utf-8");
    expect(sourcePage).toContain("status: ingested");

    expect(res.entitiesCreated.sort()).toEqual(["ashish-vaswani", "google-brain"]);
    expect(res.conceptsCreated.sort()).toEqual(["self-attention", "transformer"]);
    expect(existsSync(join(paths.wiki, "entities", "google-brain.md"))).toBe(true);
    expect(existsSync(join(paths.wiki, "concepts", "transformer.md"))).toBe(true);
    expect(res.contradictions).toBe(1);
  });

  it("links (does not overwrite) pages that already exist", () => {
    const paths = getVaultPaths(wikiDir);
    const existing = join(paths.wiki, "entities", "google-brain.md");
    mkdirSync(join(paths.wiki, "entities"), { recursive: true });
    writeFileSync(existing, "PRE-EXISTING CONTENT", "utf-8");

    const res = commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");

    expect(res.entitiesLinked).toContain("google-brain");
    expect(res.entitiesCreated).not.toContain("google-brain");
    expect(readFileSync(existing, "utf-8")).toBe("PRE-EXISTING CONTENT");
  });

  it("appends an ingest event and rebuilds registry on metadata rebuild", () => {
    const paths = getVaultPaths(wikiDir);
    commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");
    const events = readFileSync(join(paths.meta, "events.jsonl"), "utf-8");
    expect(events).toContain('"kind":"ingest"');
    expect(events).toContain('"source_id":"SRC-001"');
    expect(events).toContain('"background":true');
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
    expect(res.entitiesCreated).toEqual([]);
  });
});
