import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashQmdContent,
  invalidateUnsafeQmdEntries,
  manifestKey,
  readQmdManifest,
  reconcileQmdMirror,
  roleForDocumentType,
} from "../extensions/llm-wiki/lib/qmd-mirror.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempVault(): ReturnType<typeof getVaultPaths> {
  const root = mkdtempSync(join(tmpdir(), "pi-llm-wiki-mirror-"));
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  mkdirSync(join(paths.dotWiki, "config.json").replace(/config\.json$/, ""), { recursive: true });
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ topic: "Mirror" }));
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  mkdirSync(join(paths.wiki, "entities"), { recursive: true });
  mkdirSync(join(paths.wiki, "analyses"), { recursive: true });
  mkdirSync(join(paths.wiki, "syntheses"), { recursive: true });
  mkdirSync(join(paths.wiki, "requirements"), { recursive: true });
  mkdirSync(join(paths.wiki, "skills"), { recursive: true });
  mkdirSync(join(paths.wiki, "cases"), { recursive: true });
  mkdirSync(join(paths.wiki, "sources"), { recursive: true });
  mkdirSync(join(paths.wiki, "misc"), { recursive: true });
  return paths;
}

const card = `---
type: concept
title: Retrieval Card
created: 2026-08-09
updated: 2026-08-09
---

# Retrieval Card

QMD mirrors only parser-valid Markdown.
`;

const bad = "this file has no frontmatter at all\n";

