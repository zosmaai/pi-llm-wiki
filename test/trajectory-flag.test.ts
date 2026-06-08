import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchWikiLayered } from "../extensions/llm-wiki/lib/recall.js";
import {
  loadTaskConfig,
  persistTaskModel,
  persistTrajectoriesEnabled,
  trajectoriesEnabled,
} from "../extensions/llm-wiki/lib/task-config.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

/**
 * Issue #80: trajectory working-memory is opt-in / default-off, gated at
 * extension-load time via `trajectoriesEnabled(loadTaskConfig(cwd))` — the
 * exact expression index.ts uses to decide whether to register the 3 tools.
 * These tests pin the flag resolution, persistence round-trip, and the
 * lazy-directory tolerance that the default-off footprint depends on.
 */

describe("trajectoriesEnabled (issue #80, default-off polarity)", () => {
  it("defaults to false for undefined / empty config", () => {
    expect(trajectoriesEnabled(undefined)).toBe(false);
    expect(trajectoriesEnabled({})).toBe(false);
  });

  it("is true only for an explicit trajectories: true", () => {
    expect(trajectoriesEnabled({ trajectories: true })).toBe(true);
    expect(trajectoriesEnabled({ trajectories: false })).toBe(false);
  });
});

describe("trajectories flag persistence round-trip", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `trj-flag-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("loadTaskConfig reads trajectories from <cwd>/.pi/settings.json", () => {
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { trajectories: true } }),
    );
    expect(trajectoriesEnabled(loadTaskConfig(tmpDir))).toBe(true);
  });

  it("persistTrajectoriesEnabled(true) then loadTaskConfig resolves enabled", () => {
    persistTrajectoriesEnabled(tmpDir, true);
    expect(trajectoriesEnabled(loadTaskConfig(tmpDir))).toBe(true);
  });

  it("persistTrajectoriesEnabled(false) removes the key (reverts to default-off)", () => {
    persistTrajectoriesEnabled(tmpDir, true);
    persistTrajectoriesEnabled(tmpDir, false);
    expect(trajectoriesEnabled(loadTaskConfig(tmpDir))).toBe(false);
    const settings = JSON.parse(readFileSync(join(tmpDir, ".pi", "settings.json"), "utf-8"));
    expect(settings["llm-wiki"].trajectories).toBeUndefined();
  });

  it("preserves other llm-wiki settings when toggling the flag", () => {
    persistTaskModel(tmpDir, { provider: "anthropic", id: "claude-haiku-4-5" });
    persistTrajectoriesEnabled(tmpDir, true);
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.trajectories).toBe(true);
    expect(cfg.taskModel).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });

    // Turning trajectories off must not clobber the task model.
    persistTrajectoriesEnabled(tmpDir, false);
    expect(loadTaskConfig(tmpDir).taskModel).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
  });
});

describe("lazy-dir tolerance (recall over a vault without trajectory dirs)", () => {
  let tmpDir: string;
  let wikiDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `trj-lazy-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    wikiDir = join(tmpDir, "vault");
    mkdirSync(wikiDir, { recursive: true });
    const paths = getVaultPaths(wikiDir);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Lazy", mode: "personal" }),
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("ensureVaultStructure leaves trajectory dirs uncreated", () => {
    const paths = getVaultPaths(wikiDir);
    expect(existsSync(paths.rawTrajectories)).toBe(false);
    expect(existsSync(join(paths.wiki, "cases"))).toBe(false);
    expect(existsSync(join(paths.wiki, "skills"))).toBe(false);
  });

  it("searchWikiLayered does not throw when wiki/cases & wiki/skills are absent", () => {
    const paths = getVaultPaths(wikiDir);
    // includePersonal=false keeps the test off any machine-local personal vault.
    const results = searchWikiLayered(paths, "anything", 5, 0, false);
    expect(Array.isArray(results)).toBe(true);
  });
});
