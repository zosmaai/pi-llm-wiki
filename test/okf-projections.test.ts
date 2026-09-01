import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../extensions/llm-wiki/lib/knowledge-document.js";
import {
  appendEvent,
  buildDirectoryIndexes,
  buildOkfLog,
  rebuildMetadata,
} from "../extensions/llm-wiki/lib/metadata.js";
import { registerWikiLogEvent } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

function readFixture(rel: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", "okf", rel), "utf8");
}

// Temp vault helpers for rebuild integration tests
const vaultRoots: string[] = [];
function createVault(config: Record<string, unknown>) {
  const root = join(import.meta.dirname, "..", "tmp", `okf-${Date.now()}-${Math.random()}`);
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

function snapshot(
  paths: ReturnType<typeof getVaultPaths>,
  files: string[],
): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => {
      const fullPath = join(paths.dotWiki, file);
      try {
        return [file, readFileSync(fullPath, "utf8")];
      } catch {
        return [file, "<missing>"];
      }
    }),
  );
}

function writeDoc(
  paths: ReturnType<typeof getVaultPaths>,
  doc: ReturnType<typeof createKnowledgeDocument>,
) {
  const fullPath = join(paths.wiki, doc.path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, serializeKnowledgeDocument(doc), "utf8");
}

type TestTool = {
  execute: (...args: unknown[]) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
  }>;
};
describe("OKF projections", () => {
  it("renders empty bundle root index", () => {
    const indexes = buildDirectoryIndexes([], { name: "" });
    expect(indexes.get("index.md")).toBe('---\nokf_version: "0.2"\n---\n\n# Wiki\n');
  });

  it("renders root and subdirectory indexes with correct structure", () => {
    const docs = [
      createKnowledgeDocument(
        "welcome.md",
        { type: "concept", title: "Welcome", description: "Entry point." },
        "Body.",
      ),
      createKnowledgeDocument(
        "concepts/retrieval augmented.md",
        { type: "concept", title: "RAG [safe]", description: "Grounds generation using evidence." },
        "Body.",
      ),
      createKnowledgeDocument(
        "concepts/nested/deep.md",
        { type: "concept", title: "Deep", description: "Deep concept." },
        "Body.",
      ),
    ];

    const indexes = buildDirectoryIndexes(docs, { name: "Example Wiki" });

    expect([...indexes.keys()].sort()).toEqual([
      "concepts/index.md",
      "concepts/nested/index.md",
      "index.md",
    ]);

    expect(indexes.get("index.md")).toBe(readFixture("indexes/root.md"));
    expect(indexes.get("concepts/index.md")).toBe(readFixture("indexes/concepts.md"));
  });

  it("renders directory indexes deterministically independent of input order", () => {
    const docs = [
      createKnowledgeDocument(
        "concepts/nested/deep.md",
        { type: "concept", title: "Deep", description: "Deep concept." },
        "Body.",
      ),
      createKnowledgeDocument(
        "concepts/retrieval augmented.md",
        { type: "concept", title: "RAG [safe]", description: "Grounds generation using evidence." },
        "Body.",
      ),
      createKnowledgeDocument(
        "welcome.md",
        { type: "concept", title: "Welcome", description: "Entry point." },
        "Body.",
      ),
    ];

    const indexes = buildDirectoryIndexes(docs, { name: "Example Wiki" });
    expect(indexes.get("index.md")).toBe(readFixture("indexes/root.md"));
    expect(indexes.get("concepts/index.md")).toBe(readFixture("indexes/concepts.md"));
  });

  it("renders deterministic log from events", () => {
    const eventsJsonl = readFixture("logs/events.jsonl");
    const log = buildOkfLog(eventsJsonl);
    expect(log.markdown).toBe(readFixture("logs/log.md"));
    expect(log.diagnostics.map((d) => d.code).sort()).toEqual([
      "event_invalid_json",
      "event_invalid_timestamp",
    ]);
  });

  it("renders log deterministically independent of object key order", () => {
    const events = [
      JSON.stringify({
        timestamp: "2026-08-01T22:00:00.000Z",
        kind: "capture",
        a: { a: 1, z: 2 },
        z: 1,
      }),
    ].join("\n");
    const log = buildOkfLog(events);
    expect(log.markdown).toContain('{"a":{"a":1,"z":2},"z":1}');
  });

  it("renders empty log header for no events", () => {
    const log = buildOkfLog("");
    expect(log.markdown).toBe("# Wiki Update Log\n");
    expect(log.diagnostics).toEqual([]);
  });

  it("sorts valid offset timestamps by instant and returns malformed-event diagnostics", () => {
    const result = buildOkfLog(
      [
        '{"timestamp":"2026-08-02T13:30:00Z","kind":"earlier"}',
        '{"timestamp":"2026-08-02T09:00:00-05:00","kind":"later"}',
        "not-json",
      ].join("\n"),
    );
    expect(result.markdown.indexOf("later")).toBeLessThan(result.markdown.indexOf("earlier"));
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("event_invalid_json");
  });
});

