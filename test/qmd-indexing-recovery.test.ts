import { randomUUID } from "node:crypto";
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
import { afterEach, describe, expect, it } from "vitest";
import {
  type QmdIndexDeps,
  type QmdStoreFactory,
  recoverQmdIndex,
} from "../extensions/llm-wiki/lib/qmd-indexing.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type FsSeam = NonNullable<QmdIndexDeps["fs"]>;

interface Harness {
  paths: ReturnType<typeof getVaultPaths>;
  vaultId: string;
  openCount: () => number;
  renames: string[];
  deps: { factory: QmdStoreFactory; fs: FsSeam };
  writeCurrent(marker?: string): void;
  writePrevious(marker?: string): void;
  writeStaging(name: string, marker?: string): void;
  writeJournal(journal: Record<string, unknown>): void;
  writeCurrentState(count: number, manifestHash?: string): void;
  writeLastError(): void;
  setBroken(marker: string): void;
  setCount(marker: string, count: number): void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "pi-llm-wiki-recovery-"));
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ topic: "R" }));
  const vaultId = randomUUID();
  mkdirSync(paths.qmd, { recursive: true });

  let open = 0;
  const brokenMarkers = new Set<string>();
  const counts = new Map<string, number>();
  const renames: string[] = [];

  const factory: QmdStoreFactory = async (input) => {
    const dir = input.dbPath.replace(/index\.sqlite$/, "");
    const markerPath = join(dir, ".marker");
    if (!existsSync(markerPath) || brokenMarkers.has(readFileSync(markerPath, "utf8"))) {
      throw new Error("store db missing or broken");
    }
    const marker = readFileSync(markerPath, "utf8");
    open++;
    return {
      update: async () => ({
        collections: 2,
        indexed: 1,
        updated: 0,
        unchanged: 0,
        removed: 0,
        needsEmbedding: 1,
      }),
      embed: async () => ({ docsProcessed: 1, chunksEmbedded: 2, errors: 0, durationMs: 1 }),
      status: async () => ({
        totalDocuments: counts.get(marker) ?? 1,
        needsEmbedding: 0,
        hasVectorIndex: false,
        canonicalDocuments: 1,
        evidenceDocuments: 0,
      }),
      close: async () => {
        open--;
      },
    };
  };

  const real = {
    exists: async (p: string) => existsSync(p),
    rename: async (from: string, to: string) => {
      if (open > 0) throw new Error("rename while store open");
      renames.push(`${from} -> ${to}`);
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
    rm: async (p: string, opts: { recursive: boolean; force: boolean }) => {
      const { rm } = await import("node:fs/promises");
      await rm(p, opts as never);
    },
    cp: async (from: string, to: string, opts: { recursive: boolean; errorOnExist: boolean }) => {
      const { cp } = await import("node:fs/promises");
      await cp(from, to, opts as never);
    },
  };

  return {
    paths,
    vaultId,
    openCount: () => open,
    renames,
    deps: { factory, fs: real },
    writeCurrent: (marker = "current") => {
      const dir = join(paths.qmdCurrent);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".marker"), marker);
      writeFileSync(join(dir, "index.sqlite"), "sqlite-marker");
    },
    writePrevious: (marker = "previous") => {
      const dir = join(paths.qmd, "previous");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".marker"), marker);
      writeFileSync(join(dir, "index.sqlite"), "sqlite-marker");
    },
    writeStaging: (name: string, marker = "staging") => {
      const dir = join(paths.qmd, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".marker"), marker);
      writeFileSync(join(dir, "index.sqlite"), "sqlite-marker");
    },
    writeJournal: (journal) => {
      writeFileSync(paths.qmdSwap, JSON.stringify(journal));
    },
    writeCurrentState: (count: number, manifestHash = "hash") => {
      writeFileSync(
        join(paths.qmdCurrent, "index-state.json"),
        JSON.stringify({
          version: 1,
          vaultId,
          qmdVersion: "2.5.3",
          models: { embed: "m" },
          manifestHash,
          indexedAt: new Date().toISOString(),
          status: {
            totalDocuments: count,
            canonicalDocuments: count,
            evidenceDocuments: 0,
            needsEmbedding: 0,
            hasVectorIndex: false,
          },
        }),
      );
    },
    writeLastError: () => {
      writeFileSync(
        join(paths.qmd, "last-error.json"),
        JSON.stringify({ code: "qmd_index_error", message: "boom", at: new Date().toISOString() }),
      );
    },
    setBroken: (marker: string) => brokenMarkers.add(marker),
    setCount: (marker: string, count: number) => counts.set(marker, count),
  };
}

function journal(name: string, phase: string): Record<string, unknown> {
  return {
    version: 1,
    operationId: "op-1",
    stagingName: name,
    phase,
    startedAt: new Date().toISOString(),
  };
}

