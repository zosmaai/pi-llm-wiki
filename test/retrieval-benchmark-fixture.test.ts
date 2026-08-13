import { describe, expect, it } from "vitest";
import {
  BENCHMARK_VERSION,
  benchmarkPages,
  benchmarkQueries,
} from "./fixtures/retrieval-benchmark/fixture.js";

describe("retrieval benchmark fixture", () => {
  it("contains the approved versioned 60-query train/held-out corpus", () => {
    expect(BENCHMARK_VERSION).toBe(1);
    expect(benchmarkPages).toHaveLength(22);
    expect(benchmarkQueries).toHaveLength(60);
    expect(benchmarkQueries.filter((query) => query.split === "train")).toHaveLength(45);
    expect(benchmarkQueries.filter((query) => query.split === "heldout")).toHaveLength(15);
  });

  it("covers every Phase 1 query category", () => {
    expect(new Set(benchmarkQueries.map((query) => query.category))).toEqual(
      new Set([
        "exact_lookup",
        "entity_alias",
        "paraphrase",
        "vague_recollection",
        "conceptual",
        "graph_scope",
        "evidence_request",
        "temporal",
        "contradiction",
        "conclusion",
        "synthesis",
        "negative",
      ]),
    );
  });

  it("uses unique stable ids and judgments that reference fixture pages", () => {
    const pageIds = new Set(benchmarkPages.map((page) => page.id));
    const queryIds = benchmarkQueries.map((query) => query.id);
    expect(new Set(queryIds).size).toBe(queryIds.length);

    for (const query of benchmarkQueries) {
      expect(query.judgments.length > 0 || query.autoExpectation === "none").toBe(true);
      for (const judgment of query.judgments) expect(pageIds.has(judgment.pageId)).toBe(true);
      for (const pageId of query.expectedConflicts ?? []) expect(pageIds.has(pageId)).toBe(true);
    }
  });

  it("contains no raw home paths, email addresses, or token-shaped secrets", () => {
    const serialized = JSON.stringify({ benchmarkPages, benchmarkQueries });
    expect(serialized).not.toMatch(/\/home\//i);
    expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(serialized).not.toMatch(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/);
  });
});
