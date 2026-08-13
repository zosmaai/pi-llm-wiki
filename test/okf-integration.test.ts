import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../extensions/llm-wiki/index.js";
import { commitSynthesis } from "../extensions/llm-wiki/lib/ingest-worker.js";
import {
  createKnowledgeDocument,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
import { ensureVaultStructure, getVaultPaths, readJson } from "../extensions/llm-wiki/lib/utils.js";

const vaultRoots: string[] = [];
function createVault(config: Record<string, unknown>) {
  const root = join(import.meta.dirname, "..", "tmp", `okf-int-${Date.now()}-${Math.random()}`);
  vaultRoots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), `${JSON.stringify(config)}\n`);
  writeFileSync(join(paths.meta, "events.jsonl"), "");
  return paths;
}
afterEach(() => {
  for (const root of vaultRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeDoc(
  paths: ReturnType<typeof getVaultPaths>,
  doc: ReturnType<typeof createKnowledgeDocument>,
) {
  const fullPath = join(paths.wiki, doc.path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, serializeKnowledgeDocument(doc), "utf8");
}

type RegisteredTool = {
  execute: (...args: unknown[]) => Promise<unknown>;
};
type ExtensionHandler = (...args: unknown[]) => unknown;

function registerFullExtensionHarness(root: string) {
  const handlers = new Map<string, ExtensionHandler[]>();
  const tools = new Map<string, RegisteredTool>();
  const messages: unknown[] = [];
  const pi = {
    on: (name: string, handler: ExtensionHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: RegisteredTool & { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI;

  const registerCwd = process.cwd();
  const registerHome = process.env.WIKI_HOME;
  process.chdir(root);
  process.env.WIKI_HOME = root;
  try {
    extension(pi);
  } finally {
    process.chdir(registerCwd);
    if (registerHome === undefined) Reflect.deleteProperty(process.env, "WIKI_HOME");
    else process.env.WIKI_HOME = registerHome;
  }

  async function atRoot<T>(work: () => Promise<T>): Promise<T> {
    const priorCwd = process.cwd();
    const priorHome = process.env.WIKI_HOME;
    process.chdir(root);
    process.env.WIKI_HOME = root;
    try {
      return await work();
    } finally {
      process.chdir(priorCwd);
      if (priorHome === undefined) Reflect.deleteProperty(process.env, "WIKI_HOME");
      else process.env.WIKI_HOME = priorHome;
    }
  }

  return {
    messages,
    emit: (name: string, event: unknown = {}, ctx: unknown = {}) =>
      atRoot(async () => {
        const results: unknown[] = [];
        for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
        return results;
      }),
    execute: (name: string, params: Record<string, unknown>) =>
      atRoot(async () => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`Tool not registered: ${name}`);
        return tool.execute("test", params, undefined, undefined, {
          cwd: root,
          hasUI: false,
          ui: { setStatus: () => {}, notify: () => {} },
          model: { provider: "test", id: "model" },
          modelRegistry: {
            find: () => undefined,
            getApiKeyAndHeaders: async () => ({ ok: false }),
          },
        });
      }),
  };
}

function collectConceptFiles(wiki: string, directory = wiki): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectConceptFiles(wiki, fullPath));
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const name = entry.name.toLowerCase();
    if (name === "index.md" || name === "log.md") continue;
    files.push(relative(wiki, fullPath).replace(/\\/g, "/"));
  }
  return files.sort();
}

function collectProjectionFiles(paths: ReturnType<typeof getVaultPaths>): string[] {
  const files = [
    "meta/registry.json",
    "meta/backlinks.json",
    "meta/index.md",
    "meta/log.md",
    "wiki/log.md",
  ];
  function indexes(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) indexes(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase() === "index.md") {
        files.push(relative(paths.dotWiki, fullPath).replace(/\\/g, "/"));
      }
    }
  }
  indexes(paths.wiki);
  return [...new Set(files)].sort();
}

function collectDeterministicProjectionFiles(paths: ReturnType<typeof getVaultPaths>): string[] {
  return collectProjectionFiles(paths).filter(
    (file) => file !== "meta/registry.json" && file !== "meta/index.md",
  );
}

function projectionSnapshot(
  paths: ReturnType<typeof getVaultPaths>,
  files: string[],
): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [file, readFileSync(join(paths.dotWiki, file), "utf8")]),
  );
}

