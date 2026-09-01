import { describe, expect, it } from "vitest";
import {
  auditWikilinks,
  buildResolvedBacklinks,
  buildWikilinkIndex,
  extractKnowledgeLinks,
  extractLegacyWikilinks,
} from "../extensions/llm-wiki/lib/knowledge-links.js";

const knownIds = [
  "concepts/source",
  "concepts/inline",
  "concepts/full",
  "concepts/collapsed",
  "concepts/shortcut",
  "concepts/encoded name",
  "shared/root",
];
const index = buildWikilinkIndex(knownIds);

describe("knowledge links", () => {
  it("extracts inline and used full/collapsed/shortcut references only", () => {
    const body = [
      "[inline](inline.md#part)",
      "[full][target] [collapsed][] [shortcut]",
      "![image](image.md) ![image-ref][target]",
      "<https://example.com> <concepts/inline.md>",
      '<a href="inline.md">raw</a>',
      "`[code](inline.md)`",
      "\\[escaped](inline.md)",
      "",
      "    [indented](inline.md)",
      "```md\n[fenced](inline.md)\n```",
      "[unused]: unused.md",
      "[target]: full.md",
      "[collapsed]: collapsed.md",
      "[shortcut]: shortcut.md",
    ].join("\n");
    expect(extractKnowledgeLinks(body).markdown.map((l) => l.target)).toEqual([
      "inline.md#part",
      "full.md",
      "collapsed.md",
      "shortcut.md",
    ]);
  });

  it("resolves root-relative, file-relative, percent-encoded, and wikilinks", () => {
    const body = [
      "[root](/shared/root.md?x=1)",
      "[relative](../concepts/encoded%20name.md)",
      "[[concepts/inline|Inline]]",
      "[[concepts/inline\\|Inline]]",
      "[external](https://example.com/x.md)",
    ].join("\n");
    const result = buildResolvedBacklinks("concepts/source", body, index);
    expect(result.targets).toEqual(["concepts/encoded name", "concepts/inline", "shared/root"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("strips the escape before an aliased wikilink target", () => {
    const body = "[[entities/gildan\\|Gildan]]";
    expect(extractKnowledgeLinks(body).wikilinks).toEqual([
      { target: "entities/gildan", offset: 0 },
    ]);
    expect(extractLegacyWikilinks(body)).toEqual([{ target: "entities/gildan", offset: 0 }]);
  });

  it("rejects bundle escape and reports unresolved internal targets", () => {
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[escape](../../outside.md) [missing](missing.md)",
      index,
    );
    expect(result.targets).toEqual([]);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "link_path_escape",
      "link_unresolved",
    ]);
  });

  it("turns malformed percent encoding into a diagnostic instead of throwing", () => {
    expect(() =>
      buildResolvedBacklinks("concepts/source", "[bad](bad%ZZ.md)", index),
    ).not.toThrow();
    const result = buildResolvedBacklinks("concepts/source", "[bad](bad%ZZ.md)", index);
    expect(result.targets).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["link_unresolved"]);
  });

  it("requires md suffix for root-relative Markdown links", () => {
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[missing suffix](/shared/root)",
      index,
    );
    expect(result.targets).toEqual([]);
  });

  it("deduplicates mixed Markdown and wikilink edges", () => {
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[one](inline.md) [[concepts/inline]] [two](./inline.md)",
      index,
    );
    expect(result.targets).toEqual(["concepts/inline"]);
  });
});

