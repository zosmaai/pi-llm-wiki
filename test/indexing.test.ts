import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetIndexingState,
  indexLabel,
  scheduleReindex,
} from "../extensions/llm-wiki/lib/indexing.js";
import { saveObservation } from "../extensions/llm-wiki/lib/observation.js";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

// ── vault scaffolding ─────────────────────────────────────
function makeVault(tmpDir: string): string {
  const dir = join(tmpDir, `vault-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const llmWiki = join(dir, ".llm-wiki");
  const dirs = [
    "raw/articles",
    "wiki/entities",
    "wiki/concepts",
    "wiki/sources",
    "wiki/syntheses",
    "meta",
    "outputs",
    ".discoveries",
  ];
  for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });
  ensureVaultStructure(getVaultPaths(dir));
  writeFileSync(
    join(llmWiki, "config.json"),
    JSON.stringify({ topic: "Test", mode: "personal", created: "2026-06-06", version: "1.0" }),
    "utf-8",
  );
  return dir;
}

function writePage(vaultDir: string, slug: string): void {
  const p = join(vaultDir, ".llm-wiki", "wiki", "concepts", `${slug}.md`);
  writeFileSync(
    p,
    `---\ntype: concept\ntitle: "${slug}"\ncreated: 2026-06-06\nupdated: 2026-06-06\n---\n\n# ${slug}\n\nBody.\n`,
    "utf-8",
  );
}

function readRegistry(vaultDir: string): { pages: Record<string, unknown> } {
  const p = join(vaultDir, ".llm-wiki", "meta", "registry.json");
  if (!existsSync(p)) return { pages: {} };
  return JSON.parse(readFileSync(p, "utf-8"));
}

// A fake runtime that counts launchTask invocations but reproduces its
// single-flight-per-label + error-isolation contract.
function fakeRuntime() {
  let launches = 0;
  const inFlight = new Map<string, Promise<void>>();
  const rt = {
    config: {} as Record<string, unknown>,
    configLoaded: true,
    ensureConfig() {},
    launchCount: () => launches,
    launchTask(_ctx: unknown, label: string, work: () => Promise<void>) {
      const existing = inFlight.get(label);
      if (existing) return existing;
      launches++;
      // biome-ignore lint/style/useConst: referenced in its own finally
      let promise!: Promise<void>;
      promise = (async () => {
        try {
          await work();
        } finally {
          if (inFlight.get(label) === promise) inFlight.delete(label);
        }
      })();
      inFlight.set(label, promise);
      return promise;
    },
    async awaitAll() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
    },
  };
  return rt;
}

const CTX = { hasUI: false as const };

