import { describe, expect, it } from "vitest";
import { appendWikiStatus, WIKI_STATUS_BLOCK } from "../extensions/llm-wiki/lib/inject.js";

// Regression test for issue #87: context injection must be idempotent.
//
// When an agent turn aborts (network error / user presses ESC) and is retried,
// the chained system prompt can carry the prior injection forward. The append
// must therefore be a no-op when the wiki-status footer is already present —
// otherwise the footer stacks 2x, 3x, ... and pollutes the context window.
describe("appendWikiStatus — issue #87 idempotency", () => {
  const countBlocks = (s: string): number => s.split(WIKI_STATUS_BLOCK).length - 1;

  it("appends the footer to a clean prompt", () => {
    const out = appendWikiStatus("BASE SYSTEM PROMPT");
    expect(countBlocks(out)).toBe(1);
    expect(out).toContain("BASE SYSTEM PROMPT");
  });

  it("is idempotent across repeated (aborted-retry) injections", () => {
    let sp = "BASE SYSTEM PROMPT";
    // Three submissions where the prior two starts aborted and carried the
    // injected prompt forward.
    sp = appendWikiStatus(sp);
    sp = appendWikiStatus(sp);
    sp = appendWikiStatus(sp);
    expect(countBlocks(sp)).toBe(1);
  });

  it("does not re-append when the block is already present mid-prompt", () => {
    const seeded = `head\n\n${WIKI_STATUS_BLOCK}\n\ntail`;
    expect(countBlocks(appendWikiStatus(seeded))).toBe(1);
  });
});
