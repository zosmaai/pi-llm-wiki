import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type QmdReindexResult,
  type QmdStoreFactory,
  readQmdIndexStatus,
  reindexQmdVault,
} from "../extensions/llm-wiki/lib/qmd-indexing.js";
import { QMD_PACKAGE_VERSION, resolveQmdModels } from "../extensions/llm-wiki/lib/qmd-store.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempVault(): ReturnType<typeof getVaultPaths> {
  const root = mkdtempSync(join(tmpdir(), "pi-llm-wiki-index-"));
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ topic: "Index" }));
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  mkdirSync(join(paths.wiki, "entities"), { recursive: true });
  return paths;
}

function writePage(paths: ReturnType<typeof getVaultPaths>, rel: string, title: string): void {
  const dir = join(paths.wiki, rel.split("/").slice(0, -1).join("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(paths.wiki, rel),
    `---
type: ${rel.startsWith("entities") ? "entity" : "concept"}
title: ${title}
created: 2026-08-09
---

# ${title}

Body for ${title}.
`,
  );
}

function fakeFactory(opts: {
  embedCalls?: Array<{ force: boolean }>;
  updateCalls?: number[];
  totalDocuments?: number;
}) {
  const embed = vi.fn(async (arg: { force: boolean }) => {
    opts.embedCalls?.push({ force: arg.force });
    return { docsProcessed: 2, chunksEmbedded: 8, errors: 0, durationMs: 1 };
  });
  const update = vi.fn(async () => {
    opts.updateCalls?.push(1);
    return {
      collections: 2,
      indexed: 2,
      updated: 0,
      unchanged: 0,
      removed: 0,
      needsEmbedding: 2,
    };
  });
  const total = opts.totalDocuments ?? 2;
  const factory: QmdStoreFactory = async () => ({
    update,
    embed,
    status: async () => ({
      totalDocuments: total,
      needsEmbedding: 0,
      hasVectorIndex: true,
      canonicalDocuments: 1,
      evidenceDocuments: total - 1,
    }),
    close: async () => {},
  });
  return { factory, embed, update };
}

describe("QMD vault reindexing", () => {
  it("indexes a fresh vault lexically and reports ready", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    writePage(paths, "entities/b.md", "B");

    const first = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.documents).toMatchObject({ indexed: 2, removed: 0 });
    expect(first.vectors).toEqual({ generated: 0, skipped: 0, errors: 0 });
    expect(first.status.state).toBe("ready");
    expect(existsSync(join(paths.qmdCurrent, "index.sqlite"))).toBe(true);

    // edit, add, delete, then run changed again
    writePage(paths, "concepts/a.md", "A edited");
    writePage(paths, "concepts/c.md", "C");
    rmSync(join(paths.wiki, "entities", "b.md"));

    const second = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.documents).toMatchObject({ indexed: 1, updated: 1, removed: 1 });
    expect(second.status.totalDocuments).toBe(2);
  });

  it("performs document update before embedding for vector components", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    writePage(paths, "entities/b.md", "B");
    const { factory, update, embed } = fakeFactory({ updateCalls: [], embedCalls: [] });

    const result = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["vectors"],
        force: false,
      },
      { factory },
    );
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalled();
    expect(embed).toHaveBeenCalled();
    expect(result.vectors).toMatchObject({ generated: 2, errors: 0 });
  });

  it("never calls embed for lexical-only indexing", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const { factory, embed } = fakeFactory({ totalDocuments: 1 });
    const result = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["lexical"],
        force: false,
      },
      { factory },
    );
    expect(result.ok).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    expect(result.vectors).toEqual({ generated: 0, skipped: 0, errors: 0 });
  });

  it("forwards force:true to embed for vector components", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const embedCalls: Array<{ force: boolean }> = [];
    const { factory } = fakeFactory({ embedCalls, totalDocuments: 1 });
    const result = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["vectors"],
        force: true,
      },
      { factory },
    );
    expect(result.ok).toBe(true);
    expect(embedCalls).toEqual([{ force: true }]);
  });

  it("starts lexical force rebuild from an empty staging store", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    // First pass builds current.
    const first = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      force: false,
    });
    expect(first.ok).toBe(true);
    expect(existsSync(join(paths.qmdCurrent, "index.sqlite"))).toBe(true);

    // Count cp calls via an fs seam; force must not copy current into staging.
    const cpCalls: string[] = [];
    const { factory } = fakeFactory({ totalDocuments: 1 });
    const cp = (await import("node:fs/promises")).cp;
    const forced = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["lexical"],
        force: true,
      },
      {
        factory,
        fs: {
          exists: async (p: string) => existsSync(p),
          rename: async (from: string, to: string) =>
            (await import("node:fs/promises")).rename(from, to),
          rm: async (p: string, o: { recursive: boolean; force: boolean }) =>
            (await import("node:fs/promises")).rm(p, o as never),
          cp: async (
            from: string,
            to: string,
            o: { recursive: boolean; errorOnExist: boolean },
          ) => {
            cpCalls.push(from);
            await cp(from, to, o as never);
          },
        },
      },
    );
    expect(forced.ok).toBe(true);
    expect(cpCalls).toHaveLength(0);
  });

  it("isolates identical page IDs across vaults", async () => {
    const pathsA = tempVault();
    const pathsB = tempVault();
    writePage(pathsA, "concepts/foo.md", "Foo");
    writePage(pathsB, "concepts/foo.md", "Foo");

    const a = await reindexQmdVault(pathsA, { scope: "changed", components: ["lexical"] });
    const b = await reindexQmdVault(pathsB, { scope: "changed", components: ["lexical"] });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.vaultId).toBeDefined();
    expect(b.vaultId).toBeDefined();
    expect(a.vaultId).not.toBe(b.vaultId);
    expect(a.vaultId).toMatch(UUID);
  });

  it("rejects an invalid existing vault_id without replacing it", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Index", vault_id: "not-a-uuid" }),
    );
    const result = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "config_invalid_vault_id")).toBe(true);
    const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
    expect(config.vault_id).toBe("not-a-uuid");
  });

  it("backfills vault_id once and preserves unrelated config keys", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const original = { topic: "Index", name: "Vault", nested: { keep: true }, list: [1, 2, 3] };
    writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify(original));

    const result = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(result.ok).toBe(true);
    const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
    expect(config.vault_id).toMatch(UUID);
    const { vault_id: _removed, ...rest } = config;
    expect(rest).toEqual(original);
  });

  it("keeps current store and records error when staging update fails", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const first = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const currentState = readFileSync(join(paths.qmdCurrent, "index-state.json"), "utf8");
    const manifestHash = JSON.parse(currentState).manifestHash;

    const failingFactory: QmdStoreFactory = async () => ({
      update: async () => {
        throw new Error("staging update exploded");
      },
      embed: async () => {
        throw new Error("nope");
      },
      status: async () => {
        throw new Error("nope");
      },
      close: async () => {},
    });

    const result = await reindexQmdVault(
      paths,
      {
        scope: "changed",
        components: ["lexical"],
        force: false,
      },
      { factory: failingFactory },
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(join(paths.qmdCurrent, "index-state.json"), "utf8")).toBe(currentState);
    const status = await readQmdIndexStatus(paths);
    expect(status.state === "stale" || status.state === "error").toBe(true);
    expect(existsSync(join(paths.qmd, "last-error.json"))).toBe(true);
    const lastError = JSON.parse(readFileSync(join(paths.qmd, "last-error.json"), "utf8"));
    expect(lastError.manifestHash).toBe(manifestHash);
  });

  it("cancellation does not promote staging", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const first = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(first.ok).toBe(true);
    const currentState = readFileSync(join(paths.qmdCurrent, "index-state.json"), "utf8");

    const controller = new AbortController();
    controller.abort();
    const result = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(paths.qmdCurrent, "index-state.json"), "utf8")).toBe(currentState);
  });

  it("returns a graceful busy result when a live lock is held", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const lockDir = join(paths.meta, "qmd", "index.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      }),
    );

    const result = await reindexQmdVault(paths, {
      scope: "changed",
      components: ["lexical"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "qmd_index_busy")).toBe(true);
    // A busy lock we do not own must not be removed.
    expect(existsSync(lockDir)).toBe(true);
  });

  it("publishes the write-ahead phase before each destructive rename", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const first = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Wrap the fs adapter: before delegating each rename, read swap.json and
    // record the persisted phase. Write-ahead intent must precede the rename.
    const observed: string[] = [];
    const realRename = (await import("node:fs/promises")).rename;
    const { factory } = fakeFactory({ totalDocuments: 1 });
    const fsSeam = {
      exists: async (p: string) => existsSync(p),
      rename: async (from: string, to: string) => {
        const journal = JSON.parse(readFileSync(paths.qmdSwap, "utf8"));
        observed.push(`${journal.phase}:${from.endsWith("current") ? "current" : "staging"}`);
        await realRename(from, to);
      },
      rm: async (p: string, o: { recursive: boolean; force: boolean }) =>
        (await import("node:fs/promises")).rm(p, o as never),
      cp: async (from: string, to: string, o: { recursive: boolean; errorOnExist: boolean }) =>
        (await import("node:fs/promises")).cp(from, to, o as never),
    };

    const second = await reindexQmdVault(
      paths,
      { scope: "changed", components: ["lexical"], force: true },
      { factory, fs: fsSeam },
    );
    expect(second.ok).toBe(true);
    expect(observed).toEqual(["previous-moved:current", "current-promoted:staging"]);
  });
});

