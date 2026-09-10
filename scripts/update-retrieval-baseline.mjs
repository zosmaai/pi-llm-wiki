#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitest, "run", "test/retrieval-benchmark.test.ts", "--reporter=verbose"],
  {
    cwd: root,
    env: { ...process.env, UPDATE_RETRIEVAL_BASELINE: "1" },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
