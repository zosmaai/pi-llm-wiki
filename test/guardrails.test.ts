import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import {
  extractMutationPaths,
  hasWikiMutation,
  installGuardrails,
  mutationBlockReason,
} from "../extensions/llm-wiki/lib/guardrails.js";
import {
  ensureVaultStructure,
  getVaultPaths,
  resolveVaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

type ToolCallHandler = (event: { toolName: string; input: unknown }) => Promise<unknown>;

function captureToolCallHandler(): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on: (eventName: string, candidate: unknown) => {
      if (eventName === "tool_call") handler = candidate as ToolCallHandler;
    },
  } as unknown as ExtensionAPI;

  installGuardrails(pi);
  if (!handler) throw new Error("tool_call handler was not registered");
  return handler;
}

const originalWikiHome = process.env.WIKI_HOME;
const guardrailRoot = join(import.meta.dirname, "..", "tmp", `guardrail-suite-${Date.now()}`);
process.env.WIKI_HOME = guardrailRoot;
const vaultPaths = resolveVaultPaths(process.cwd());
ensureVaultStructure(vaultPaths);
writeFileSync(
  join(vaultPaths.dotWiki, "config.json"),
  JSON.stringify({ knowledge_format: "legacy" }),
);

afterAll(() => {
  if (originalWikiHome === undefined) Reflect.deleteProperty(process.env, "WIKI_HOME");
  else process.env.WIKI_HOME = originalWikiHome;
  rmSync(guardrailRoot, { recursive: true, force: true });
});