describe("resolveWikilink normalization", () => {
  it("resolves bare title against a unique page by slugified basename", () => {
    const index = buildWikilinkIndex(["entities/zosma-harness", "concepts/other"]);
    const result = buildResolvedBacklinks("sources/some-source", "[[zosma harness]]", index);
    expect(result.targets).toEqual(["entities/zosma-harness"]);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves folder-qualified link with case/space drift", () => {
    const index = buildWikilinkIndex(["concepts/attention-is-all-you-need"]);
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[concepts/Attention Is All You Need]]",
      index,
    );
    expect(result.targets).toEqual(["concepts/attention-is-all-you-need"]);
    expect(result.unresolved).toEqual([]);
  });

  it("reports ambiguous when bare title matches multiple pages", () => {
    const index = buildWikilinkIndex(["entities/ibm", "concepts/ibm"]);
    const result = buildResolvedBacklinks("sources/some-source", "[[ibm]]", index);
    expect(result.targets).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe("link_ambiguous");
    expect(result.diagnostics[0].message).toContain("entities/ibm");
    expect(result.diagnostics[0].message).toContain("concepts/ibm");
  });

  it("prefers exact match over normalized match", () => {
    const index = buildWikilinkIndex(["entities/ibm", "concepts/ibm"]);
    // Exact match wins even though normalized would be ambiguous for the bare slug
    const result = buildResolvedBacklinks("sources/some-source", "[[entities/ibm]]", index);
    expect(result.targets).toEqual(["entities/ibm"]);
    expect(result.unresolved).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("resolves link with case drift in folder-qualified path", () => {
    const index = buildWikilinkIndex(["entities/google-brain"]);
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[Entities/Google-Brain]]",
      index,
    );
    expect(result.targets).toEqual(["entities/google-brain"]);
    expect(result.unresolved).toEqual([]);
  });

  it("resolves slugified trailing slash variant", () => {
    const index = buildWikilinkIndex(["concepts/retrieval-augmented-generation"]);
    const result = buildResolvedBacklinks(
      "sources/some-source",
      "[[concepts/Retrieval Augmented Generation]]",
      index,
    );
    expect(result.targets).toEqual(["concepts/retrieval-augmented-generation"]);
  });

  it("exact match is returned even when normalization would find a different page", () => {
    // Page exists at exactly `concepts/ibm` AND at `entities/ibm`
    // The link `[[concepts/ibm]]` should resolve to `concepts/ibm` (exact)
    // without ambiguity — normalization is only consulted when exact fails.
    const index = buildWikilinkIndex(["concepts/ibm", "entities/ibm"]);
    const result = buildResolvedBacklinks("sources/src-1", "[[concepts/ibm]]", index);
    expect(result.targets).toEqual(["concepts/ibm"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("existing slash-less link with whitespace matches by slug path", () => {
    const index = buildWikilinkIndex(["entities/zosma-harness"]);
    const result = buildResolvedBacklinks("sources/src-1", "[[entities/zosma harness]]", index);
    expect(result.targets).toEqual(["entities/zosma-harness"]);
    expect(result.unresolved).toEqual([]);
  });

  it("ambiguous bare title does not resolve to any target", () => {
    const index = buildWikilinkIndex(["entities/ibm", "concepts/ibm", "notes/ibm"]);
    const result = buildResolvedBacklinks("sources/src-1", "[[ibm]]", index);
    expect(result.targets).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.diagnostics[0].code).toBe("link_ambiguous");
    expect(result.diagnostics[0].message).toContain("entities/ibm");
    expect(result.diagnostics[0].message).toContain("concepts/ibm");
    expect(result.diagnostics[0].message).toContain("notes/ibm");
  });

  it("bare title that matches zero pages is reported as unresolved", () => {
    const index = buildWikilinkIndex(["entities/ibm"]);
    const result = buildResolvedBacklinks("sources/src-1", "[[nonexistent]]", index);
    expect(result.targets).toEqual([]);
    expect(result.unresolved).toEqual([{ target: "nonexistent", syntax: "wikilink" }]);
    expect(result.diagnostics[0].code).toBe("link_unresolved");
  });
});
const idx = buildWikilinkIndex([
  "entities/alice",
  "concepts/transformer",
  "concepts/attention",
  "concepts/other-page",
]);

describe("auditWikilinks", () => {
  it("off returns no diagnostics and unchanged body", () => {
    const r = auditWikilinks("see [[ghost]]", idx, "SRC-001", "off");
    expect(r.diagnostics).toEqual([]);
    expect(r.body).toBe("see [[ghost]]");
    expect(r.changed).toBe(false);
  });

  it("warn reports an unresolved link and leaves the body untouched", () => {
    const r = auditWikilinks("bad [[ghost]]", idx, "SRC-001", "warn");
    expect(r.body).toBe("bad [[ghost]]");
    expect(r.diagnostics.map((d) => d.code)).toContain("link_unresolved");
  });

  it("warn flags ambiguous when a bare target matches multiple pages", () => {
    const ambiguous = buildWikilinkIndex(["entities/alice", "concepts/alice"]);
    const r = auditWikilinks("who is [[alice]]?", ambiguous, "SRC-001", "warn");
    const amb = r.diagnostics.find((d) => d.code === "link_ambiguous");
    expect(amb).toBeDefined();
    expect(r.body).toBe("who is [[alice]]?");
  });

  it("normalize rewrites resolvable targets to canonical id, preserves alias", () => {
    const body = "see [[transformer|TF]] and [[alice]]";
    const r = auditWikilinks(body, idx, "SRC-001", "normalize");
    expect(r.body).toBe("see [[concepts/transformer|TF]] and [[entities/alice]]");
    expect(r.changed).toBe(true);
  });

  it("normalize leaves unresolvable links verbatim", () => {
    const r = auditWikilinks("see [[ghost]]", idx, "SRC-001", "normalize");
    expect(r.body).toBe("see [[ghost]]");
    expect(r.changed).toBe(false);
  });

  it("normalize is a no-op when every link is already canonical", () => {
    const r = auditWikilinks("see [[concepts/attention]]", idx, "SRC-001", "normalize");
    expect(r.body).toBe("see [[concepts/attention]]");
    expect(r.changed).toBe(false);
  });
});

import { applyWikilinkGate } from "../extensions/llm-wiki/lib/knowledge-links.js";

const gateIdx = buildWikilinkIndex(["concepts/transformer"]);

describe("applyWikilinkGate", () => {
  const body = "see [[transformer]] and [[ghost]]";

  it("off → ok, unchanged body, no diagnostics", () => {
    const r = applyWikilinkGate(body, gateIdx, "x", "off");
    expect(r.ok).toBe(true);
    expect(r.body).toBe(body);
    expect(r.diagnostics).toEqual([]);
  });

  it("warn → ok, unchanged body, reports only the missing link", () => {
    const r = applyWikilinkGate(body, gateIdx, "x", "warn");
    expect(r.ok).toBe(true);
    expect(r.body).toBe(body); // not rewritten
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toEqual(["link_unresolved"]); // [[ghost]] only; [[transformer]] resolves
  });

  it("strict → not ok when a link is missing", () => {
    const r = applyWikilinkGate(body, gateIdx, "x", "strict");
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBe(1);
  });

  it("strict → ok when every link resolves", () => {
    const r = applyWikilinkGate("see [[transformer]]", gateIdx, "x", "strict");
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });

  it("normalize → rewrites resolvable links, still reports missing", () => {
    const r = applyWikilinkGate(body, gateIdx, "x", "normalize");
    expect(r.ok).toBe(true);
    expect(r.body).toBe("see [[concepts/transformer]] and [[ghost]]");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link_unresolved"]);
  });
});