describe("scheduleReindex", () => {
  let tmpDir: string;

  beforeEach(() => {
    __resetIndexingState();
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `indexing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    __resetIndexingState();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("is non-blocking: the metadata rebuild does not run on the caller's stack", async () => {
    const vaultDir = makeVault(tmpDir);
    const paths = getVaultPaths(vaultDir);
    const rt = new Runtime();
    writePage(vaultDir, "alpha");

    scheduleReindex(rt, CTX, paths);

    // Synchronously after scheduling, the rebuild must NOT have run yet.
    expect(readRegistry(vaultDir).pages["concepts/alpha"]).toBeUndefined();

    await rt.awaitAll();

    // After draining background work, the page is registered.
    expect(readRegistry(vaultDir).pages["concepts/alpha"]).toBeDefined();
  });

  it("coalesces a burst of schedule calls into a single background pass", async () => {
    const vaultDir = makeVault(tmpDir);
    const paths = getVaultPaths(vaultDir);
    const rt = fakeRuntime();

    writePage(vaultDir, "a");
    scheduleReindex(rt as unknown as Runtime, CTX, paths);
    writePage(vaultDir, "b");
    scheduleReindex(rt as unknown as Runtime, CTX, paths);
    writePage(vaultDir, "c");
    scheduleReindex(rt as unknown as Runtime, CTX, paths);

    expect(rt.launchCount()).toBe(1);

    await rt.awaitAll();

    const pages = readRegistry(vaultDir).pages;
    expect(pages["concepts/a"]).toBeDefined();
    expect(pages["concepts/b"]).toBeDefined();
    expect(pages["concepts/c"]).toBeDefined();
  });

  it("does not lose a write scheduled after the in-flight pass started", async () => {
    const vaultDir = makeVault(tmpDir);
    const paths = getVaultPaths(vaultDir);
    const rt = new Runtime();

    writePage(vaultDir, "first");
    const p1 = scheduleReindex(rt, CTX, paths);
    writePage(vaultDir, "second");
    scheduleReindex(rt, CTX, paths);
    expect(scheduleReindex(rt, CTX, paths)).toBe(p1); // coalesced into the same pass

    await rt.awaitAll();

    const pages = readRegistry(vaultDir).pages;
    expect(pages["concepts/first"]).toBeDefined();
    expect(pages["concepts/second"]).toBeDefined();
  });

  it("uses a stable per-vault label", () => {
    const paths = getVaultPaths("/some/vault/root");
    expect(indexLabel(paths.root)).toBe("index:/some/vault/root");
  });

  it("is a no-op embedder path that does not throw when none is configured", async () => {
    const vaultDir = makeVault(tmpDir);
    const paths = getVaultPaths(vaultDir);
    const rt = new Runtime();
    writePage(vaultDir, "solo");
    await expect(scheduleReindex(rt, CTX, paths)).resolves.toBeUndefined();
    expect(readRegistry(vaultDir).pages["concepts/solo"]).toBeDefined();
  });
});

describe("saveObservation rebuild opt-out", () => {
  let tmpDir: string;
  let vaultDir: string;

  beforeEach(() => {
    __resetIndexingState();
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `obsopt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    vaultDir = makeVault(tmpDir);
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("rebuilds synchronously by default (backward compatible)", () => {
    const paths = getVaultPaths(vaultDir);
    const r = saveObservation(paths, { title: "Sync One", content: "x", relevance: "low" });
    expect(existsSync(r.pagePath)).toBe(true);
    // registry reflects the page immediately
    const key = `sources/${r.slug}`;
    expect(readRegistry(vaultDir).pages[key]).toBeDefined();
  });

  it("skips the inline rebuild when { rebuild: false }", () => {
    const paths = getVaultPaths(vaultDir);
    const r = saveObservation(
      paths,
      { title: "Async One", content: "x", relevance: "low" },
      { rebuild: false },
    );
    // the page file is written synchronously...
    expect(existsSync(r.pagePath)).toBe(true);
    // ...but the registry was NOT rebuilt inline
    const key = `sources/${r.slug}`;
    expect(readRegistry(vaultDir).pages[key]).toBeUndefined();
  });
});

describe("wiki_observe tool backgrounds its rebuild", () => {
  let tmpDir: string;
  let vaultDir: string;

  beforeEach(() => {
    __resetIndexingState();
    tmpDir = join(
      import.meta.dirname,
      "..",
      "tmp",
      `obstool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    vaultDir = makeVault(tmpDir);
  });
  afterEach(() => {
    __resetIndexingState();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("writes the page synchronously but defers the rebuild to the runtime", async () => {
    const { registerWikiObserve } = await import("../extensions/llm-wiki/lib/observation.js");
    let captured: { execute: (...a: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: (def: unknown) => {
        captured = def as { execute: (...a: unknown[]) => Promise<unknown> };
      },
    } as unknown as ExtensionAPI;
    const rt = new Runtime();

    registerWikiObserve(pi, rt);
    expect(captured).toBeDefined();

    const ctx = { cwd: vaultDir, hasUI: false };
    // Kick off the tool but do NOT await it yet: the execute body runs to
    // completion synchronously (no awaits), so the heavy rebuild must still be
    // pending in the background at this point.
    const pending = captured?.execute(
      "id",
      { title: "Tool Obs", content: "y", relevance: "high" },
      undefined,
      undefined,
      ctx,
    );

    // The registry is not rebuilt on the tool's synchronous stack.
    const beforeKey = Object.keys(readRegistry(vaultDir).pages).find((k) => k.includes("tool-obs"));
    expect(beforeKey).toBeUndefined();

    await pending;
    await rt.awaitAll();

    const afterKey = Object.keys(readRegistry(vaultDir).pages).find((k) => k.includes("tool-obs"));
    expect(afterKey).toBeDefined();
  });
});