describe("edit guardrails", () => {
  it("blocks contained wiki writes when config is malformed", () => {
    const root = join(import.meta.dirname, "..", "tmp", `guardrail-${Date.now()}`);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(join(paths.dotWiki, "config.json"), "{broken");
    try {
      expect(mutationBlockReason(join(paths.wiki, "concepts", "x.md"), paths)).toContain(
        "configuration is invalid",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows an outside index file and blocks only contained OKF indexes", () => {
    const root = join(import.meta.dirname, "..", "tmp", `guardrail-${Date.now()}`);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ knowledge_format: "okf-0.2" }),
    );
    try {
      expect(mutationBlockReason(join(root, "outside", "index.md"), paths)).toBeUndefined();
      expect(mutationBlockReason(join(paths.wiki, "nested", "INDEX.md"), paths)).toContain(
        "Generated OKF",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("blocks protected raw and meta paths reached through wiki symlink aliases", () => {
    const root = join(import.meta.dirname, "..", "tmp", `guardrail-${Date.now()}`);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ knowledge_format: "okf-0.2" }),
    );
    mkdirSync(paths.wiki, { recursive: true });
    symlinkSync(paths.raw, join(paths.wiki, "raw-alias"), "dir");
    symlinkSync(paths.meta, join(paths.wiki, "meta-alias"), "dir");
    symlinkSync(paths.wiki, join(paths.wiki, "wiki-alias"), "dir");
    const external = join(root, "external");
    mkdirSync(external, { recursive: true });
    symlinkSync(paths.wiki, join(external, "wiki-alias"), "dir");
    const externalIndex = join(external, "wiki-alias", "index.md");
    try {
      expect(
        mutationBlockReason(join(paths.wiki, "raw-alias", "sources", "x.md"), paths),
      ).toContain("Raw sources");
      expect(mutationBlockReason(join(paths.wiki, "meta-alias", "registry.json"), paths)).toContain(
        "Metadata",
      );
      expect(mutationBlockReason(join(paths.wiki, "wiki-alias", "index.md"), paths)).toContain(
        "Generated OKF",
      );
      expect(mutationBlockReason(externalIndex, paths)).toContain("Generated OKF");
      expect(hasWikiMutation({ path: externalIndex }, paths.wiki)).toBe(true);
      writeFileSync(join(paths.dotWiki, "config.json"), "{broken");
      expect(mutationBlockReason(externalIndex, paths)).toContain("configuration is invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves parent traversal order through symlink aliases", () => {
    const root = join(import.meta.dirname, "..", "tmp", `guardrail-${Date.now()}`);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    const external = join(root, "external");
    const nestedRaw = join(paths.raw, "nested");
    mkdirSync(external, { recursive: true });
    mkdirSync(nestedRaw, { recursive: true });
    const alias = join(external, "raw-alias");
    const cycle = join(external, "cycle");
    mkdirSync(join(external, "cycle-dir"));
    symlinkSync(nestedRaw, alias, "dir");
    symlinkSync(`cycle-dir${sep}..${sep}cycle`, cycle);
    try {
      expect(mutationBlockReason(`${alias}${sep}..${sep}future.md`, paths)).toContain(
        "Raw sources",
      );
      expect(mutationBlockReason(cycle, paths)).toContain("Cannot safely resolve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an existing path component is not a directory", () => {
    const root = join(import.meta.dirname, "..", "tmp", `guardrail-${Date.now()}`);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    const blocker = join(root, "file");
    writeFileSync(blocker, "not a directory");
    try {
      expect(mutationBlockReason(join(blocker, "future.md"), paths)).toContain(
        "Cannot safely resolve",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks dangling final symlinks that resolve into guarded vault paths", () => {
    const root = join(import.meta.dirname, "..", "tmp", `guardrail-${Date.now()}`);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ knowledge_format: "okf-0.2" }),
    );
    const external = join(root, "external");
    mkdirSync(external, { recursive: true });
    const rawAlias = join(external, "raw-alias.md");
    const nestedRawAlias = join(external, "nested-raw-alias.md");
    const indexAlias = join(external, "index-alias.md");
    const pageAlias = join(external, "page-alias.md");
    symlinkSync(join(paths.raw, "future.md"), rawAlias);
    symlinkSync(rawAlias, nestedRawAlias);
    symlinkSync(join(paths.wiki, "index.md"), indexAlias);
    symlinkSync(join(paths.wiki, "concepts", "future.md"), pageAlias);
    try {
      expect(mutationBlockReason(rawAlias, paths)).toContain("Raw sources");
      expect(mutationBlockReason(nestedRawAlias, paths)).toContain("Raw sources");
      expect(mutationBlockReason(indexAlias, paths)).toContain("Generated OKF");
      expect(hasWikiMutation({ path: pageAlias }, paths.wiki)).toBe(true);
      writeFileSync(join(paths.dotWiki, "config.json"), "{broken");
      expect(mutationBlockReason(pageAlias, paths)).toContain("configuration is invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts every file target from an Edit patch", () => {
    const paths = extractMutationPaths({
      patch: [
        "[.llm-wiki/wiki/sources/issue-109.md#ABCD]",
        "SWAP 1.=1:",
        "+updated",
        "[.llm-wiki/wiki/concepts/guardrails.md#1234]",
        "INS.TAIL:",
        "+linked",
      ].join("\n"),
    });

    expect(paths).toEqual([
      ".llm-wiki/wiki/sources/issue-109.md",
      ".llm-wiki/wiki/concepts/guardrails.md",
    ]);
  });

  it("extracts every file target when Pi passes the patch directly", () => {
    const paths = extractMutationPaths(
      "[.llm-wiki/wiki/sources/issue-109.md#ABCD]\nSWAP 1.=1:\n+updated",
    );

    expect(paths).toEqual([".llm-wiki/wiki/sources/issue-109.md"]);
  });

  it("extracts every file target from a nested patch payload", () => {
    const paths = extractMutationPaths({
      arguments: {
        patch: "[.llm-wiki/wiki/sources/issue-109.md#ABCD]\nSWAP 1.=1:\n+updated",
      },
    });

    expect(paths).toEqual([".llm-wiki/wiki/sources/issue-109.md"]);
  });

  it("recognizes a wiki target for metadata rebuild", () => {
    expect(
      hasWikiMutation(
        {
          patch: `[${join(vaultPaths.wiki, "sources", "issue-109.md")}#ABCD]\nSWAP 1.=1:\n+updated`,
        },
        vaultPaths.wiki,
      ),
    ).toBe(true);
  });

  it("allows an Edit patch that only changes wiki pages", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: { patch: "[.llm-wiki/wiki/sources/issue-109.md#ABCD]\nSWAP 1.=1:\n+updated" },
    });

    expect(result).toBeUndefined();
  });

  it("blocks an Edit patch that targets a raw source packet", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        patch: `[${join(
          vaultPaths.rawSources,
          "SRC-2026-07-27-001",
          "extracted.md",
        )}#ABCD]\nSWAP 1.=1:\n+changed`,
      },
    });

    expect(result).toEqual({
      block: true,
      reason: "Raw sources are immutable. Use wiki_capture_source to add sources.",
    });
  });

  it("blocks a mixed Edit patch when any target is protected", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        patch: [
          "[.llm-wiki/wiki/sources/issue-109.md#ABCD]",
          "SWAP 1.=1:",
          "+updated",
          `[${join(vaultPaths.meta, "registry.json")}#1234]`,
          "SWAP 1.=1:",
          "+changed",
        ].join("\n"),
      },
    });

    expect(result).toEqual({
      block: true,
      reason: "Metadata is auto-generated. Use wiki_rebuild_meta or wiki_log_event instead.",
    });
  });

  it("checks nested edit input even when a top-level path is present", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        path: join(vaultPaths.wiki, "sources", "issue-109.md"),
        input: `[${join(
          vaultPaths.rawSources,
          "SRC-2026-07-27-001",
          "extracted.md",
        )}#ABCD]\nSWAP 1.=1:\n+changed`,
      },
    });

    expect(result).toEqual({
      block: true,
      reason: "Raw sources are immutable. Use wiki_capture_source to add sources.",
    });
  });

  it("blocks a mixed edit when a protected target uses a lowercase tag", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        input: [
          `[${join(vaultPaths.wiki, "sources", "issue-109.md")}#ABCD]`,
          "SWAP 1.=1:",
          "+updated",
          `[${join(vaultPaths.rawSources, "SRC-2026-07-27-001", "extracted.md")}#abcd]`,
          "SWAP 1.=1:",
          "+changed",
        ].join("\n"),
      },
    });

    expect(result).toEqual({
      block: true,
      reason: "Raw sources are immutable. Use wiki_capture_source to add sources.",
    });
  });

  it("blocks a protected target recovered from an apply-patch-prefixed header", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        input: `[*** Update File:${join(
          vaultPaths.meta,
          "registry.json",
        )}#ABCD]\nSWAP 1.=1:\n+changed`,
      },
    });

    expect(result).toEqual({
      block: true,
      reason: "Metadata is auto-generated. Use wiki_rebuild_meta or wiki_log_event instead.",
    });
  });

  it("fails closed when a mixed edit contains an unparseable header", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        input: [
          `[${join(vaultPaths.wiki, "sources", "issue-109.md")}#ABCD]`,
          "SWAP 1.=1:",
          "+updated",
          `[${join(vaultPaths.rawSources, "SRC-2026-07-27-001", "extracted.md")}#XYZ]`,
          "SWAP 1.=1:",
          "+changed",
        ].join("\n"),
      },
    });

    expect(result).toEqual({
      block: true,
      reason: "Cannot determine the files targeted by this edit.",
    });
  });

  it.each([
    [
      "raw source",
      join(vaultPaths.rawSources, "moved.md"),
      "Raw sources are immutable. Use wiki_capture_source to add sources.",
    ],
    [
      "metadata",
      join(vaultPaths.meta, "moved.json"),
      "Metadata is auto-generated. Use wiki_rebuild_meta or wiki_log_event instead.",
    ],
  ])("blocks a hashline move to protected %s", async (_label, destination, reason) => {
    const handler = captureToolCallHandler();
    const source = join(vaultPaths.wiki, "sources", "issue-109.md");
    const result = await handler({
      toolName: "edit",
      input: { input: `[${source}#ABCD]\nMV ${destination}` },
    });

    expect(result).toEqual({ block: true, reason });
  });

  it.each([
    [
      "raw source",
      join(vaultPaths.rawSources, "renamed.md"),
      "Raw sources are immutable. Use wiki_capture_source to add sources.",
    ],
    [
      "metadata",
      join(vaultPaths.meta, "renamed.json"),
      "Metadata is auto-generated. Use wiki_rebuild_meta or wiki_log_event instead.",
    ],
  ])("blocks a JSON patch rename to protected %s", async (_label, destination, reason) => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        path: join(vaultPaths.wiki, "sources", "issue-109.md"),
        edits: [{ op: "update", rename: destination, diff: "@@\n unchanged" }],
      },
    });

    expect(result).toEqual({ block: true, reason });
  });

  it("blocks a mixed ordinary edit and protected move destination", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        input: [
          `[${join(vaultPaths.wiki, "sources", "issue-109.md")}#ABCD]`,
          "INS.TAIL:",
          "+updated",
          `[${join(vaultPaths.wiki, "sources", "move-source.md")}#1234]`,
          `MV ${join(vaultPaths.rawSources, "move-destination.md")}`,
        ].join("\n"),
      },
    });

    expect(result).toEqual({
      block: true,
      reason: "Raw sources are immutable. Use wiki_capture_source to add sources.",
    });
  });

  it("allows an ordinary JSON patch rename", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        path: join(vaultPaths.wiki, "sources", "issue-109.md"),
        edits: [
          {
            op: "update",
            rename: join(vaultPaths.wiki, "sources", "renamed-issue-109.md"),
            diff: "@@\n unchanged",
          },
        ],
      },
    });

    expect(result).toBeUndefined();
  });

  it.each([
    [
      "raw source",
      `"*** Update File:${join(vaultPaths.rawSources, "quoted-source.md")}"`,
      "Raw sources are immutable. Use wiki_capture_source to add sources.",
    ],
    [
      "metadata",
      `"*** Delete File:${join(vaultPaths.meta, "quoted-source.json")}"`,
      "Metadata is auto-generated. Use wiki_rebuild_meta or wiki_log_event instead.",
    ],
  ])("blocks a quoted recovery-prefixed %s header", async (_label, source, reason) => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: { input: `[${source}#ABCD]\nREM` },
    });

    expect(result).toEqual({ block: true, reason });
  });

  it.each([
    [
      "raw source",
      `*** Move to:${join(vaultPaths.rawSources, "prefixed-move.md")}`,
      "Raw sources are immutable. Use wiki_capture_source to add sources.",
    ],
    [
      "metadata",
      `"*** Move to:${join(vaultPaths.meta, "prefixed-move.json")}"`,
      "Metadata is auto-generated. Use wiki_rebuild_meta or wiki_log_event instead.",
    ],
  ])("blocks a recovery-prefixed move to protected %s", async (_label, destination, reason) => {
    const handler = captureToolCallHandler();
    const result = await handler({
      toolName: "edit",
      input: {
        input: `[${join(vaultPaths.wiki, "sources", "issue-109.md")}#ABCD]\nMV ${destination}`,
      },
    });

    expect(result).toEqual({ block: true, reason });
  });

  it("normalizes ordinary quoted recovery-prefixed sources and destinations", async () => {
    const source = join(vaultPaths.wiki, "sources", "quoted-source.md");
    const destination = join(vaultPaths.wiki, "sources", "quoted-destination.md");
    const input = {
      input: `["*** Update File:${source}"#ABCD]\nMV "*** Move to:${destination}"`,
    };

    expect(extractMutationPaths(input)).toEqual([source, destination]);
    const handler = captureToolCallHandler();
    expect(await handler({ toolName: "edit", input })).toBeUndefined();
  });

  it("blocks a pathless Edit request with a clear error", async () => {
    const handler = captureToolCallHandler();
    const result = await handler({ toolName: "edit", input: { patch: "invalid patch" } });

    expect(result).toEqual({
      block: true,
      reason: "Cannot determine the files targeted by this edit.",
    });
  });
});