// ---------------------------------------------------------------------------
// Generated status artifact matrix (Task 2)
// ---------------------------------------------------------------------------

interface StatusVault {
  paths: ReturnType<typeof getVaultPaths>;
  vaultId: string;
}

function statusVault(): StatusVault {
  const paths = tempVault();
  writeFileSync(
    join(paths.dotWiki, "config.json"),
    JSON.stringify({ topic: "Status", vault_id: "11111111-1111-4111-8111-111111111111" }),
  );
  return { paths, vaultId: "11111111-1111-4111-8111-111111111111" };
}

function validStateFile(v: StatusVault, opts: { manifestHash?: string } = {}) {
  return {
    version: 1,
    vaultId: v.vaultId,
    qmdVersion: QMD_PACKAGE_VERSION,
    models: resolveQmdModels(),
    manifestHash: opts.manifestHash ?? "0".repeat(64),
    indexedAt: "2026-08-09T00:00:00.000Z",
    status: {
      totalDocuments: 2,
      canonicalDocuments: 1,
      evidenceDocuments: 1,
      needsEmbedding: 0,
      hasVectorIndex: false,
    },
  };
}

function validManifest(v: StatusVault) {
  return {
    version: 1,
    vaultId: v.vaultId,
    entries: {
      "documents/canonical/concepts/a.md": {
        sourcePath: join(v.paths.wiki, "concepts/a.md"),
        vaultId: v.vaultId,
        pageId: "concepts/a",
        contentHash: "a".repeat(64),
        role: "canonical",
        type: "concept",
      },
    },
  };
}

