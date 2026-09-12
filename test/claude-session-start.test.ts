import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { rootDir } from "./helpers.js";

const script = join(rootDir, "scripts", "claude-session-start.mjs");
const temporaryRoots: string[] = [];

function createVault(): string {
  mkdirSync(join(rootDir, "tmp"), { recursive: true });
  const root = mkdtempSync(join(rootDir, "tmp", "claude-session-"));
  temporaryRoots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ mode: "personal" }));
  mkdirSync(join(paths.rawSources, "SRC-2026-09-11-001"), { recursive: true });
  writeFileSync(
    join(paths.meta, "registry.json"),
    JSON.stringify({
      pages: {
        "sources/SRC-2026-09-11-001": { type: "source", status: "skeleton" },
        "entities/test-entity": { type: "entity", status: "active" },
      },
    }),
  );
  return root;
}

function runHook(input: Record<string, unknown>, overrides: Record<string, string> = {}): string {
  const env = { ...process.env };
  delete env.WIKI_ROOT;
  delete env.WIKI_HOME;
  delete env.LLM_WIKI_NOTICES;
  Object.assign(env, overrides);
  return execFileSync(process.execPath, [script], {
    cwd: String(input.cwd ?? rootDir),
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("emits SessionStart additionalContext with page and pending counts", () => {
  const root = createVault();
  const output = JSON.parse(runHook({ cwd: root, source: "startup" }));
  expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(output.hookSpecificOutput.additionalContext).toContain("Indexed pages: 2");
  expect(output.hookSpecificOutput.additionalContext).toContain("Pending source packets: 1");
});

it("honors an explicit WIKI_ROOT override", () => {
  const root = createVault();
  const empty = mkdtempSync(join(rootDir, "tmp", "claude-session-override-"));
  temporaryRoots.push(empty);
  const output = JSON.parse(runHook({ cwd: empty, source: "startup" }, { WIKI_ROOT: root }));
  expect(output.hookSpecificOutput.additionalContext).toContain(`LLM Wiki active at ${root}`);
});

it("does not treat WIKI_HOME as a project vault", () => {
  const sandbox = mkdtempSync(join(rootDir, "tmp", "claude-session-personal-"));
  temporaryRoots.push(sandbox);
  const personal = join(sandbox, "home", "personal");
  const project = join(personal, "projects", "empty");
  mkdirSync(join(personal, ".llm-wiki"), { recursive: true });
  writeFileSync(join(personal, ".llm-wiki", "config.json"), "{}");
  mkdirSync(project, { recursive: true });
  expect(runHook({ cwd: project, source: "startup" }, { WIKI_HOME: personal })).toBe("");
});

it("keeps notice and process switches independently testable", () => {
  const active = createVault();
  mkdirSync(join(active, ".pi"), { recursive: true });
  writeFileSync(
    join(active, ".pi", "settings.json"),
    JSON.stringify({ "llm-wiki": { notices: false } }),
  );
  expect(runHook({ cwd: active, source: "startup" }, { LLM_WIKI_NOTICES: "1" })).toBe("");

  writeFileSync(
    join(active, ".pi", "settings.json"),
    JSON.stringify({ "llm-wiki": { notices: true } }),
  );
  expect(runHook({ cwd: active, source: "startup" }, { LLM_WIKI_NOTICES: "0" })).toBe("");
});

it("is silent for no vault, malformed input, and null input", () => {
  const empty = mkdtempSync(join(rootDir, "tmp", "claude-session-empty-"));
  temporaryRoots.push(empty);
  expect(runHook({ cwd: empty, source: "startup" })).toBe("");
  expect(execFileSync(process.execPath, [script], { input: "not-json", encoding: "utf8" })).toBe(
    "",
  );
  expect(execFileSync(process.execPath, [script], { input: "null", encoding: "utf8" })).toBe("");
});

it("uses empty counts for a malformed registry", () => {
  const root = createVault();
  writeFileSync(join(root, ".llm-wiki", "meta", "registry.json"), "[]");
  const output = JSON.parse(runHook({ cwd: root, source: "startup" }));
  expect(output.hookSpecificOutput.additionalContext).toContain("Indexed pages: 0");
});
