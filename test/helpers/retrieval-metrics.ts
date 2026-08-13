import type {
  BenchmarkJudgment,
  BenchmarkQuery,
  BenchmarkSplit,
} from "../fixtures/retrieval-benchmark/fixture.js";

export interface BenchmarkRun {
  queryId: string;
  rankedPageIds: string[];
  autoPageIds: string[];
}

export interface RetrievalMetrics {
  queryCount: number;
  judgedQueryCount: number;
  candidateRecall20: number;
  mrr: number;
  ndcg5: number;
  ndcg10: number;
  canonicalAt3: number;
  evidenceRecall20: number;
  contradictionCoverage: number;
  autoFalsePositiveRate: number;
}

export interface RetrievalMetricReport {
  all: RetrievalMetrics;
  train: RetrievalMetrics;
  heldout: RetrievalMetrics;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function recallAt(rankedIds: string[], relevantIds: Set<string>, k: number): number {
  if (relevantIds.size === 0) return 0;
  const found = new Set(rankedIds.slice(0, k).filter((id) => relevantIds.has(id)));
  return found.size / relevantIds.size;
}

export function reciprocalRank(rankedIds: string[], relevantIds: Set<string>): number {
  const index = rankedIds.findIndex((id) => relevantIds.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

export function ndcgAt(rankedIds: string[], gradesById: Map<string, number>, k: number): number {
  const actual = rankedIds.slice(0, k).map((id) => gradesById.get(id) ?? 0);
  const ideal = [...gradesById.values()].sort((a, b) => b - a).slice(0, k);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(actual) / idealDcg;
}

function idsForRole(judgments: BenchmarkJudgment[], role?: BenchmarkJudgment["role"]): Set<string> {
  return new Set(
    judgments
      .filter((judgment) => judgment.grade > 0 && (role === undefined || judgment.role === role))
      .map((judgment) => judgment.pageId),
  );
}

function evaluateSlice(
  queries: BenchmarkQuery[],
  runById: Map<string, BenchmarkRun>,
): RetrievalMetrics {
  const judged = queries.filter((query) => query.judgments.length > 0);
  const canonical = queries.filter((query) => idsForRole(query.judgments, "canonical").size > 0);
  const evidence = queries.filter((query) => idsForRole(query.judgments, "evidence").size > 0);
  const conflicts = queries.filter((query) => (query.expectedConflicts?.length ?? 0) > 0);
  const negatives = queries.filter((query) => query.autoExpectation === "none");

  const rankedFor = (query: BenchmarkQuery) => runById.get(query.id)?.rankedPageIds ?? [];
  const autoFor = (query: BenchmarkQuery) => runById.get(query.id)?.autoPageIds ?? [];

  return {
    queryCount: queries.length,
    judgedQueryCount: judged.length,
    candidateRecall20: round(
      mean(judged.map((query) => recallAt(rankedFor(query), idsForRole(query.judgments), 20))),
    ),
    mrr: round(
      mean(judged.map((query) => reciprocalRank(rankedFor(query), idsForRole(query.judgments)))),
    ),
    ndcg5: round(
      mean(
        judged.map((query) =>
          ndcgAt(
            rankedFor(query),
            new Map(query.judgments.map((judgment) => [judgment.pageId, judgment.grade])),
            5,
          ),
        ),
      ),
    ),
    ndcg10: round(
      mean(
        judged.map((query) =>
          ndcgAt(
            rankedFor(query),
            new Map(query.judgments.map((judgment) => [judgment.pageId, judgment.grade])),
            10,
          ),
        ),
      ),
    ),
    canonicalAt3: round(
      mean(
        canonical.map((query) => {
          const relevant = idsForRole(query.judgments, "canonical");
          return rankedFor(query)
            .slice(0, 3)
            .some((id) => relevant.has(id))
            ? 1
            : 0;
        }),
      ),
    ),
    evidenceRecall20: round(
      mean(
        evidence.map((query) =>
          recallAt(rankedFor(query), idsForRole(query.judgments, "evidence"), 20),
        ),
      ),
    ),
    contradictionCoverage: round(
      mean(
        conflicts.map((query) => {
          const found = new Set(rankedFor(query).slice(0, 20));
          return query.expectedConflicts!.every((id) => found.has(id)) ? 1 : 0;
        }),
      ),
    ),
    autoFalsePositiveRate: round(
      mean(negatives.map((query) => (autoFor(query).length > 0 ? 1 : 0))),
    ),
  };
}

export function evaluateBenchmark(
  queries: BenchmarkQuery[],
  runs: BenchmarkRun[],
): RetrievalMetricReport {
  const runById = new Map(runs.map((run) => [run.queryId, run]));
  const bySplit = (split: BenchmarkSplit) => queries.filter((query) => query.split === split);
  return {
    all: evaluateSlice(queries, runById),
    train: evaluateSlice(bySplit("train"), runById),
    heldout: evaluateSlice(bySplit("heldout"), runById),
  };
}