describe("QMD parser-validated mirror", () => {
  it("reconciles a full vault and publishes a manifest", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    writeFileSync(join(paths.wiki, "entities", "person.md"), makePage("entity", "Person"));
    writeFileSync(join(paths.wiki, "analyses", "decision.md"), makePage("analysis", "Decision"));
    writeFileSync(join(paths.wiki, "syntheses", "summary.md"), makePage("synthesis", "Summary"));
    writeFileSync(join(paths.wiki, "requirements", "rule.md"), makePage("requirement", "Rule"));
    writeFileSync(join(paths.wiki, "skills", "procedure.md"), makePage("skill", "Procedure"));
    writeFileSync(join(paths.wiki, "cases", "example.md"), makePage("case", "Example"));
    writeFileSync(join(paths.wiki, "sources", "source.md"), makePage("source", "Source"));
    writeFileSync(join(paths.wiki, "misc", "unknown.md"), makePage("custom", "Custom"));
    writeFileSync(join(paths.wiki, "concepts", "bad.md"), bad);
    // Reserved generated names must be skipped by discovery.
    writeFileSync(join(paths.wiki, "concepts", "index.md"), makePage("concept", "Index"));
    writeFileSync(join(paths.wiki, "log.md"), makePage("concept", "Log"));

    const result = await reconcileQmdMirror(paths, vaultId, "changed");
    expect(result.counts).toEqual({ indexed: 9, updated: 0, unchanged: 0, removed: 0 });
    expect(result.diagnostics.map((d) => d.code)).toContain("frontmatter_missing");

    const manifest = await readQmdManifest(paths, vaultId);
    expect(Object.keys(manifest.entries).sort()).toEqual([
      "documents/canonical/analyses/decision.md",
      "documents/canonical/cases/example.md",
      "documents/canonical/concepts/card.md",
      "documents/canonical/entities/person.md",
      "documents/canonical/requirements/rule.md",
      "documents/canonical/skills/procedure.md",
      "documents/canonical/syntheses/summary.md",
      "documents/evidence/misc/unknown.md",
      "documents/evidence/sources/source.md",
    ]);
    expect(manifest.entries["documents/canonical/concepts/card.md"]).toMatchObject({
      vaultId,
      pageId: "concepts/card",
      role: "canonical",
    });
  });

  it("does not rewrite unchanged mirror files", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    writeFileSync(join(paths.wiki, "entities", "person.md"), makePage("entity", "Person"));
    await reconcileQmdMirror(paths, vaultId, "all");
    const mirrorPath = join(paths.qmdDocuments, "canonical", "concepts", "card.md");
    const before = readFileSync(mirrorPath, "utf8");
    const beforeStat = { size: readFileSync(mirrorPath).length, mtimeMs: statMs(mirrorPath) };

    const again = await reconcileQmdMirror(paths, vaultId, "changed");
    expect(again.counts).toEqual({ indexed: 0, updated: 0, unchanged: 2, removed: 0 });
    expect(readFileSync(mirrorPath, "utf8")).toBe(before);
    expect(statMs(mirrorPath)).toBe(beforeStat.mtimeMs);
  });

  it("updates changed content and changes the hash", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    await reconcileQmdMirror(paths, vaultId, "all");
    const mirrorPath = join(paths.qmdDocuments, "canonical", "concepts", "card.md");
    const beforeHash = hashQmdContent(readFileSync(mirrorPath, "utf8"));

    writeFileSync(
      join(paths.wiki, "concepts", "card.md"),
      card.replace("QMD mirrors only", "QMD mirrors only edited"),
    );
    const result = await reconcileQmdMirror(paths, vaultId, "changed");
    expect(result.counts.updated).toBe(1);
    expect(result.counts.unchanged).toBe(0);
    const afterHash = hashQmdContent(readFileSync(mirrorPath, "utf8"));
    expect(afterHash).not.toBe(beforeHash);
  });

  it("moves a role change from canonical to evidence", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    await reconcileQmdMirror(paths, vaultId, "all");
    expect(existsSync(join(paths.qmdDocuments, "canonical", "concepts", "card.md"))).toBe(true);

    writeFileSync(
      join(paths.wiki, "concepts", "card.md"),
      card.replace("type: concept", "type: source"),
    );
    const result = await reconcileQmdMirror(paths, vaultId, "changed");
    expect(result.counts.removed).toBe(1);
    expect(existsSync(join(paths.qmdDocuments, "canonical", "concepts", "card.md"))).toBe(false);
    expect(existsSync(join(paths.qmdDocuments, "evidence", "concepts", "card.md"))).toBe(true);
    const manifest = await readQmdManifest(paths, vaultId);
    expect(manifest.entries["documents/canonical/concepts/card.md"]).toBeUndefined();
    expect(manifest.entries["documents/evidence/concepts/card.md"]).toBeDefined();
  });

  it("deletes a page and removes its manifest entry and mirror file", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    await reconcileQmdMirror(paths, vaultId, "all");
    const mirrorPath = join(paths.qmdDocuments, "canonical", "concepts", "card.md");
    expect(existsSync(mirrorPath)).toBe(true);

    rmSync(join(paths.wiki, "concepts", "card.md"));
    const result = await reconcileQmdMirror(paths, vaultId, "changed");
    expect(result.counts.removed).toBe(1);
    expect(existsSync(mirrorPath)).toBe(false);
    const manifest = await readQmdManifest(paths, vaultId);
    expect(Object.keys(manifest.entries)).toHaveLength(0);
  });

  it("removes old mirror entry when a page becomes malformed", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    await reconcileQmdMirror(paths, vaultId, "all");
    const mirrorPath = join(paths.qmdDocuments, "canonical", "concepts", "card.md");
    expect(existsSync(mirrorPath)).toBe(true);

    writeFileSync(join(paths.wiki, "concepts", "card.md"), bad);
    const result = await reconcileQmdMirror(paths, vaultId, "changed");
    expect(result.counts.removed).toBe(1);
    expect(existsSync(mirrorPath)).toBe(false);
    const manifest = await readQmdManifest(paths, vaultId);
    expect(Object.keys(manifest.entries)).toHaveLength(0);
  });

  it("rebuilds from authoritative pages on a wrong-vault manifest", async () => {
    const paths = tempVault();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    await reconcileQmdMirror(paths, randomUUID(), "all");

    const wrongVault = randomUUID();
    await expect(readQmdManifest(paths, wrongVault)).rejects.toThrow(/manifest/i);

    const result = await reconcileQmdMirror(paths, wrongVault, "changed");
    expect(result.diagnostics.map((d) => d.code)).toContain("qmd_manifest_invalid");
    expect(result.counts).toEqual({ indexed: 1, updated: 0, unchanged: 0, removed: 0 });
    const manifest = await readQmdManifest(paths, wrongVault);
    expect(manifest.entries["documents/canonical/concepts/card.md"]).toMatchObject({
      vaultId: wrongVault,
    });
  });

  it("uses absolute source paths and forward-slash manifest keys", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    await reconcileQmdMirror(paths, vaultId, "all");
    const manifest = await readQmdManifest(paths, vaultId);
    for (const [key, entry] of Object.entries(manifest.entries)) {
      expect(key.split("/")).not.toContain("\\");
      expect(key.startsWith("/")).toBe(false);
      const sourcePath = entry.sourcePath;
      expect(sourcePath.startsWith("/")).toBe(true);
      expect(entry.pageId).toBe("concepts/card");
    }
  });

  it("invalidateUnsafeQmdEntries removes only unsafe entries", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    writeFileSync(join(paths.wiki, "concepts", "card.md"), card);
    await reconcileQmdMirror(paths, vaultId, "all");
    writeFileSync(join(paths.wiki, "concepts", "bad.md"), bad);

    const result = await invalidateUnsafeQmdEntries(paths, vaultId);
    expect(result.counts.removed).toBe(0);
    const manifest = await readQmdManifest(paths, vaultId);
    expect(manifest.entries["documents/canonical/concepts/card.md"]).toBeDefined();
  });

  it("manifestKey builds forward-slash paths and roleForDocumentType maps roles", () => {
    expect(manifestKey("canonical", "concepts/card")).toBe("documents/canonical/concepts/card.md");
    expect(manifestKey("evidence", "sources/abc")).toBe("documents/evidence/sources/abc.md");
    expect(roleForDocumentType("Concept")).toBe("canonical");
    expect(roleForDocumentType("source")).toBe("evidence");
    expect(roleForDocumentType("mystery")).toBe("evidence");
  });
});

