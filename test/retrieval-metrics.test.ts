import { describe, expect, it } from "vitest";
import type { BenchmarkQuery } from "./fixtures/retrieval-benchmark/fixture.js";
import {
  type BenchmarkRun,
  evaluateBenchmark,
  ndcgAt,
  recallAt,
  reciprocalRank,
} from "./helpers/retrieval-metrics.js";

const queries: BenchmarkQuery[] = [
  {
    id: "ranked",
    text: "ranked query",
    category: "contradiction",
    split: "train",
    judgments: [
      { pageId: "cards/a", grade: 3, role: "canonical" },
      { pageId: "sources/b", grade: 2, role: "evidence" },
    ],
    autoExpectation: "hit",
    expectedConflicts: ["cards/a", "sources/b"],
  },
  {
    id: "negative",
    text: "unrelated query",
    category: "negative",
    split: "heldout",
    judgments: [],
    autoExpectation: "none",
  },
];

const runs: BenchmarkRun[] = [
  {
    queryId: "ranked",
    rankedPageIds: ["sources/b", "cards/a", "other/x"],
    autoPageIds: ["sources/b"],
  },
  { queryId: "negative", rankedPageIds: ["other/x"], autoPageIds: ["other/x"] },
];

describe("retrieval metrics", () => {
  it("computes recall and reciprocal rank", () => {
    expect(recallAt(["x", "a", "b"], new Set(["a", "b"]), 2)).toBe(0.5);
    expect(reciprocalRank(["x", "a", "b"], new Set(["a", "b"]))).toBe(0.5);
  });

  it("computes graded nDCG independent of raw retrieval scores", () => {
    const grades = new Map([
      ["cards/a", 3],
      ["sources/b", 2],
    ]);
    expect(ndcgAt(["cards/a", "sources/b"], grades, 2)).toBe(1);
    expect(ndcgAt(["sources/b", "cards/a"], grades, 2)).toBeGreaterThan(0.8);
    expect(ndcgAt(["sources/b", "cards/a"], grades, 2)).toBeLessThan(1);
    expect(ndcgAt(["sources/b", "cards/a"], grades, 2)).toBeCloseTo(0.834, 3);
  });

  it("separates relevance, evidence, contradiction, and auto false-positive measures", () => {
    const report = evaluateBenchmark(queries, runs);
    expect(report.all.candidateRecall20).toBe(1);
    expect(report.all.mrr).toBe(1);
    expect(report.all.canonicalAt3).toBe(1);
    expect(report.all.evidenceRecall20).toBe(1);
    expect(report.all.contradictionCoverage).toBe(1);
    expect(report.all.autoFalsePositiveRate).toBe(1);
    expect(report.train.queryCount).toBe(1);
    expect(report.heldout.queryCount).toBe(1);
  });
});
