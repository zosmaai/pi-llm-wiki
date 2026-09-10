# Retrieval Benchmark

The Phase 1 benchmark records current heuristic recall quality before QMD powers production retrieval.

## Corpus

`test/fixtures/retrieval-benchmark/fixture.ts` contains 22 sanitized Markdown pages and 60 graded queries:

- 45 train queries
- 15 immutable held-out queries
- exact lookup, aliases, paraphrase, vague recollection, concepts, graph scope, evidence, time, conflicts, conclusions, synthesis, and unrelated negatives
- English, Chinese, and mixed-language examples

The fixture must not contain raw home paths, email addresses, credentials, customer identifiers, or copied private notes. Sanitize representative phrasing before committing it.

The CJK query `什么是卡片盒笔记法` (zettelkasten-concept #4) is an intentional guaranteed miss for the current heuristic engine: the page body is English-only, so lexical score is zero by construction. Do not reword the page to make it pass; it exists to prove that only CJK-aware lexical handling (QMD's normalized FTS) can recover it.

## Judgments

Grades are:

- `3`: directly answers the query
- `2`: useful supporting evidence or secondary answer
- `1`: relevant context

Roles are `canonical` or `evidence`. Contradiction queries list every claim that must appear together.

## Metrics

The report records candidate Recall@20, MRR, nDCG@5, nDCG@10, canonical@3, evidence Recall@20, contradiction coverage, and automatic-recall false-positive rate. Scores are computed from ranked page IDs, never raw engine scores.

## Commands

Verify the committed baseline:

```bash
pnpm benchmark:retrieval
```

Regenerate after an intentional fixture or baseline-engine change:

```bash
pnpm benchmark:retrieval:update
pnpm benchmark:retrieval
```

Never hand-edit `docs/superpowers/benchmarks/phase-1-current-baseline.json`. Every update must explain why the benchmark or baseline engine changed. Later phases may tune against `train`, but must not inspect or alter held-out judgments while tuning.