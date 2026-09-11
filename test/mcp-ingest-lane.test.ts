import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadTaskConfig } from "../extensions/llm-wiki/lib/task-config.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { resolveLaneModel } from "../mcp/model-lane.js";
import { ingestOperation } from "../mcp/operations.js";

const FAUX_PROVIDER = "faux";
const FAUX_MODEL = "faux-test";

/** pi-ai's test-double provider handle; the factory must return `.provider`. */
function fauxFactory(): unknown {
  return fauxProvider({
    provider: FAUX_PROVIDER,
    models: [{ id: FAUX_MODEL }],
  }).provider;
}

let root: string;
beforeEach(() => {
  root = join(
    import.meta.dirname,
    "..",
    "tmp",
    `mcp-lane-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({
      "llm-wiki": {
        mode: "personal",
        taskModel: { provider: FAUX_PROVIDER, id: FAUX_MODEL },
        taskModelApiKey: "test-key",
        taskModelBaseUrl: "http://localhost",
      },
    }),
  );
  ensureVaultStructure(getVaultPaths(root));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

it("resolveLaneModel resolves a model from the config-first lane (faux provider)", async () => {
  const res = await resolveLaneModel(loadTaskConfig(root), fauxFactory);
  expect(res.ok).toBe(true);
});

it("resolveLaneModel degrades gracefully when no model is configured", async () => {
  const cfg = loadTaskConfig(root);
  const bare = { ...cfg, taskModel: undefined };
  const res = await resolveLaneModel(bare, fauxFactory);
  expect(res.ok).toBe(false);
});

it("ingestOperation reports when the vault has no raw packets at all", async () => {
  const paths = getVaultPaths(root);
  rmSync(paths.rawSources, { recursive: true, force: true });
  const res = await ingestOperation(paths, {});
  expect(res.isError).toBe(true);
  expect(res.report).toContain("No raw/sources/ directory");
});

it("ingestOperation reports when every source is already ingested", async () => {
  const paths = getVaultPaths(root);
  const res = await ingestOperation(paths, {});
  expect(res.isError).toBeUndefined();
  expect(res.report).toContain("All sources ingested");
});

it("ingestOperation falls back to self-synthesize instructions when the lane has no model", async () => {
  // Rewrite settings WITHOUT taskModel so the lane degrades.
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ "llm-wiki": { mode: "personal" } }),
  );
  const paths = getVaultPaths(root);
  mkdirSync(join(paths.rawSources, "SRC-2026-09-11-001"), { recursive: true });
  writeFileSync(join(paths.rawSources, "SRC-2026-09-11-001", "extracted.md"), "hello world");
  writeFileSync(
    join(paths.rawSources, "SRC-2026-09-11-001", "manifest.json"),
    JSON.stringify({
      kind: "text",
      title: "Lane Test",
      captured_at: "2026-09-11T00:00:00Z",
    }),
  );
  const res = await ingestOperation(paths, {});
  expect(res.isError).toBeUndefined();
  expect(res.report).toContain("synthesize these sources yourself");
  expect(res.report).toContain("SRC-2026-09-11-001");
});
