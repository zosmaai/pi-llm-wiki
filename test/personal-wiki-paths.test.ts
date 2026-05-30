import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPersonalWikiPaths,
  getPersonalWikiRoot,
  getVaultPaths,
  migrateDoubledPersonalVault,
} from "../extensions/llm-wiki/lib/utils.js";

/**
 * Regression suite for the doubled-dotdir personal-wiki bug.
 *
 * Before the fix, `getPersonalWikiRoot()` returned `~/.llm-wiki` (the
 * dot-dir itself) while `getVaultPaths(root)` appended ANOTHER `.llm-wiki/`,
 * producing paths like `~/.llm-wiki/.llm-wiki/raw`.
 *
 * After the fix:
 *   - `getPersonalWikiRoot()` returns the PARENT of `.llm-wiki/`.
 *   - `WIKI_HOME` overrides that parent.
 *   - `migrateDoubledPersonalVault()` flattens a vault that was already
 *     written in the broken layout, in-place and idempotently.
 */

describe("getPersonalWikiRoot / getPersonalWikiPaths", () => {
  let savedWikiHome: string | undefined;

  beforeEach(() => {
    savedWikiHome = process.env.WIKI_HOME;
    delete process.env.WIKI_HOME;
  });

  afterEach(() => {
    if (savedWikiHome === undefined) delete process.env.WIKI_HOME;
    else process.env.WIKI_HOME = savedWikiHome;
  });

  it("returns the parent of .llm-wiki, not the dot-dir itself", () => {
    const root = getPersonalWikiRoot();
    // Must not itself end in /.llm-wiki — that would re-create the doubled bug.
    expect(root.endsWith("/.llm-wiki")).toBe(false);
  });

  it("composes vault paths under exactly ONE .llm-wiki segment", () => {
    const paths = getPersonalWikiPaths();
    // dotWiki should be <root>/.llm-wiki, never <root>/.llm-wiki/.llm-wiki.
    expect(paths.dotWiki.endsWith("/.llm-wiki")).toBe(true);
    expect(paths.dotWiki.endsWith("/.llm-wiki/.llm-wiki")).toBe(false);
    expect(paths.raw.endsWith("/.llm-wiki/raw")).toBe(true);
    expect(paths.wiki.endsWith("/.llm-wiki/wiki")).toBe(true);
  });

  it("honours WIKI_HOME as the parent of .llm-wiki", () => {
    process.env.WIKI_HOME = "/tmp/custom-home";
    expect(getPersonalWikiRoot()).toBe("/tmp/custom-home");
    const paths = getPersonalWikiPaths();
    expect(paths.dotWiki).toBe("/tmp/custom-home/.llm-wiki");
    expect(paths.wiki).toBe("/tmp/custom-home/.llm-wiki/wiki");
  });
});