describe("OKF rebuild integration", () => {
  it.each([
    ["legacy", false],
    ["okf-0.2", true],
  ] as const)(
    "includes non-blocking event diagnostics in %s projection results",
    (knowledgeFormat, publishesOkfLog) => {
      const paths = createVault({ knowledge_format: knowledgeFormat });
      writeFileSync(join(paths.meta, "events.jsonl"), "not-json\n");
      const result = rebuildMetadata(paths);
      expect(result.ok).toBe(true);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "event_invalid_json",
      );
      expect(existsSync(join(paths.wiki, "log.md"))).toBe(publishesOkfLog);
    },
  );

  it("does not allow event details to override trusted timestamp or kind", () => {
    const paths = createVault({ knowledge_format: "legacy" });
    appendEvent(paths, { kind: "trusted", timestamp: "forged", extra: 1 } as never);
    const event = JSON.parse(readFileSync(join(paths.meta, "events.jsonl"), "utf8"));
    expect(event.kind).toBe("trusted");
    expect(event.timestamp).not.toBe("forged");
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
  });

  it("rejects empty or reserved manual-event input at the Pi tool boundary", async () => {
    const paths = createVault({ knowledge_format: "legacy" });
    let tool: TestTool | undefined;
    registerWikiLogEvent({
      registerTool: (definition: unknown) => {
        tool = definition as TestTool;
      },
    } as unknown as ExtensionAPI);
    if (!tool) throw new Error("wiki_log_event was not registered");
    for (const params of [
      { kind: "   " },
      { kind: "safe", details: { timestamp: "forged" } },
      { kind: "safe", details: { kind: "forged" } },
    ]) {
      const result = await tool.execute("test", params, undefined, undefined, {
        cwd: paths.root,
        hasUI: false,
      });
      expect(result.isError).toBe(true);
    }
    // events.jsonl exists as empty (from createVault); verify no events were written
    expect(readFileSync(join(paths.meta, "events.jsonl"), "utf8")).toBe("");
  });

  it("legacy mode builds only meta/ projections and leaves wiki/index.md and wiki/log.md unchanged", () => {
    const paths = createVault({ knowledge_format: "legacy" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/test.md", { type: "concept", title: "Test" }, "Body."),
    );
    writeFileSync(join(paths.wiki, "index.md"), "user root index");
    writeFileSync(join(paths.wiki, "log.md"), "user log");

    rebuildMetadata(paths);

    // meta/ projections exist
    expect(readFileSync(join(paths.meta, "registry.json"), "utf8")).toContain("test");
    expect(readFileSync(join(paths.meta, "backlinks.json"), "utf8")).toContain("test");

    // wiki/ files unchanged
    expect(readFileSync(join(paths.wiki, "index.md"), "utf8")).toBe("user root index");
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toBe("user log");
  });

  it("OKF mode builds root/subdirectory indexes and root log, then prunes obsolete indexes", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/nested/deep.md",
        { type: "concept", title: "Deep" },
        "Body.",
      ),
    );
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/rag.md", { type: "concept", title: "RAG" }, "Body."),
    );

    rebuildMetadata(paths);
    expect(readFileSync(join(paths.wiki, "index.md"), "utf8")).toContain('okf_version: "0.2"');
    expect(readFileSync(join(paths.wiki, "concepts/index.md"), "utf8")).toContain("## Directories");
    expect(readFileSync(join(paths.wiki, "concepts/nested/index.md"), "utf8")).toContain("Deep");

    // Delete nested concept and rebuild
    rmSync(join(paths.wiki, "concepts/nested/deep.md"));
    rebuildMetadata(paths);
    // Obsolete nested index pruned; concepts/index.md no longer lists nested/
    expect(readFileSync(join(paths.wiki, "concepts/index.md"), "utf8")).not.toContain("nested/");
    expect(() => readFileSync(join(paths.wiki, "concepts/nested/index.md"), "utf8")).toThrow();
  });

  it("does not prune indexes through symlinked directories", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/good.md", { type: "concept", title: "Good" }, "Body."),
    );
    const outside = join(paths.root, "outside");
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, "index.md");
    writeFileSync(victim, "outside-owned");
    symlinkSync(outside, join(paths.wiki, "linked"), "dir");
    symlinkSync(paths.wiki, join(paths.wiki, "loop"), "dir");

    expect(rebuildMetadata(paths).ok).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("outside-owned");
  });

  it("treats valid JSON primitives and containers as non-blocking event diagnostics", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeFileSync(
      join(paths.meta, "events.jsonl"),
      ["null", "true", "1", '"text"', "[]"].join("\n"),
    );

    expect(() => rebuildMetadata(paths)).not.toThrow();
    const result = rebuildMetadata(paths);
    expect(result.ok).toBe(true);
    expect(
      result.diagnostics.filter((diagnostic) => diagnostic.code === "event_invalid_json"),
    ).toHaveLength(5);
  });

  it("merges Markdown and wikilink edges and stores only known targets", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/a.md", { type: "concept", title: "A" }, "Body."),
    );
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/b.md",
        { type: "concept", title: "B", description: "Links to A" },
        "[link](/concepts/a.md) [[concepts/a]]",
      ),
    );

    rebuildMetadata(paths);
    const backlinks = JSON.parse(readFileSync(join(paths.meta, "backlinks.json"), "utf8"));
    expect(backlinks["concepts/a"]).toEqual(["concepts/b"]);
  });

  it("malformed concept after successful generation leaves all previous projections byte-identical", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/good.md", { type: "concept", title: "Good" }, "Body."),
    );

    rebuildMetadata(paths);
    const before = snapshot(paths, [
      "meta/registry.json",
      "meta/backlinks.json",
      "meta/index.md",
      "meta/log.md",
      "wiki/index.md",
      "wiki/log.md",
    ]);

    // Write malformed concept
    writeFileSync(
      join(paths.wiki, "concepts/bad.md"),
      "---\ntype: concept\ntype: duplicate\n---\n",
    );

    rebuildMetadata(paths);
    const after = snapshot(paths, [
      "meta/registry.json",
      "meta/backlinks.json",
      "meta/index.md",
      "meta/log.md",
      "wiki/index.md",
      "wiki/log.md",
    ]);

    // All projections unchanged
    expect(after).toEqual(before);
  });

  it("unsupported OKF root version blocks rebuild and leaves all previous projections byte-identical", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/good.md", { type: "concept", title: "Good" }, "Body."),
    );

    rebuildMetadata(paths);
    const beforeRegistry = JSON.parse(readFileSync(join(paths.meta, "registry.json"), "utf8"));
    const beforeBacklinks = JSON.parse(readFileSync(join(paths.meta, "backlinks.json"), "utf8"));
    const beforeWikiLog = readFileSync(join(paths.wiki, "log.md"), "utf8");

    // Corrupt root index with unsupported version
    writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');

    const result = rebuildMetadata(paths);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBe("okf_version_mismatch");

    // All projections unchanged
    const afterRegistry = JSON.parse(readFileSync(join(paths.meta, "registry.json"), "utf8"));
    const afterBacklinks = JSON.parse(readFileSync(join(paths.meta, "backlinks.json"), "utf8"));
    const afterWikiIndex = readFileSync(join(paths.wiki, "index.md"), "utf8");
    const afterWikiLog = readFileSync(join(paths.wiki, "log.md"), "utf8");

    expect(afterRegistry.pages).toEqual(beforeRegistry.pages);
    expect(afterBacklinks).toEqual(beforeBacklinks);
    // Corrupted index preserved (not overwritten)
    expect(afterWikiIndex).toContain('okf_version: "0.3"');
    expect(afterWikiLog).toEqual(beforeWikiLog);
  });

  it("invalid explicit config mode leaves all previous projections byte-identical", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/good.md", { type: "concept", title: "Good" }, "Body."),
    );

    rebuildMetadata(paths);
    const before = snapshot(paths, [
      "meta/registry.json",
      "meta/backlinks.json",
      "wiki/index.md",
      "wiki/log.md",
    ]);

    // Set invalid mode
    writeFileSync(join(paths.dotWiki, "config.json"), '{"knowledge_format": "invalid"}\n');

    rebuildMetadata(paths);
    const after = snapshot(paths, [
      "meta/registry.json",
      "meta/backlinks.json",
      "wiki/index.md",
      "wiki/log.md",
    ]);

    expect(after).toEqual(before);
  });

  it("unresolved link and malformed event line publish valid projections with non-blocking diagnostics", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/a.md",
        { type: "concept", title: "A", description: "Links to missing" },
        "[missing](missing.md)",
      ),
    );
    // Write events with a malformed line
    writeFileSync(
      join(paths.meta, "events.jsonl"),
      '{"timestamp":"2026-01-01T00:00:00.000Z","kind":"test"}\nnot json\n',
    );

    rebuildMetadata(paths);

    // Projections still published - root index has directories, concepts index has the concept
    expect(readFileSync(join(paths.wiki, "index.md"), "utf8")).toContain("concepts/");
    expect(readFileSync(join(paths.wiki, "concepts/index.md"), "utf8")).toContain("A");
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toContain("test");
  });

  it("no *.tmp-* files remain after success", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/a.md", { type: "concept", title: "A" }, "Body."),
    );

    rebuildMetadata(paths);

    function findTmp(dir: string): string[] {
      const results: string[] = [];
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        if (entry.includes(".tmp-")) results.push(fullPath);
        else if (statSync(fullPath).isDirectory()) results.push(...findTmp(fullPath));
      }
      return results;
    }
    expect(findTmp(paths.dotWiki)).toEqual([]);
  });

  it("preserves existing logs and warns when the authoritative event source is missing", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/a.md", { type: "concept", title: "A" }, "Body."),
    );
    writeFileSync(
      join(paths.meta, "events.jsonl"),
      '{"timestamp":"2026-08-06T10:00:00.000Z","kind":"before-loss"}\n',
    );
    expect(rebuildMetadata(paths).ok).toBe(true);

    const metaLog = readFileSync(join(paths.meta, "log.md"), "utf8");
    const wikiLog = readFileSync(join(paths.wiki, "log.md"), "utf8");
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/b.md",
        { type: "concept", title: "B" },
        "Links to [[concepts/a]].",
      ),
    );
    rmSync(join(paths.meta, "events.jsonl"));

    const result = rebuildMetadata(paths);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "event_source_missing",
    );
    expect(readFileSync(join(paths.meta, "log.md"), "utf8")).toBe(metaLog);
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toBe(wikiLog);
    expect(readFileSync(join(paths.meta, "registry.json"), "utf8")).toContain('"concepts/b"');
    expect(
      JSON.parse(readFileSync(join(paths.meta, "backlinks.json"), "utf8"))["concepts/a"],
    ).toEqual(["concepts/b"]);
    expect(readFileSync(join(paths.meta, "index.md"), "utf8")).toContain("B");
    expect(readFileSync(join(paths.wiki, "concepts/index.md"), "utf8")).toContain("B");
  });

  it("preserves existing logs and warns when the authoritative event source is unreadable", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeDoc(
      paths,
      createKnowledgeDocument("concepts/a.md", { type: "concept", title: "A" }, "Body."),
    );
    writeFileSync(
      join(paths.meta, "events.jsonl"),
      '{"timestamp":"2026-08-06T10:00:00.000Z","kind":"before-read-error"}\n',
    );
    expect(rebuildMetadata(paths).ok).toBe(true);

    const metaLog = readFileSync(join(paths.meta, "log.md"), "utf8");
    const wikiLog = readFileSync(join(paths.wiki, "log.md"), "utf8");
    writeDoc(
      paths,
      createKnowledgeDocument(
        "concepts/c.md",
        { type: "concept", title: "C" },
        "Links to [[concepts/a]].",
      ),
    );
    rmSync(join(paths.meta, "events.jsonl"));
    mkdirSync(join(paths.meta, "events.jsonl"));

    const result = rebuildMetadata(paths);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "event_source_unreadable",
    );
    expect(readFileSync(join(paths.meta, "log.md"), "utf8")).toBe(metaLog);
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toBe(wikiLog);
    expect(readFileSync(join(paths.meta, "registry.json"), "utf8")).toContain('"concepts/c"');
    expect(
      JSON.parse(readFileSync(join(paths.meta, "backlinks.json"), "utf8"))["concepts/a"],
    ).toEqual(["concepts/c"]);
    expect(readFileSync(join(paths.meta, "index.md"), "utf8")).toContain("C");
    expect(readFileSync(join(paths.wiki, "concepts/index.md"), "utf8")).toContain("C");
  });

  it("treats a present zero-byte event source as intentionally empty", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });

    const result = rebuildMetadata(paths);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "event_source_missing",
    );
    expect(readFileSync(join(paths.meta, "log.md"), "utf8")).toContain("_No events recorded yet._");
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toBe("# Wiki Update Log\n");
  });
});