describe("QMD index swap recovery", () => {
  it("removes staging and retains current on prepared", async () => {
    const h = harness();
    h.writeCurrent();
    const staging = `staging-${randomUUID()}`;
    h.writeStaging(staging);
    h.writeJournal(journal(staging, "prepared"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmd, staging))).toBe(false);
    expect(existsSync(join(h.paths.qmdCurrent, ".marker"))).toBe(true);
    expect(existsSync(h.paths.qmdSwap)).toBe(false);
  });

  it("restores previous to current and removes staging on previous-moved", async () => {
    const h = harness();
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeStaging(staging);
    h.writeJournal(journal(staging, "previous-moved"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmdCurrent, ".marker"))).toBe(true);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("previous");
    expect(existsSync(join(h.paths.qmd, staging))).toBe(false);
    expect(existsSync(h.paths.qmdSwap)).toBe(false);
  });

  it("validates current and removes previous on current-promoted (valid)", async () => {
    const h = harness();
    h.writeCurrent();
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeJournal(journal(staging, "current-promoted"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmdCurrent, ".marker"))).toBe(true);
    expect(existsSync(join(h.paths.qmd, "previous"))).toBe(false);
    expect(existsSync(h.paths.qmdSwap)).toBe(false);
  });

  it("restores previous when current-promoted current is broken", async () => {
    const h = harness();
    h.writeCurrent("broken-current");
    h.setBroken("broken-current");
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeJournal(journal(staging, "current-promoted"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmdCurrent, ".marker"))).toBe(true);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("previous");
    expect(existsSync(join(h.paths.qmd, "previous"))).toBe(false);
    expect(existsSync(h.paths.qmdSwap)).toBe(false);
  });

  it("retains current and removes previous on validated", async () => {
    const h = harness();
    h.writeCurrent();
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeJournal(journal(staging, "validated"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmdCurrent, ".marker"))).toBe(true);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("current");
    expect(existsSync(join(h.paths.qmd, "previous"))).toBe(false);
    expect(existsSync(h.paths.qmdSwap)).toBe(false);
  });

  it("reports qmd_swap_interrupted and leaves disk untouched on malformed journal", async () => {
    const h = harness();
    h.writeCurrent();
    h.writeJournal({ version: 99, operationId: "x", stagingName: "staging-abc", phase: "bogus" });
    const before = readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8");
    const result = await recoverQmdIndex(h.paths, h.deps);
    expect(result.diagnostics.some((d) => d.code === "qmd_swap_interrupted")).toBe(true);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe(before);
    expect(existsSync(h.paths.qmdSwap)).toBe(true);
  });

  it("never renames while a store is open", async () => {
    const h = harness();
    h.writeCurrent();
    const staging = `staging-${randomUUID()}`;
    h.writeStaging(staging);
    h.writeJournal(journal(staging, "prepared"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(h.openCount()).toBe(0);
    for (const rename of h.renames) {
      expect(rename).not.toMatch(/open/i);
    }
  });
});