describe("OKF integration", () => {
  it("legacy mode dual-reads legacy and OKF pages without generating wiki reserved files", () => {
    const paths = createVault({ knowledge_format: "legacy" });

    // Write a legacy-style page with scalar sources
    writeFileSync(
      join(paths.wiki, "sources/legacy.md"),
      "---\ntype: source\nsources: sources/SRC-1\nsummary: Legacy source\n---\n\nContent.\n",
    );

    // Write an OKF-style page with nested sources
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/okf-concept.md",
        { type: "concept", title: "OKF Concept", description: "Has nested sources" },
        "Body.",
        [{ id: "SRC-1", resource: "/sources/SRC-1.md" }],
      ),
    );

    rebuildMetadata(paths);

    // Both pages in registry
    const registry = readJson<{ pages: Record<string, unknown> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    expect(registry.pages["sources/legacy"]).toBeTruthy();
    expect(registry.pages["concepts/okf-concept"]).toBeTruthy();

    // No wiki reserved files generated in legacy mode
    expect(() => readFileSync(join(paths.wiki, "index.md"), "utf8")).toThrow();
    expect(() => readFileSync(join(paths.wiki, "log.md"), "utf8")).toThrow();
  });

  it("OKF mode generates reserved files and supports unknown types", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });

    // Write a page with unknown type
    writeDoc(
      paths,
      createKnowledgeDocument(
        "foreign/thing.md",
        { type: "Foreign Concept", title: "Unknown Type" },
        "Body.",
      ),
    );

    rebuildMetadata(paths);

    // Reserved files exist
    expect(readFileSync(join(paths.wiki, "index.md"), "utf8")).toContain('okf_version: "0.2"');
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toContain("Wiki Update Log");

    // Unknown type preserved
    const registry = readJson<{ pages: Record<string, { type: string }> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    expect(registry.pages["foreign/thing"].type).toBe("Foreign Concept");
  });

  it("okf_version_mismatch blocks rebuild but ordinary recall still returns parseable concepts", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/good.md",
        { type: "concept", title: "Good Concept", description: "Parseable" },
        "Body.",
      ),
    );

    rebuildMetadata(paths);

    // Corrupt root index with unsupported version
    writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');

    const result = rebuildMetadata(paths);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBe("okf_version_mismatch");

    // But the concept file is still parseable
    const content = readFileSync(join(paths.wiki, "concepts/good.md"), "utf8");
    const parsed = parseKnowledgeDocument(content, "concepts/good.md");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.frontmatter.title).toBe("Good Concept");
    }
  });

  it("foundation acceptance: production seams preserve a conformant OKF vault", async () => {
    const root = join(import.meta.dirname, "..", "tmp", `okf-acceptance-${Date.now()}`);
    vaultRoots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "okf-acceptance", version: "1.0.0", description: "Acceptance" }),
    );
    const harness = registerFullExtensionHarness(root);

    await harness.emit(
      "session_start",
      {},
      {
        cwd: root,
        hasUI: true,
        ui: { setStatus: () => {}, notify: () => {} },
        model: { id: "test" },
      },
    );
    const paths = getVaultPaths(root);
    const config = readJson<Record<string, unknown>>(join(paths.dotWiki, "config.json"), {});
    expect(config.knowledge_format).toBe("okf-0.2");
    const agentStartResults = await harness.emit(
      "before_agent_start",
      { prompt: "Build the Foundation feature", systemPrompt: "base" },
      { cwd: root, hasUI: false, model: { id: "test" } },
    );
    expect(JSON.stringify(agentStartResults)).toContain("Wiki Setup Required");
    await harness.emit(
      "before_agent_start",
      { prompt: "", systemPrompt: "base" },
      { cwd: root, hasUI: false, model: { id: "test" } },
    );

    await harness.execute("wiki_capture_source", {
      text: "Foundation source content.",
      title: "Foundation Source",
    });
    await harness.emit("session_shutdown");
    const sourceId = readdirSync(paths.rawSources).find((name) => name.startsWith("SRC-"));
    expect(sourceId).toBeDefined();
    if (!sourceId) return;
    const manifest = readJson<Record<string, unknown>>(
      join(paths.rawSources, sourceId, "manifest.json"),
      {},
    );
    const ingest = commitSynthesis(
      paths,
      sourceId,
      manifest,
      {
        summary: "Foundation summary.",
        key_takeaways: ["Foundation takeaway"],
        entities: [{ title: "Foundation Entity", description: "Entity description" }],
        concepts: [{ title: "Foundation Concept", definition: "Concept definition" }],
      },
      "2026-08-03",
    );
    expect(ingest.ok).toBe(true);

    await harness.execute("wiki_observe", {
      title: "Foundation observation",
      content: "Observation body.",
      relevance: "medium",
    });
    await harness.execute("wiki_retro", {
      slug: "foundation-insight",
      title: "Foundation Insight",
      body: "Insight body.",
    });
    await harness.execute("wiki_ensure_page", {
      type: "requirement",
      title: "Foundation Requirement",
      content: "Requirement body.",
    });
    await harness.emit("session_shutdown");
    const recalled = await harness.emit(
      "before_agent_start",
      { prompt: "Foundation Requirement", systemPrompt: "base" },
      { cwd: root, hasUI: true, ui: { setStatus: () => {} }, model: { id: "test" } },
    );
    expect(JSON.stringify(recalled)).toContain("Foundation Requirement");

    const manualPage = join(paths.wiki, "concepts", "legacy-link.md");
    const eventPath = join(paths.meta, "events.jsonl");
    const eventsBeforeManual = readFileSync(eventPath, "utf8");
    writeFileSync(
      manualPage,
      "---\ntype: concept\ntitle: Legacy Link\n---\n\n[[sources/foundation-insight]]\n",
    );
    await harness.emit("tool_result", { toolName: "write", input: { path: manualPage } });
    await harness.emit("turn_end", {}, { cwd: root, hasUI: false });
    await harness.emit("session_shutdown");
    const registryAfterManual = readJson<{ pages: Record<string, unknown> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    expect(registryAfterManual.pages["concepts/legacy-link"]).toBeDefined();
    expect(readFileSync(eventPath, "utf8")).toBe(eventsBeforeManual);

    const conceptFiles = collectConceptFiles(paths.wiki);
    for (const file of conceptFiles) {
      const parsed = parseKnowledgeDocument(readFileSync(join(paths.wiki, file), "utf8"), file);
      expect(parsed.ok, file).toBe(true);
    }

    for (const file of ["entities/foundation-entity.md", "concepts/foundation-concept.md"]) {
      const parsed = parseKnowledgeDocument(readFileSync(join(paths.wiki, file), "utf8"), file);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.document.sources.kind).toBe("canonical");
    }
    const source = parseKnowledgeDocument(
      readFileSync(join(paths.wiki, "sources", `${sourceId}.md`), "utf8"),
      `sources/${sourceId}.md`,
    );
    expect(source.ok).toBe(true);
    if (source.ok) expect(source.document.sources.kind).toBe("absent");

    const backlinks = readJson<Record<string, string[]>>(join(paths.meta, "backlinks.json"), {});
    expect(backlinks["sources/foundation-insight"]).toContain("concepts/legacy-link");

    const projectionFiles = collectProjectionFiles(paths);
    const deterministicFiles = collectDeterministicProjectionFiles(paths);
    const deterministic = projectionSnapshot(paths, deterministicFiles);
    expect(rebuildMetadata(paths).ok).toBe(true);
    expect(projectionSnapshot(paths, deterministicFiles)).toEqual(deterministic);
    const knownGood = projectionSnapshot(paths, projectionFiles);

    const corrupt = join(paths.wiki, "concepts", "foundation-concept.md");
    const original = readFileSync(corrupt, "utf8");
    writeFileSync(corrupt, "malformed\n");
    await harness.emit("tool_result", { toolName: "edit", input: { path: corrupt } });
    await harness.emit("turn_end", {}, { cwd: root, hasUI: false });
    await harness.emit("session_shutdown");
    expect(projectionSnapshot(paths, projectionFiles)).toEqual(knownGood);
    expect(readFileSync(eventPath, "utf8")).toBe(eventsBeforeManual);

    writeFileSync(corrupt, original);
    await harness.emit("tool_result", { toolName: "write", input: { path: corrupt } });
    await harness.emit("turn_end", {}, { cwd: root, hasUI: false });
    await harness.emit("session_shutdown");
    expect(
      readJson<{ pages: Record<string, unknown> }>(join(paths.meta, "registry.json"), { pages: {} })
        .pages["concepts/foundation-concept"],
    ).toBeDefined();
  });

  it("skips before-agent recall when no vault exists", async () => {
    const root = join(import.meta.dirname, "..", "tmp", `okf-no-vault-${Date.now()}`);
    vaultRoots.push(root);
    mkdirSync(root, { recursive: true });
    const harness = registerFullExtensionHarness(root);
    const result = await harness.emit(
      "before_agent_start",
      { prompt: "anything", systemPrompt: "base" },
      { cwd: root, hasUI: false, model: { id: "test" } },
    );
    expect(result).toEqual([undefined]);
  });

  it("opens an existing valid vault without bootstrapping it again", async () => {
    const root = join(import.meta.dirname, "..", "tmp", `okf-existing-${Date.now()}`);
    vaultRoots.push(root);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    const config = JSON.stringify({ name: "Existing", knowledge_format: "legacy" });
    writeFileSync(join(paths.dotWiki, "config.json"), config);
    const statuses: string[] = [];
    const harness = registerFullExtensionHarness(root);
    await harness.emit(
      "session_start",
      {},
      {
        cwd: root,
        hasUI: true,
        ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
        model: { id: "test" },
      },
    );
    expect(readFileSync(join(paths.dotWiki, "config.json"), "utf8")).toBe(config);
    expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
    expect(statuses.some((status) => status.includes("setup blocked"))).toBe(false);
    expect(harness.messages.length).toBeGreaterThan(0);
    // Drain the fire-and-forget qmd-recovery task before the vault is removed
    // in teardown; otherwise it warns about the deleted index directory.
    await harness.emit("session_shutdown");
  });

  it("blocks an existing invalid vault before status notices or lifecycle writes", async () => {
    const root = join(import.meta.dirname, "..", "tmp", `okf-blocked-${Date.now()}`);
    vaultRoots.push(root);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    const config = JSON.stringify({ knowledge_format: "future" });
    writeFileSync(join(paths.dotWiki, "config.json"), config);
    const statuses: string[] = [];
    const harness = registerFullExtensionHarness(root);
    await harness.emit(
      "session_start",
      {},
      {
        cwd: root,
        hasUI: true,
        ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
        model: { id: "test" },
      },
    );
    expect(statuses.some((status) => status.includes("setup blocked"))).toBe(true);
    expect(harness.messages).toEqual([]);
    expect(readFileSync(join(paths.dotWiki, "config.json"), "utf8")).toBe(config);
    expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
    await harness.emit("session_shutdown");
  });

  it("does not warn about QMD recovery when shutdown drains before teardown", async () => {
    const root = join(import.meta.dirname, "..", "tmp", `okf-drain-${Date.now()}`);
    vaultRoots.push(root);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Drain" }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const harness = registerFullExtensionHarness(root);
      await harness.emit(
        "session_start",
        {},
        { cwd: root, hasUI: true, ui: { setStatus: () => {} }, model: { id: "test" } },
      );
      await harness.emit("session_shutdown");
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("QMD index recovery failed"))).toBe(false);
  });

  it("only registers Foundation-required tools", () => {
    // Verify no speculative tools beyond the Foundation spec
    const libDir = join(import.meta.dirname, "..", "extensions", "llm-wiki", "lib");
    const toolFiles = ["tools.ts", "recall.ts", "observation.ts", "retro.ts"];
    let allSource = "";
    for (const file of toolFiles) {
      allSource += `${readFileSync(join(libDir, file), "utf8")}\n`;
    }
    const registeredTools = [...allSource.matchAll(/name:\s*"(wiki_[^"]+)"/g)].map((m) => m[1]);

    // Foundation-required tools
    const required = [
      "wiki_bootstrap",
      "wiki_recall",
      "wiki_search",
      "wiki_status",
      "wiki_observe",
      "wiki_retro",
      "wiki_capture_source",
      "wiki_ensure_page",
      "wiki_lint",
      "wiki_rebuild_meta",
      "wiki_log_event",
      "wiki_reindex_embeddings",
    ];

    for (const tool of required) {
      expect(registeredTools).toContain(tool);
    }

    // No speculative tools
    const forbidden = [
      "wiki_import",
      "wiki_export",
      "wiki_migrate",
      "wiki_trust",
      "wiki_score",
      "wiki_validate",
      "wiki_diff",
    ];
    for (const tool of forbidden) {
      expect(registeredTools).not.toContain(tool);
    }
  });
});