function writeArtifact(path: string, content: unknown): void {
  mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

describe("QMD generated status artifact matrix", () => {
  it("reports missing with no artifacts", async () => {
    const v = statusVault();
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("missing");
    expect(status.repairComponents).toEqual([]);
  });

  it("reports error for malformed manifest JSON", async () => {
    const v = statusVault();
    writeArtifact(v.paths.qmdManifest, "{not-json");
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("error");
    expect(status.issues.some((i) => i.code === "qmd_manifest_invalid")).toBe(true);
  });

  it("reports error for a structurally invalid manifest entry", async () => {
    const v = statusVault();
    const manifest = validManifest(v);
    (manifest.entries as Record<string, unknown>)["documents/concepts/a.md"] = {
      pageId: "concepts/a",
      role: "canonical",
    }; // missing sourcePath/contentHash/type/vaultId
    writeArtifact(v.paths.qmdManifest, manifest);
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("error");
    expect(status.issues.some((i) => i.code === "qmd_manifest_invalid")).toBe(true);
  });

  it("reports error for malformed state JSON", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), "{nope");
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("error");
    expect(status.issues.some((i) => i.code === "qmd_index_error")).toBe(true);
  });

  it("reports error for a state file missing required fields", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), { version: 1, vaultId: "x" });
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("error");
    expect(status.issues.some((i) => i.code === "qmd_index_error")).toBe(true);
  });

  it("reports stale when state exists but manifest is missing", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), validStateFile(v));
    writeArtifact(join(v.paths.qmdCurrent, "index.sqlite"), "");
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("stale");
    expect(status.issues.some((i) => i.code === "qmd_index_stale")).toBe(true);
  });

  it("reports error when state exists but config is missing", async () => {
    const v = statusVault();
    rmSync(join(v.paths.dotWiki, "config.json"));
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), validStateFile(v));
    writeArtifact(join(v.paths.qmdCurrent, "index.sqlite"), "");
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("error");
  });

  it("reports error when state exists but current/index.sqlite is absent", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), validStateFile(v));
    writeArtifact(v.paths.qmdManifest, validManifest(v));
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("error");
    expect(status.issues.some((i) => i.code === "qmd_index_error")).toBe(true);
  });

  it("reports error when last-error exists with no usable current", async () => {
    const v = statusVault();
    writeArtifact(join(v.paths.qmd, "last-error.json"), {
      code: "qmd_index_error",
      message: "boom",
    });
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("error");
    expect(status.issues.some((i) => i.code === "qmd_index_error")).toBe(true);
  });

  it("reports stale with last error preserved when current is usable", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), validStateFile(v));
    writeArtifact(join(v.paths.qmdCurrent, "index.sqlite"), "");
    writeArtifact(v.paths.qmdManifest, validManifest(v));
    writeArtifact(join(v.paths.qmd, "last-error.json"), {
      code: "qmd_index_error",
      message: "boom",
    });
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("stale");
    expect(status.totalDocuments).toBe(2);
    expect(status.issues.some((i) => i.code === "qmd_index_error")).toBe(true);
  });

  it("reports recovering with the phase for a valid swap journal", async () => {
    const v = statusVault();
    writeArtifact(v.paths.qmdSwap, {
      version: 1,
      operationId: "op",
      stagingName: `staging-${randomUUID()}`,
      phase: "previous-moved",
      startedAt: "2026-08-09T00:00:00.000Z",
    });
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("recovering");
    expect(status.swapPhase).toBe("previous-moved");
    expect(status.repairComponents).toEqual([]);
  });

  it("reports error for a malformed swap journal", async () => {
    const v = statusVault();
    writeArtifact(v.paths.qmdSwap, { version: 99, phase: "bogus" });
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("error");
    expect(status.issues.some((i) => i.code === "qmd_swap_interrupted")).toBe(true);
  });

  it("reports stale with lexical repair on manifest mismatch without vectors", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), validStateFile(v));
    writeArtifact(join(v.paths.qmdCurrent, "index.sqlite"), "");
    writeArtifact(v.paths.qmdManifest, validManifest(v)); // hash differs from state manifestHash
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("stale");
    expect(status.repairComponents).toEqual(["lexical"]);
  });

  it("reports stale with vectors repair on embedding model mismatch", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    const state = validStateFile(v);
    state.models = { embed: "text-embedding-3-small", generate: "", rerank: "" };
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), state);
    writeArtifact(join(v.paths.qmdCurrent, "index.sqlite"), "");
    writeArtifact(v.paths.qmdManifest, validManifest(v));
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("stale");
    expect(status.repairComponents).toEqual(["vectors"]);
  });

  it("reports stale with vectors repair on manifest mismatch with an existing vector index", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    const state = validStateFile(v);
    state.status = { ...state.status, hasVectorIndex: true };
    writeArtifact(join(v.paths.qmdCurrent, "index-state.json"), state);
    writeArtifact(join(v.paths.qmdCurrent, "index.sqlite"), "");
    writeArtifact(v.paths.qmdManifest, validManifest(v));
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("stale");
    expect(status.repairComponents).toEqual(["vectors"]);
  });

  it("reports ready for a fully consistent current store", async () => {
    const v = statusVault();
    mkdirSync(v.paths.qmdCurrent, { recursive: true });
    const manifest = validManifest(v);
    const manifestHash = hashOf(manifest);
    writeArtifact(
      join(v.paths.qmdCurrent, "index-state.json"),
      validStateFile(v, { manifestHash }),
    );
    writeArtifact(join(v.paths.qmdCurrent, "index.sqlite"), "");
    writeArtifact(v.paths.qmdManifest, manifest);
    const status = await readQmdIndexStatus(v.paths);
    expect(status.state).toBe("ready");
    expect(status.repairComponents).toEqual([]);
  });
});

