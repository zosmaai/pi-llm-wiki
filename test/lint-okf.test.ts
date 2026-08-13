import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { parseKnowledgeDocument } from "../extensions/llm-wiki/lib/knowledge-document.js";
import { repairLegacyKnowledgeDocuments } from "../extensions/llm-wiki/lib/legacy-repair.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { reindexQmdVault } from "../extensions/llm-wiki/lib/qmd-indexing.js";
import { registerWikiLint, registerWikiStatus } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { getWikiStatus } from "../extensions/llm-wiki/lib/wiki-service.js";

type TestTool = {
  execute: (...args: unknown[]) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
};
const root = join(import.meta.dirname, "..", "tmp", `lint-okf-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

function snapshotTree(path = root, base = root): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = join(path, entry.name);
    const relativePath = fullPath.slice(base.length + 1).replace(/\\/g, "/");
    const snapshot: Record<string, unknown> = {
      kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
    };
    if (entry.isFile()) {
      const handle = openSync(fullPath, "r");
      try {
        const stat = fstatSync(handle);
        snapshot.mode = stat.mode;
        snapshot.mtimeMs = stat.mtimeMs;
        snapshot.hash = createHash("sha256").update(readFileSync(handle)).digest("hex");
      } finally {
        closeSync(handle);
      }
    }
    result[relativePath] = snapshot;
    if (entry.isDirectory()) Object.assign(result, snapshotTree(fullPath, base));
  }
  return result;
}

it("reports and auto-fixes one target referenced by Markdown and a legacy wikilink", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Lint test" }));
  writeFileSync(
    join(paths.wiki, "concepts", "markdown-source.md"),
    "---\ntype: concept\ntitle: Markdown source\n---\n\n[missing](/concepts/missing.md)\n",
  );
  writeFileSync(
    join(paths.wiki, "concepts", "wikilink-source.md"),
    "---\ntype: concept\ntitle: Wikilink source\n---\n\n[[concepts/missing]]\n",
  );

  let tool: TestTool | undefined;
  registerWikiLint({
    registerTool: (definition: unknown) => {
      tool = definition as TestTool;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_lint was not registered");
  const result = await tool.execute("test", { auto_fix: true }, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });

  expect(result.isError).not.toBe(true);
  expect(result.content[0].text).toContain("Missing: 2");
  expect(existsSync(join(paths.wiki, "concepts", "missing.md"))).toBe(true);
  const gaps = JSON.parse(readFileSync(join(paths.discoveries, "gaps.json"), "utf8"));
  expect(gaps.gaps).toEqual([
    {
      topic: "concepts/missing",
      mentionedBy: ["concepts/markdown-source", "concepts/wikilink-source"],
    },
  ]);
});

it("keeps an audit-only lint read-only except the gap snapshot", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Read only" }));
  writeFileSync(join(paths.wiki, "concepts", "valid.md"), "---\ntype: concept\n---\n\nValid.\n");

  let tool: TestTool | undefined;
  registerWikiLint({
    registerTool: (definition: unknown) => {
      tool = definition as TestTool;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_lint was not registered");
  const before = snapshotTree();
  const result = await tool.execute("test", { auto_fix: false }, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });

  expect(result.content[0].text).not.toContain("Report:");
  // The gap snapshot is generated discovery metadata (not vault content) and is
  // refreshed on every lint — exclude it from the byte-identity check and
  // assert it explicitly below.
  const after = snapshotTree();
  for (const key of Object.keys(after)) {
    if (key.endsWith(".discoveries/gaps.json")) delete after[key];
  }
  expect(after).toEqual(before);
  const snapshot = JSON.parse(readFileSync(join(paths.discoveries, "gaps.json"), "utf8"));
  expect(snapshot.gaps).toEqual([]);
  expect(typeof snapshot.generated).toBe("string");
});

it("refreshes a stale gap snapshot to empty on audit-only lint", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Audit stale" }));
  writeFileSync(join(paths.wiki, "concepts", "valid.md"), "---\ntype: concept\n---\n\nValid.\n");
  // Seed the stale snapshot wiki_status would report before lint runs.
  writeFileSync(
    join(paths.discoveries, "gaps.json"),
    JSON.stringify({
      gaps: [{ topic: "concepts/obsolete", mentionedBy: ["concepts/old"] }],
      generated: "2026-08-01T00:00:00.000Z",
    }),
  );

  let lintTool: TestTool | undefined;
  registerWikiLint({
    registerTool: (definition: unknown) => {
      lintTool = definition as TestTool;
    },
  } as unknown as ExtensionAPI);
  if (!lintTool) throw new Error("wiki_lint was not registered");
  const result = await lintTool.execute("test", { auto_fix: false }, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });

  expect(result.isError).not.toBe(true);
  const snapshot = JSON.parse(readFileSync(join(paths.discoveries, "gaps.json"), "utf8"));
  expect(snapshot.gaps).toEqual([]);
  expect(snapshot.generated).not.toBe("2026-08-01T00:00:00.000Z");

  let statusTool: TestTool | undefined;
  registerWikiStatus({
    registerTool: (definition: unknown) => {
      statusTool = definition as TestTool;
    },
  } as unknown as ExtensionAPI);
  if (!statusTool) throw new Error("wiki_status was not registered");
  const status = await statusTool.execute("test", {}, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });
  expect(status.content[0].text).toContain("Gaps: 0");
});

it("persists non-empty gaps on audit-only lint", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Audit gaps" }));
  writeFileSync(
    join(paths.wiki, "concepts", "source.md"),
    "---\ntype: concept\n---\n\n[[concepts/missing]]\n",
  );

  let tool: TestTool | undefined;
  registerWikiLint({
    registerTool: (definition: unknown) => {
      tool = definition as TestTool;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_lint was not registered");
  const result = await tool.execute("test", { auto_fix: false }, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });

  expect(result.isError).not.toBe(true);
  const snapshot = JSON.parse(readFileSync(join(paths.discoveries, "gaps.json"), "utf8"));
  expect(snapshot.gaps).toEqual([{ topic: "concepts/missing", mentionedBy: ["concepts/source"] }]);
  // Audit lint must not auto-create pages.
  expect(existsSync(join(paths.wiki, "concepts", "missing.md"))).toBe(false);
});

it("backs up and repairs malformed legacy pages before rebuilding metadata", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Legacy repair" }));
  const fixtures: Record<string, string> = {
    "analyses/plain.md": "# Plain legacy page\n\nBody preserved.\n",
    "sources/missing-type.md":
      "---\ntitle: Missing type\nunknown: keep\n---\n\n# Missing type\n\nBody preserved.\n",
    "sources/broken-yaml.md":
      '---\ntitle: "Observation: quoted "value""\nunknown: keep\n---\n\n# Broken YAML\n\nBody preserved.\n',
  };
  for (const [path, content] of Object.entries(fixtures)) {
    writeFileSync(join(paths.wiki, path), content);
  }
  writeFileSync(
    join(paths.meta, "registry.json"),
    `${JSON.stringify({
      pages: {
        "analyses/plain": { type: "analysis", title: "Plain legacy page" },
        "sources/missing-type": { type: "source", title: "Missing type" },
        "sources/broken-yaml": { type: "source", title: "Broken YAML" },
      },
    })}\n`,
  );
  expect(rebuildMetadata(paths).ok).toBe(false);

  let tool: TestTool | undefined;
  registerWikiLint({
    registerTool: (definition: unknown) => {
      tool = definition as TestTool;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_lint was not registered");

  const audit = await tool.execute("test", { auto_fix: false }, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });
  expect(audit.content[0].text).toContain("Projection-blocking diagnostics");
  for (const [path, content] of Object.entries(fixtures)) {
    expect(readFileSync(join(paths.wiki, path), "utf8")).toBe(content);
  }

  const modePath = join(paths.wiki, "analyses/plain.md");
  chmodSync(modePath, 0o4750);
  const originalTimes = statSync(modePath);
  const repaired = await tool.execute("test", { auto_fix: true }, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });
  expect(repaired.isError).not.toBe(true);
  expect(repaired.content[0].text).toContain("Legacy pages repaired: 3");
  expect(rebuildMetadata(paths).ok).toBe(true);
  const repairedStat = statSync(modePath);
  expect(repairedStat.mode & 0o7777).toBe(0o4750);
  expect(Math.abs(repairedStat.mtimeMs - originalTimes.mtimeMs)).toBeLessThan(5);

  const backupName = readdirSync(paths.outputs).find((entry) => entry.startsWith("legacy-repair-"));
  expect(backupName).toBeDefined();
  if (!backupName) return;
  const manifest = JSON.parse(
    readFileSync(join(paths.outputs, backupName, "manifest.json"), "utf8"),
  ) as { entries: Array<{ path: string; backup: string; before_sha256: string }> };
  expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(Object.keys(fixtures).sort());
  for (const entry of manifest.entries) {
    expect(readFileSync(join(root, entry.backup), "utf8")).toBe(fixtures[entry.path]);
    const parsed = parseKnowledgeDocument(
      readFileSync(join(paths.wiki, entry.path), "utf8"),
      entry.path,
    );
    expect(parsed.ok, entry.path).toBe(true);
  }

  const missingType = readFileSync(join(paths.wiki, "sources/missing-type.md"), "utf8");
  expect(missingType).toContain("unknown: keep");
  const broken = parseKnowledgeDocument(
    readFileSync(join(paths.wiki, "sources/broken-yaml.md"), "utf8"),
    "sources/broken-yaml.md",
  );
  expect(broken.ok).toBe(true);
  if (broken.ok) {
    expect(broken.document.body).toContain("Body preserved.");
    expect(broken.document.extensions.legacy_frontmatter).toContain("unknown: keep");
  }
});

it("preserves a concurrent save instead of replacing it", () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Concurrent" }));
  const page = join(paths.wiki, "concepts", "changing.md");
  writeFileSync(page, "# Original malformed page\n");

  expect(() =>
    repairLegacyKnowledgeDocuments(paths, new Date("2026-08-05T00:00:00Z"), undefined, () => {
      writeFileSync(page, "# Concurrent writer wins\n");
    }),
  ).toThrow("Legacy page changed during repair");
  expect(readFileSync(page, "utf8")).toBe("# Concurrent writer wins\n");
});

it("refuses a symlinked page parent introduced before commit", () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Symlink" }));
  const folder = join(paths.wiki, "concepts");
  const page = join(folder, "linked.md");
  const original = "# Original malformed page\n";
  writeFileSync(page, original);
  const external = join(root, "external");

  expect(() =>
    repairLegacyKnowledgeDocuments(paths, new Date("2026-08-05T00:00:00Z"), undefined, () => {
      rmSync(folder, { recursive: true });
      mkdirSync(external);
      writeFileSync(join(external, "linked.md"), original);
      symlinkSync(external, folder, "dir");
    }),
  ).toThrow("refuses symlinked path");
  expect(readFileSync(join(external, "linked.md"), "utf8")).toBe(original);
});

it("resumes a checkpointed legacy repair after interruption", () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Interrupted" }));
  writeFileSync(join(paths.wiki, "analyses", "first.md"), "# First\n\nBody one.\n");
  writeFileSync(join(paths.wiki, "concepts", "second.md"), "# Second\n\nBody two.\n");

  expect(() =>
    repairLegacyKnowledgeDocuments(paths, new Date("2026-08-05T00:00:00Z"), () => {
      throw new Error("simulated interruption");
    }),
  ).toThrow("simulated interruption");
  const transaction = readdirSync(paths.outputs).find((entry) =>
    entry.startsWith("legacy-repair-"),
  );
  expect(transaction).toBeDefined();
  if (!transaction) return;
  const journalPath = join(paths.outputs, transaction, "journal.json");
  expect(existsSync(journalPath)).toBe(true);
  expect(
    (JSON.parse(readFileSync(journalPath, "utf8")) as { completed: string[] }).completed,
  ).toHaveLength(1);

  const lockPath = join(paths.dotWiki, ".legacy-repair.lock");
  const takeoverPath = `${lockPath}.takeover`;
  writeFileSync(lockPath, JSON.stringify({ operation_id: "stale", pid: 999_999_999 }));
  writeFileSync(takeoverPath, "other takeover\n");
  expect(() => repairLegacyKnowledgeDocuments(paths)).toThrow(
    "Legacy repair lock takeover is already running",
  );
  expect(readFileSync(lockPath, "utf8")).toContain('"operation_id":"stale"');
  rmSync(takeoverPath);

  const resumed = repairLegacyKnowledgeDocuments(paths);
  expect(resumed.repaired).toBe(2);
  expect(existsSync(journalPath)).toBe(false);
  expect(existsSync(join(paths.dotWiki, ".legacy-repair.lock"))).toBe(false);
  expect(rebuildMetadata(paths).ok).toBe(true);
  expect(
    parseKnowledgeDocument(
      readFileSync(join(paths.wiki, "analyses", "first.md"), "utf8"),
      "analyses/first.md",
    ).ok,
  ).toBe(true);
  expect(
    parseKnowledgeDocument(
      readFileSync(join(paths.wiki, "concepts", "second.md"), "utf8"),
      "concepts/second.md",
    ).ok,
  ).toBe(true);
});

describe("QMD status and lint diagnostics", () => {
  it("reports a ready QMD index with canonical and evidence counts after reindex", async () => {
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Q", mode: "personal" }),
    );
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    mkdirSync(join(paths.wiki, "sources"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "a.md"),
      "---\ntype: concept\n---\n\nCanonical concept.\n",
    );
    writeFileSync(
      join(paths.wiki, "sources", "s.md"),
      "---\ntype: source\n---\n\nEvidence source.\n",
    );

    const res = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const status = await getWikiStatus(paths);
    expect(status.qmd).toMatchObject({
      state: "ready",
      totalDocuments: 2,
      canonicalDocuments: 1,
      evidenceDocuments: 1,
      hasVectorIndex: false,
      qmdVersion: "2.5.3",
    });
  });

  it("reports a stale QMD index in lint with the exact repair command", async () => {
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Q", mode: "personal" }),
    );
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "a.md"),
      "---\ntype: concept\n---\n\nCanonical concept.\n",
    );

    const res = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Make the index stale: add a phantom manifest entry so the hash differs.
    const manifest = JSON.parse(readFileSync(paths.qmdManifest, "utf8"));
    manifest.entries["documents/canonical/concepts/fake.md"] = {
      sourcePath: join(paths.wiki, "concepts", "fake.md"),
      vaultId: manifest.vaultId,
      pageId: "concepts/fake",
      contentHash: "b".repeat(64),
      role: "canonical",
      type: "concept",
    };
    writeFileSync(paths.qmdManifest, JSON.stringify(manifest, null, 2));

    const status = await getWikiStatus(paths);
    expect(status.qmd.state).toBe("stale");

    let lintTool: TestTool | undefined;
    registerWikiLint({
      registerTool: (definition: unknown) => {
        lintTool = definition as TestTool;
      },
    } as unknown as ExtensionAPI);
    if (!lintTool) throw new Error("wiki_lint was not registered");
    const result = await lintTool.execute("test", { auto_fix: false }, undefined, undefined, {
      cwd: root,
      hasUI: false,
    });
    expect(result.content[0].text).toContain("QMD index stale");
    expect(result.content[0].text).toContain(
      'wiki_reindex(scope="changed", components=["lexical"], vault="active")',
    );
    expect(result.content[0].text).not.toContain('components=["lexical, vectors"]');
  });

  it("suggests vectors repair when the embedding model changed", async () => {
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Q", mode: "personal" }),
    );
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(
      join(paths.wiki, "concepts", "a.md"),
      "---\ntype: concept\n---\n\nCanonical concept.\n",
    );

    const res = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Simulate an embedding model change in the recorded state.
    const statePath = join(paths.qmdCurrent, "index-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.models.embed = "text-embedding-3-large";
    writeFileSync(statePath, JSON.stringify(state));

    let lintTool: TestTool | undefined;
    registerWikiLint({
      registerTool: (definition: unknown) => {
        lintTool = definition as TestTool;
      },
    } as unknown as ExtensionAPI);
    if (!lintTool) throw new Error("wiki_lint was not registered");
    const result = await lintTool.execute("test", { auto_fix: false }, undefined, undefined, {
      cwd: root,
      hasUI: false,
    });
    expect(result.content[0].text).toContain(
      'wiki_reindex(scope="changed", components=["vectors"], vault="active")',
    );
    expect(result.content[0].text).not.toContain('components=["lexical, vectors"]');
  });
});