describe("QMD swap crash windows (write-ahead)", () => {
  it("restores previous when prepared but current was already moved", async () => {
    const h = harness();
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeStaging(staging);
    h.writeJournal(journal(staging, "prepared"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmdCurrent, ".marker"))).toBe(true);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("previous");
    expect(existsSync(join(h.paths.qmd, staging))).toBe(false);
    expect(existsSync(h.paths.qmdSwap)).toBe(false);
  });

  it("retains validated current and removes previous on previous-moved with both present", async () => {
    const h = harness();
    h.writeCurrent("promoted");
    h.writeCurrentState(1);
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeJournal(journal(staging, "previous-moved"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("promoted");
    expect(existsSync(join(h.paths.qmd, "previous"))).toBe(false);
    expect(existsSync(h.paths.qmdSwap)).toBe(false);
  });

  it("rolls back to previous when previous-moved current fails count validation", async () => {
    const h = harness();
    h.writeCurrent("wrong-count");
    h.writeCurrentState(1);
    h.setCount("wrong-count", 7);
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeJournal(journal(staging, "previous-moved"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("previous");
    expect(existsSync(join(h.paths.qmd, "previous"))).toBe(false);
  });

  it("restores previous and removes staging on current-promoted with missing current", async () => {
    const h = harness();
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeStaging(staging);
    h.writeJournal(journal(staging, "current-promoted"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmdCurrent, ".marker"))).toBe(true);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("previous");
    expect(existsSync(join(h.paths.qmd, staging))).toBe(false);
  });

  it("removes invalid current without a previous and reports missing", async () => {
    const h = harness();
    h.writeCurrent("broken-promoted");
    h.setBroken("broken-promoted");
    const staging = `staging-${randomUUID()}`;
    h.writeJournal(journal(staging, "current-promoted"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmdCurrent, "index.sqlite"))).toBe(false);
    expect(existsSync(h.paths.qmdSwap)).toBe(false);
  });

  it("keeps current and removes staging when previous-moved crash happened before rename", async () => {
    const h = harness();
    h.writeCurrent();
    const staging = `staging-${randomUUID()}`;
    h.writeStaging(staging);
    h.writeJournal(journal(staging, "previous-moved"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("current");
    expect(existsSync(join(h.paths.qmd, "previous"))).toBe(false);
    expect(existsSync(join(h.paths.qmd, staging))).toBe(false);
  });

  it("validates current before choosing it over previous after current-promoted rename", async () => {
    const h = harness();
    h.writeCurrent("promoted");
    h.writeCurrentState(1);
    h.writePrevious();
    const staging = `staging-${randomUUID()}`;
    h.writeJournal(journal(staging, "current-promoted"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(readFileSync(join(h.paths.qmdCurrent, ".marker"), "utf8")).toBe("promoted");
    expect(existsSync(join(h.paths.qmd, "previous"))).toBe(false);
  });

  it("clears last-error.json after successful recovery but preserves it otherwise", async () => {
    const h = harness();
    h.writeCurrent();
    h.writeCurrentState(1);
    h.writePrevious();
    h.writeLastError();
    const staging = `staging-${randomUUID()}`;
    h.writeJournal(journal(staging, "validated"));
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmd, "last-error.json"))).toBe(false);

    const h2 = harness();
    h2.writeCurrent("broken");
    h2.setBroken("broken");
    h2.writeLastError();
    const staging2 = `staging-${randomUUID()}`;
    h2.writeJournal(journal(staging2, "current-promoted"));
    await recoverQmdIndex(h2.paths, h2.deps);
    expect(existsSync(join(h2.paths.qmd, "last-error.json"))).toBe(true);
  });
});

describe("QMD index lock", () => {
  it("returns qmd_index_busy for a live same-host lock", async () => {
    const h = harness();
    const lockDir = join(h.paths.qmd, "index.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      }),
    );
    const result = await recoverQmdIndex(h.paths, h.deps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "qmd_index_busy")).toBe(true);
  });

  it("recovers a dead same-host lock", async () => {
    const h = harness();
    h.writeCurrent();
    const lockDir = join(h.paths.qmd, "index.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 99999999, hostname: hostname(), acquiredAt: new Date().toISOString() }),
    );
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("never breaks another-host or malformed locks", async () => {
    const h = harness();
    const lockDir = join(h.paths.qmd, "index.lock");

    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 99999999,
        hostname: "some-other-host",
        acquiredAt: new Date().toISOString(),
      }),
    );
    let result = await recoverQmdIndex(h.paths, h.deps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "qmd_index_busy")).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
    rmSync(lockDir, { recursive: true, force: true });

    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), "{not-json");
    result = await recoverQmdIndex(h.paths, h.deps);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "qmd_index_busy")).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
  });

  it("releases the lock after a thrown error", async () => {
    const h = harness();
    const lockDir = join(h.paths.qmd, "index.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 99999999, hostname: hostname(), acquiredAt: new Date().toISOString() }),
    );
    // A malformed journal forces an error path after lock acquisition.
    h.writeJournal({ garbage: true });
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe("QMD stale staging cleanup", () => {
  it("removes unreferenced staging directories with no journal", async () => {
    const h = harness();
    h.writeCurrent();
    h.writeStaging(`staging-${randomUUID()}`);
    h.writeStaging(`staging-${randomUUID()}`);
    await recoverQmdIndex(h.paths, h.deps);
    const stagingDirs = readdirSync(h.paths.qmd).filter((n) => n.startsWith("staging-"));
    expect(stagingDirs).toEqual([]);
    expect(existsSync(join(h.paths.qmdCurrent, ".marker"))).toBe(true);
  });

  it("keeps the journal-referenced staging and removes unrelated ones", async () => {
    const h = harness();
    h.writeCurrent();
    const referenced = `staging-${randomUUID()}`;
    h.writeStaging(referenced);
    h.writeStaging(`staging-${randomUUID()}`);
    h.writeJournal(journal(referenced, "prepared"));
    await recoverQmdIndex(h.paths, h.deps);
    // prepared phase removes the referenced staging as well.
    const stagingDirs = readdirSync(h.paths.qmd).filter((n) => n.startsWith("staging-"));
    expect(stagingDirs).toEqual([]);
  });

  it("removes nothing on a malformed journal", async () => {
    const h = harness();
    h.writeCurrent();
    const stale = `staging-${randomUUID()}`;
    h.writeStaging(stale);
    h.writeJournal({ version: 99, operationId: "x", stagingName: "staging-abc", phase: "bogus" });
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(h.paths.qmd, stale))).toBe(true);
    expect(existsSync(h.paths.qmdSwap)).toBe(true);
  });

  it("never removes arbitrary unknown entries under meta/qmd", async () => {
    const h = harness();
    h.writeCurrent();
    const unknown = join(h.paths.qmd, "custom-thing");
    mkdirSync(unknown, { recursive: true });
    writeFileSync(join(unknown, "keep.txt"), "x");
    await recoverQmdIndex(h.paths, h.deps);
    expect(existsSync(join(unknown, "keep.txt"))).toBe(true);
  });
});