function hashOf(manifest: unknown): string {
  // Replicate the manifest hash used by qmd-mirror (sorted entries JSON sha256).
  const m = manifest as { version: number; vaultId: string; entries: Record<string, unknown> };
  const entries = Object.fromEntries(
    Object.entries(m.entries).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return createHash("sha256")
    .update(JSON.stringify({ version: m.version, vaultId: m.vaultId, entries }))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Task 3: fail-closed config + staging cleanup
// ---------------------------------------------------------------------------

describe("QMD config fail-closed", () => {
  it("preserves malformed config and creates no generated state", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const configPath = join(paths.dotWiki, "config.json");
    writeFileSync(configPath, "{not-json");

    const result = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe("{not-json");
    expect(result.errors.some((e) => e.code === "config_invalid")).toBe(true);
    expect(existsSync(join(paths.qmd, "current"))).toBe(false);
    expect(existsSync(paths.qmdManifest)).toBe(false);
  });

  it("rejects a JSON array config without touching it", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const configPath = join(paths.dotWiki, "config.json");
    writeFileSync(configPath, JSON.stringify([1, 2, 3]));

    const result = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(JSON.stringify([1, 2, 3]));
    expect(existsSync(paths.qmdManifest)).toBe(false);
  });

  it("errors on a directory at config.json without removing it", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const configPath = join(paths.dotWiki, "config.json");
    rmSync(configPath, { force: true });
    mkdirSync(configPath);

    const result = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(result.ok).toBe(false);
    expect(existsSync(configPath)).toBe(true);
    const stat = await (await import("node:fs/promises")).stat(configPath);
    expect(stat.isDirectory()).toBe(true);
    expect(existsSync(paths.qmdManifest)).toBe(false);
  });
});

