import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../extensions/llm-wiki/index.js";
import { bootstrapVault } from "../extensions/llm-wiki/lib/bootstrap.js";
import { getVaultPaths, resolveVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
const originalCwd = process.cwd();
const originalWikiHome = process.env.WIKI_HOME;
afterEach(() => {
  process.chdir(originalCwd);
  // biome-ignore lint/performance/noDelete: restore an originally absent variable
  if (originalWikiHome === undefined) delete process.env.WIKI_HOME;
  else process.env.WIKI_HOME = originalWikiHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root() {
  const value = join(import.meta.dirname, "..", "tmp", `bootstrap-${Date.now()}-${Math.random()}`);
  roots.push(value);
  return value;
}

function extensionHarness() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  extension(pi);
  return { handlers, tools };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("bootstrap", () => {
  it("creates a stable vault_id and QMD paths", () => {
    const paths = getVaultPaths(root());
    const first = bootstrapVault(paths, { topic: "Identity", mode: "personal" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstConfig = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
    expect(firstConfig.vault_id).toMatch(UUID);

    bootstrapVault(paths, { topic: "Renamed", mode: "personal" });
    const secondConfig = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
    expect(secondConfig.vault_id).toBe(firstConfig.vault_id);

    expect(paths.qmd).toBe(join(paths.meta, "qmd"));
    expect(paths.qmdCurrent).toBe(join(paths.meta, "qmd", "current"));
    expect(paths.qmdDocuments).toBe(join(paths.meta, "qmd", "documents"));
    expect(paths.qmdManifest).toBe(join(paths.meta, "qmd", "manifest.json"));
    expect(paths.qmdSwap).toBe(join(paths.meta, "qmd", "swap.json"));
  });

  it("silently bootstraps an OKF vault through the real session seam", async () => {
    const cwd = root();
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);
    process.env.WIKI_HOME = cwd;
    expect(resolveVaultPaths(cwd).root).toBe(cwd);
    const { handlers } = extensionHarness();
    const sessionStart = handlers.get("session_start")?.at(-1);
    expect(sessionStart).toBeDefined();
    await sessionStart?.(
      {},
      {
        cwd,
        hasUI: true,
        ui: { setStatus: () => {} },
        model: { id: "test" },
      },
    );
    const paths = getVaultPaths(cwd);
    expect(resolveVaultPaths(cwd).root).toBe(cwd);
    const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
    expect(config.knowledge_format).toBe("okf-0.2");
    expect(readFileSync(join(paths.wiki, "index.md"), "utf8")).toContain('okf_version: "0.2"');
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toContain("bootstrap");

    const schema = readFileSync(join(paths.dotWiki, "WIKI_SCHEMA.md"), "utf8");
    expect(schema).toContain(
      "meta/events.jsonl | extension tools | append-only authoritative state",
    );
    expect(schema).toContain("meta/* except events.jsonl | extension | generated projections");
    expect(schema).toContain("Back up `meta/events.jsonl` to preserve activity history");
  });

  it("blocks a damaged project vault instead of falling back to personal wiki", async () => {
    const cwd = root();
    const paths = getVaultPaths(cwd);
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(join(paths.wiki, "concepts", "bad.md"), "malformed\n");
    process.chdir(cwd);
    Reflect.deleteProperty(process.env, "WIKI_HOME");
    expect(resolveVaultPaths(cwd).root).toBe(cwd);
    const { handlers } = extensionHarness();
    const statuses: string[] = [];
    const sessionStart = handlers.get("session_start")?.at(-1);
    await sessionStart?.(
      {},
      {
        cwd,
        hasUI: true,
        ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
        model: { id: "test" },
      },
    );
    expect(statuses.some((status) => status.includes("setup blocked"))).toBe(true);
    expect(existsSync(join(paths.dotWiki, "config.json"))).toBe(false);
  });

  it("blocks an existing invalid vault during real session startup", async () => {
    const cwd = root();
    const paths = getVaultPaths(cwd);
    mkdirSync(paths.dotWiki, { recursive: true });
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ knowledge_format: "future" }),
    );
    process.chdir(cwd);
    process.env.WIKI_HOME = cwd;
    expect(resolveVaultPaths(cwd).root).toBe(cwd);
    const { handlers } = extensionHarness();
    const statuses: string[] = [];
    const sessionStart = handlers.get("session_start")?.at(-1);
    await sessionStart?.(
      {},
      {
        cwd,
        hasUI: true,
        ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
        model: { id: "test" },
      },
    );
    expect(statuses.some((status) => status.includes("setup blocked"))).toBe(true);
    expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
  });

  it("preserves an old vault's missing mode field during explicit bootstrap", () => {
    const cwd = root();
    const paths = getVaultPaths(cwd);
    mkdirSync(paths.dotWiki, { recursive: true });
    writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Old" }));
    const result = bootstrapVault(paths, { topic: "Updated", mode: "personal" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.ok).toBe(true);
    const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
    expect(Object.hasOwn(config, "knowledge_format")).toBe(false);
    expect(existsSync(join(paths.wiki, "index.md"))).toBe(false);
    expect(existsSync(join(paths.wiki, "log.md"))).toBe(false);
  });

  it("does not bootstrap an existing vault when config is missing", () => {
    const cwd = root();
    const paths = getVaultPaths(cwd);
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(join(paths.wiki, "concepts", "bad.md"), "malformed\n");
    const result = bootstrapVault(paths, { topic: "Do not write", mode: "personal" });
    expect(result.ok).toBe(false);
    expect(existsSync(join(paths.dotWiki, "config.json"))).toBe(false);
    expect(existsSync(join(paths.dotWiki, "WIKI_SCHEMA.md"))).toBe(false);
    expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
  });

  it("does not mutate an existing malformed vault during bootstrap", () => {
    const cwd = root();
    const paths = getVaultPaths(cwd);
    mkdirSync(paths.dotWiki, { recursive: true });
    const configPath = join(paths.dotWiki, "config.json");
    writeFileSync(configPath, "{broken");
    const before = readFileSync(configPath, "utf8");
    const result = bootstrapVault(paths, { topic: "Do not write", mode: "personal" });
    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(existsSync(join(paths.dotWiki, "WIKI_SCHEMA.md"))).toBe(false);
    expect(existsSync(paths.meta)).toBe(false);
  });
});