function makePage(type: string, title: string): string {
  return `---
type: ${type}
title: ${title}
created: 2026-08-09
---

# ${title}

Body for ${title}.
`;
}

function statMs(path: string): number {
  return statSync(path).mtimeMs;
}

describe("QMD manifest strict validation", () => {
  function manifestVault(): { paths: ReturnType<typeof getVaultPaths>; vaultId: string } {
    const paths = tempVault();
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(join(paths.wiki, "concepts", "a.md"), makePage("concept", "A"));
    mkdirSync(paths.qmd, { recursive: true });
    const vaultId = randomUUID();
    return { paths, vaultId };
  }

  function entry(
    paths: ReturnType<typeof getVaultPaths>,
    vaultId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      sourcePath: join(paths.wiki, "concepts/a.md"),
      vaultId,
      pageId: "concepts/a",
      contentHash: "a".repeat(64),
      role: "canonical",
      type: "concept",
      ...overrides,
    };
  }

  it("returns an empty manifest for a missing file", async () => {
    const { paths, vaultId } = manifestVault();
    const manifest = await readQmdManifest(paths, vaultId);
    expect(manifest.entries).toEqual({});
  });

  it("throws for malformed JSON", async () => {
    const { paths, vaultId } = manifestVault();
    writeFileSync(paths.qmdManifest, "{not-json");
    await expect(readQmdManifest(paths, vaultId)).rejects.toThrow(/manifest/i);
  });

  it("throws for an absolute or traversal manifest key", async () => {
    const { paths, vaultId } = manifestVault();
    writeFileSync(
      paths.qmdManifest,
      JSON.stringify({
        version: 1,
        vaultId,
        entries: { "/etc/passwd": entry(paths, vaultId) },
      }),
    );
    await expect(readQmdManifest(paths, vaultId)).rejects.toThrow(/manifest/i);
  });

  it("throws when the entry role/pageId do not match the key", async () => {
    const { paths, vaultId } = manifestVault();
    writeFileSync(
      paths.qmdManifest,
      JSON.stringify({
        version: 1,
        vaultId,
        entries: {
          "documents/canonical/concepts/a.md": entry(paths, vaultId, { role: "evidence" }),
        },
      }),
    );
    await expect(readQmdManifest(paths, vaultId)).rejects.toThrow(/manifest/i);
  });

  it("throws when the entry vaultId does not match the manifest", async () => {
    const { paths, vaultId } = manifestVault();
    writeFileSync(
      paths.qmdManifest,
      JSON.stringify({
        version: 1,
        vaultId,
        entries: {
          "documents/canonical/concepts/a.md": entry(paths, vaultId, { vaultId: randomUUID() }),
        },
      }),
    );
    await expect(readQmdManifest(paths, vaultId)).rejects.toThrow(/manifest/i);
  });

  it("throws when the sourcePath is outside the wiki", async () => {
    const { paths, vaultId } = manifestVault();
    writeFileSync(
      paths.qmdManifest,
      JSON.stringify({
        version: 1,
        vaultId,
        entries: {
          "documents/canonical/concepts/a.md": entry(paths, vaultId, {
            sourcePath: "/tmp/somewhere-else.md",
          }),
        },
      }),
    );
    await expect(readQmdManifest(paths, vaultId)).rejects.toThrow(/manifest/i);
  });

  it("throws when type is empty or contentHash is not a sha256 hex", async () => {
    const { paths, vaultId } = manifestVault();
    writeFileSync(
      paths.qmdManifest,
      JSON.stringify({
        version: 1,
        vaultId,
        entries: {
          "documents/canonical/concepts/a.md": entry(paths, vaultId, { type: "  " }),
        },
      }),
    );
    await expect(readQmdManifest(paths, vaultId)).rejects.toThrow(/manifest/i);
    writeFileSync(
      paths.qmdManifest,
      JSON.stringify({
        version: 1,
        vaultId,
        entries: {
          "documents/canonical/concepts/a.md": entry(paths, vaultId, { contentHash: "xyz" }),
        },
      }),
    );
    await expect(readQmdManifest(paths, vaultId)).rejects.toThrow(/manifest/i);
  });

  it("accepts a fully valid manifest", async () => {
    const { paths, vaultId } = manifestVault();
    writeFileSync(
      paths.qmdManifest,
      JSON.stringify({
        version: 1,
        vaultId,
        entries: { "documents/canonical/concepts/a.md": entry(paths, vaultId) },
      }),
    );
    const manifest = await readQmdManifest(paths, vaultId);
    expect(manifest.entries["documents/canonical/concepts/a.md"].contentHash).toBe("a".repeat(64));
  });

  it("invalidates fail-closed on a corrupt prior manifest", async () => {
    const { paths, vaultId } = manifestVault();
    await reconcileQmdMirror(paths, vaultId, "all");
    // Corrupt the manifest, then remove the page so a stale candidate exists.
    writeFileSync(paths.qmdManifest, "{broken");
    rmSync(join(paths.wiki, "concepts", "a.md"));
    const result = await invalidateUnsafeQmdEntries(paths, vaultId);
    expect(result.counts.removed).toBeGreaterThan(0);
    const manifest = await readQmdManifest(paths, vaultId);
    expect(Object.keys(manifest.entries)).toHaveLength(0);
  });
});

describe("QMD mirror full-scope accounting", () => {
  it("counts every accepted page as unchanged on full-scope rewrite of identical content", async () => {
    const paths = tempVault();
    const vaultId = randomUUID();
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(join(paths.wiki, "concepts", "card.md"), makePage("concept", "Card"));

    const first = await reconcileQmdMirror(paths, vaultId, "all");
    expect(first.counts.indexed).toBe(1);
    const second = await reconcileQmdMirror(paths, vaultId, "all");
    expect(second.counts.indexed).toBe(0);
    expect(second.counts.updated).toBe(0);
    expect(second.counts.unchanged).toBe(1);
    expect(second.counts.indexed + second.counts.updated + second.counts.unchanged).toBe(
      Object.keys(second.manifest.entries).length,
    );
  });
});
