import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  embedPages,
  reindexEmbeddings,
  writeEmbeddingStore,
} from "../extensions/llm-wiki/lib/embeddings.js";
import { commitSynthesis } from "../extensions/llm-wiki/lib/ingest-worker.js";
import { appendEvent } from "../extensions/llm-wiki/lib/metadata.js";
import { registerWikiObserve, saveObservation } from "../extensions/llm-wiki/lib/observation.js";
import { registerWikiRetro, saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { captureText } from "../extensions/llm-wiki/lib/source-packet.js";
import {
  registerWikiCaptureSource,
  registerWikiEnsurePage,
  registerWikiIngest,
  registerWikiLint,
  registerWikiLogEvent,
  registerWikiRebuildMeta,
  registerWikiReindexEmbeddings,
} from "../extensions/llm-wiki/lib/tools.js";
import {
  captureTrajectory,
  registerWikiCaptureTrajectory,
} from "../extensions/llm-wiki/lib/trajectory.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { VaultWriteError } from "../extensions/llm-wiki/lib/vault-format.js";

const roots: string[] = [];
const originalWikiHome = process.env.WIKI_HOME;
afterEach(() => {
  if (originalWikiHome === undefined) Reflect.deleteProperty(process.env, "WIKI_HOME");
  else process.env.WIKI_HOME = originalWikiHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invalidVault(config = "{broken") {
  const root = join(import.meta.dirname, "..", "tmp", `mutation-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), config);
  return paths;
}

function tree(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true }).map(String).sort();
}

type TestTool = {
  execute: (...args: unknown[]) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
};
describe("authoritative mutation guards", () => {
  it("blocks every shared authoritative writer before changing the vault", async () => {
    const operations: Array<[string, (paths: ReturnType<typeof invalidVault>) => unknown]> = [
      ["capture", (paths) => captureText(paths, "body", "title")],
      [
        "observe",
        (paths) => saveObservation(paths, { title: "x", content: "y", relevance: "low" }),
      ],
      ["retro", (paths) => saveInsight(paths, "safe-slug", "title", "body")],
      ["trajectory", (paths) => captureTrajectory(paths, { steps: [{ role: "user", text: "x" }] })],
      ["event", (paths) => appendEvent(paths, { kind: "manual" })],
    ];

    for (const [name, operation] of operations) {
      const paths = invalidVault();
      const before = tree(paths.dotWiki);
      expect(() => operation(paths), name).toThrow(VaultWriteError);
      expect(tree(paths.dotWiki), name).toEqual(before);
    }

    const ingestPaths = invalidVault();
    const ingestBefore = tree(ingestPaths.dotWiki);
    const ingest = commitSynthesis(
      ingestPaths,
      "SRC-1",
      { id: "SRC-1", title: "Source" },
      { summary: "s", key_takeaways: [], entities: [], concepts: [] },
    );
    expect(ingest.ok).toBe(false);
    expect(tree(ingestPaths.dotWiki)).toEqual(ingestBefore);

    const paths = invalidVault();
    const before = tree(paths.dotWiki);
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const embedder = { model: "test", embed };
    await expect(embedPages(paths, ["concepts/x"], embedder)).rejects.toBeInstanceOf(
      VaultWriteError,
    );
    await expect(reindexEmbeddings(paths, embedder)).rejects.toBeInstanceOf(VaultWriteError);
    expect(() => writeEmbeddingStore(paths, { version: "1.0", entries: {} })).toThrow(
      VaultWriteError,
    );
    expect(tree(paths.dotWiki)).toEqual(before);
  });

  it("blocks every mutating Pi tool adapter before dispatch or write", async () => {
    const cases: Array<[string, (pi: ExtensionAPI) => void, Record<string, unknown>]> = [
      ["capture", (pi) => registerWikiCaptureSource(pi), { text: "body", title: "title" }],
      ["ingest", (pi) => registerWikiIngest(pi), { background: false }],
      ["ensure", (pi) => registerWikiEnsurePage(pi), { type: "concept", title: "Title" }],
      ["lint", (pi) => registerWikiLint(pi), { auto_fix: false }],
      ["rebuild", (pi) => registerWikiRebuildMeta(pi), {}],
      ["embeddings", (pi) => registerWikiReindexEmbeddings(pi), { force: false }],
      ["event", (pi) => registerWikiLogEvent(pi), { kind: "manual" }],
      ["observe", (pi) => registerWikiObserve(pi), { title: "x", content: "y", relevance: "low" }],
      ["retro", (pi) => registerWikiRetro(pi), { slug: "safe", title: "x", body: "y" }],
      [
        "trajectory",
        (pi) => registerWikiCaptureTrajectory(pi),
        { steps: [{ role: "user", text: "x" }] },
      ],
    ];

    for (const [name, register, params] of cases) {
      const paths = invalidVault();
      process.env.WIKI_HOME = paths.root;
      let tool: TestTool | undefined;
      register({
        registerTool: (definition: unknown) => {
          tool = definition as TestTool;
        },
      } as unknown as ExtensionAPI);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      const before = tree(paths.dotWiki);
      const result = await tool.execute("test", params, undefined, undefined, {
        cwd: paths.root,
        hasUI: false,
        ui: { notify: () => {} },
      });
      expect(result.isError, name).toBe(true);
      expect(tree(paths.dotWiki), name).toEqual(before);
    }
  });
});
