import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import {
  BENCHMARK_VERSION,
  type BenchmarkPage,
  benchmarkPages,
  benchmarkQueries,
} from "./fixtures/retrieval-benchmark/fixture.js";
import { rootDir } from "./helpers.js";
import { type BenchmarkRun, evaluateBenchmark } from "./helpers/retrieval-metrics.js";

const baselinePath = join(
  rootDir,
  "docs",
  "superpowers",
  "benchmarks",
  "phase-1-current-baseline.json",
);
const tempRoot = mkdtempSync(join(tmpdir(), "pi-llm-wiki-retrieval-"));

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

function renderPage(page: BenchmarkPage): string {
  const metadata = [
    "---",
    `type: ${page.type}`,
    `title: ${JSON.stringify(page.title)}`,
    `status: ${page.status ?? "stable"}`,
    ...(page.aliases ? [`aliases: ${JSON.stringify(page.aliases)}`] : []),
    ...(page.tags ? [`tags: ${JSON.stringify(page.tags)}`] : []),
    "---",
    "",
  ];
  return `${metadata.join("\n")}${page.body}\n`;
}

function createBenchmarkVault(): ReturnType<typeof getVaultPaths> {
  const paths = getVaultPaths(tempRoot);
  ensureVaultStructure(paths);
  writeFileSync(
    join(paths.dotWiki, "config.json"),
    `${JSON.stringify({ name: "Retrieval Benchmark", knowledge_format: "legacy" }, null, 2)}\n`,
  );
  for (const page of benchmarkPages) {
    const path = join(paths.wiki, `${page.id}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderPage(page));
  }
  const rebuilt = rebuildMetadata(paths);
  expect(rebuilt.ok, JSON.stringify(rebuilt.diagnostics, null, 2)).toBe(true);
  return paths;
}

function currentPackageContract(): { node: string; qmd: string } {
  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
    engines: { node: string };
    dependencies: Record<string, string>;
  };
  return { node: pkg.engines.node, qmd: pkg.dependencies["@tobilu/qmd"] };
}

describe("current heuristic retrieval benchmark", () => {
  it("matches the committed deterministic Phase 1 baseline", () => {
    const paths = createBenchmarkVault();
    const runs: BenchmarkRun[] = benchmarkQueries.map((query) => ({
      queryId: query.id,
      rankedPageIds: searchWiki(paths, query.text, 20, 0).map((result) => result.id),
      autoPageIds: searchWiki(paths, query.text, 3, 5).map((result) => result.id),
    }));
    const report = {
      schema: 1,
      fixtureVersion: BENCHMARK_VERSION,
      engine: "current-heuristic",
      productionRecallChanged: false,
      packageContract: currentPackageContract(),
      queryCounts: {
        all: benchmarkQueries.length,
        train: benchmarkQueries.filter((query) => query.split === "train").length,
        heldout: benchmarkQueries.filter((query) => query.split === "heldout").length,
      },
      metrics: evaluateBenchmark(benchmarkQueries, runs),
    };

    if (process.env.UPDATE_RETRIEVAL_BASELINE === "1") {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
    }

    expect(
      existsSync(baselinePath),
      `Run pnpm benchmark:retrieval:update to create ${baselinePath}`,
    ).toBe(true);
    expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toEqual(report);
  });
});
