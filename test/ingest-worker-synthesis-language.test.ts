import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INGEST_SYSTEM } from "../extensions/llm-wiki/lib/ingest-worker.js";
import { type VaultPaths, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

// We test the language instruction is appended to the system prompt by
// spying on runSubAgent and inspecting what systemPrompt it receives.
describe("runIngestSynthesis language injection", () => {
  let testDir: string;
  let paths: VaultPaths;

  function createTestVault(): string {
    const dir = join(tmpdir(), `llm-wiki-ingest-test-${Date.now()}`);
    mkdirSync(join(dir, ".llm-wiki", "wiki", "sources"), { recursive: true });
    mkdirSync(join(dir, ".llm-wiki", "raw", "sources"), { recursive: true });
    mkdirSync(join(dir, ".llm-wiki", "embeddings"), { recursive: true });
    return dir;
  }

  beforeEach(() => {
    testDir = createTestVault();
    paths = getVaultPaths(testDir);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("appends language instruction when synthesisLanguage is set", async () => {
    const { runIngestSynthesis } = await import("../extensions/llm-wiki/lib/ingest-worker.js");

    const spy = vi
      .spyOn(await import("../extensions/llm-wiki/lib/subagent.js"), "runSubAgent")
      .mockResolvedValue();

    // Mock source
    const sourceId = "SRC-2026-08-07-001";
    const manifest = { id: sourceId, title: "Test Source", format: "markdown" };
    const extracted = "This is test content for synthesis.";

    await runIngestSynthesis({
      // @ts-expect-error — minimal mock model for this test
      model: { name: "test", provider: "test" },
      apiKey: "test-key",
      paths,
      sourceId,
      manifest,
      extracted,
      synthesisLanguage: "ru",
    });

    expect(spy).toHaveBeenCalled();
    const callArgs = spy.mock.calls[0][0];
    expect(callArgs.systemPrompt).toContain("in ru");
    expect(callArgs.systemPrompt).toContain("concept/entity names");
    expect(callArgs.systemPrompt).toContain("verbatim quotations");

    spy.mockRestore();
  });

  it("uses exact INGEST_SYSTEM when synthesisLanguage is unset", async () => {
    const { runIngestSynthesis } = await import("../extensions/llm-wiki/lib/ingest-worker.js");

    const spy = vi
      .spyOn(await import("../extensions/llm-wiki/lib/subagent.js"), "runSubAgent")
      .mockResolvedValue();

    const sourceId = "SRC-2026-08-07-002";
    const manifest = { id: sourceId, title: "Test Source", format: "markdown" };
    const extracted = "This is test content for synthesis.";

    await runIngestSynthesis({
      // @ts-expect-error — minimal mock model for this test
      model: { name: "test", provider: "test" },
      apiKey: "test-key",
      paths,
      sourceId,
      manifest,
      extracted,
      // synthesisLanguage not set
    });

    expect(spy).toHaveBeenCalled();
    const callArgs = spy.mock.calls[0][0];
    expect(callArgs.systemPrompt).toBe(INGEST_SYSTEM);

    spy.mockRestore();
  });
});