describe("QMD staging cleanup", () => {
  it("removes staging when the store update fails before journal publication", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const first = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const failingFactory: QmdStoreFactory = async () => ({
      update: async () => {
        throw new Error("staging update exploded");
      },
      embed: async () => {
        throw new Error("nope");
      },
      status: async () => {
        throw new Error("nope");
      },
      close: async () => {},
    });

    const result = await reindexQmdVault(
      paths,
      { scope: "changed", components: ["lexical"], force: false },
      { factory: failingFactory },
    );
    expect(result.ok).toBe(false);
    const stagingDirs = readdirSync(paths.qmd).filter((n) => n.startsWith("staging-"));
    expect(stagingDirs).toEqual([]);
  });

  it("removes staging when staging validation fails before journal publication", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const { factory } = fakeFactory({ totalDocuments: 99 }); // mismatch with manifest
    const result = await reindexQmdVault(
      paths,
      { scope: "changed", components: ["lexical"] },
      { factory },
    );
    expect(result.ok).toBe(false);
    const stagingDirs = readdirSync(paths.qmd).filter((n) => n.startsWith("staging-"));
    expect(stagingDirs).toEqual([]);
  });

  it("removes staging when cancelled mid-update", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const first = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(first.ok).toBe(true);

    const controller = new AbortController();
    const cancellingFactory: QmdStoreFactory = async () => ({
      update: async () => {
        controller.abort();
        return {
          collections: 2,
          indexed: 1,
          updated: 0,
          unchanged: 0,
          removed: 0,
          needsEmbedding: 1,
        };
      },
      embed: async () => ({ docsProcessed: 1, chunksEmbedded: 2, errors: 0, durationMs: 1 }),
      status: async () => ({
        totalDocuments: 1,
        needsEmbedding: 0,
        hasVectorIndex: false,
        canonicalDocuments: 1,
        evidenceDocuments: 0,
      }),
      close: async () => {},
    });

    const result = await reindexQmdVault(
      paths,
      { scope: "changed", components: ["lexical"], signal: controller.signal },
      { factory: cancellingFactory },
    );
    expect(result.ok).toBe(false);
    const stagingDirs = readdirSync(paths.qmd).filter((n) => n.startsWith("staging-"));
    expect(stagingDirs).toEqual([]);
  });

  it("keeps arbitrary unknown files under meta/qmd untouched", async () => {
    const paths = tempVault();
    writePage(paths, "concepts/a.md", "A");
    const unknownDir = join(paths.qmd, "custom-thing");
    mkdirSync(unknownDir, { recursive: true });
    writeFileSync(join(unknownDir, "keep.txt"), "x");

    const result = await reindexQmdVault(paths, { scope: "changed", components: ["lexical"] });
    expect(result.ok).toBe(true);
    expect(existsSync(join(unknownDir, "keep.txt"))).toBe(true);
  });
});