describe("migrateDoubledPersonalVault", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = join(tmpdir(), `llm-wiki-mig-${Math.random().toString(36).slice(2)}`);
    mkdirSync(scratch, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function seedDoubledLayout() {
    // Reproduce the broken layout:
    //   scratch/.llm-wiki/.llm-wiki/config.json
    //   scratch/.llm-wiki/.llm-wiki/wiki/sources/note.md
    //   scratch/.llm-wiki/.llm-wiki/meta/registry.json
    const inner = join(scratch, ".llm-wiki", ".llm-wiki");
    mkdirSync(join(inner, "wiki", "sources"), { recursive: true });
    mkdirSync(join(inner, "meta"), { recursive: true });
    writeFileSync(join(inner, "config.json"), JSON.stringify({ topic: "test" }));
    writeFileSync(join(inner, "wiki", "sources", "note.md"), "# hello");
    writeFileSync(join(inner, "meta", "registry.json"), "{}");
  }

  it("is a no-op when the layout is already correct", () => {
    // Correct layout: scratch/.llm-wiki/config.json (single dot-dir level).
    mkdirSync(join(scratch, ".llm-wiki"), { recursive: true });
    writeFileSync(join(scratch, ".llm-wiki", "config.json"), "{}");

    const result = migrateDoubledPersonalVault(scratch);
    expect(result).toBeNull();
    // Nothing was moved or destroyed.
    expect(existsSync(join(scratch, ".llm-wiki", "config.json"))).toBe(true);
  });

  it("is a no-op when no vault exists at all", () => {
    const result = migrateDoubledPersonalVault(scratch);
    expect(result).toBeNull();
  });

  it("flattens a doubled layout in place", () => {
    seedDoubledLayout();

    const result = migrateDoubledPersonalVault(scratch);
    expect(result).not.toBeNull();
    expect(result?.moved.sort()).toEqual(["config.json", "meta", "wiki"]);
    expect(result?.skipped).toEqual([]);

    // After: only ONE level of .llm-wiki, with all original payload.
    const outer = join(scratch, ".llm-wiki");
    expect(existsSync(join(outer, "config.json"))).toBe(true);
    expect(existsSync(join(outer, "wiki", "sources", "note.md"))).toBe(true);
    expect(existsSync(join(outer, "meta", "registry.json"))).toBe(true);
    // Inner dir is gone.
    expect(existsSync(join(outer, ".llm-wiki"))).toBe(false);
    // Payload is intact byte-for-byte.
    expect(readFileSync(join(outer, "wiki", "sources", "note.md"), "utf-8")).toBe("# hello");
  });

  it("is idempotent — second call is a no-op", () => {
    seedDoubledLayout();
    const first = migrateDoubledPersonalVault(scratch);
    expect(first?.moved.length).toBeGreaterThan(0);
    const second = migrateDoubledPersonalVault(scratch);
    expect(second).toBeNull();
  });

  it("preserves outer entries on collision and leaves inner copy behind", () => {
    seedDoubledLayout();
    // Pre-existing entry at the outer level that would collide.
    writeFileSync(join(scratch, ".llm-wiki", "config.json"), '{"outer":true}');

    const result = migrateDoubledPersonalVault(scratch);
    expect(result?.skipped).toContain("config.json");
    // Outer config preserved untouched.
    expect(readFileSync(join(scratch, ".llm-wiki", "config.json"), "utf-8")).toBe(
      '{"outer":true}',
    );
    // Inner dir kept because not fully drained.
    expect(existsSync(join(scratch, ".llm-wiki", ".llm-wiki"))).toBe(true);
    // Collided inner copy is preserved for the user to resolve.
    expect(
      existsSync(join(scratch, ".llm-wiki", ".llm-wiki", "config.json")),
    ).toBe(true);
    // Non-colliding entries still moved up.
    expect(existsSync(join(scratch, ".llm-wiki", "wiki", "sources", "note.md"))).toBe(true);
    expect(
      existsSync(join(scratch, ".llm-wiki", ".llm-wiki", "wiki")),
    ).toBe(false);
  });

  it("composes a path that getVaultPaths can consume without double-prefixing", () => {
    // The bug surfaced because getVaultPaths appended .llm-wiki/ to a root
    // that already ended in .llm-wiki/. After migration, the parent root
    // composes cleanly: <root>/.llm-wiki/wiki, never <root>/.llm-wiki/.llm-wiki/wiki.
    seedDoubledLayout();
    migrateDoubledPersonalVault(scratch);

    const paths = getVaultPaths(scratch);
    expect(paths.dotWiki).toBe(join(scratch, ".llm-wiki"));
    expect(paths.wiki).toBe(join(scratch, ".llm-wiki", "wiki"));
    // Nothing should resolve under a doubled segment.
    expect(paths.wiki.includes("/.llm-wiki/.llm-wiki/")).toBe(false);
    // And the migrated content is reachable through the standard paths.
    const sources = readdirSync(join(paths.wiki, "sources"));
    expect(sources).toContain("note.md");
  });
});
