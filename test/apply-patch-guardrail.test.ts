import { describe, expect, it } from "vitest";
import { extractMutationPaths, hasWikiMutation } from "../extensions/llm-wiki/lib/guardrails.js";

// Regression coverage for #162: apply_patch-mode edit inputs
// ("*** Begin Patch / *** Update File: path / *** End Patch" envelopes)
// must have their targets extracted instead of being blocked with
// "Cannot determine the files targeted by this edit."

describe("extractMutationPaths — apply_patch envelopes", () => {
  it("extracts Update File targets", () => {
    const input =
      "*** Begin Patch\n" +
      "*** Update File: src/loader.lisp\n" +
      "@@\n" +
      " context line\n" +
      "+added line\n" +
      " context line\n" +
      "*** End Patch";
    expect(extractMutationPaths(input)).toEqual(["src/loader.lisp"]);
  });

  it("extracts targets from multi-file patches (update/add/delete/move)", () => {
    const input =
      "*** Begin Patch\n" +
      "*** Update File: a.ts\n" +
      "@@\n" +
      " x\n" +
      "+y\n" +
      "*** Add File: b.ts\n" +
      "+new\n" +
      "*** Delete File: c.ts\n" +
      "*** Move to: a/rename.ts\n" +
      "*** End Patch";
    expect(extractMutationPaths(input)).toEqual(["a.ts", "b.ts", "c.ts", "a/rename.ts"]);
  });

  it("handles CRLF envelope lines", () => {
    const input =
      "*** Begin Patch\r\n" +
      "*** Update File: src/loader.lisp\r\n" +
      "@@\r\n" +
      " x\r\n" +
      "+y\r\n" +
      "*** End Patch\r\n";
    expect(extractMutationPaths(input)).toEqual(["src/loader.lisp"]);
  });

  it("does not treat body rows quoting the envelope as headers", () => {
    // The body row below quotes the envelope shape but is prefixed with
    // the diff marker "+", so it must not yield a phantom target.
    const input =
      "*** Begin Patch\n" +
      "*** Update File: real-file.ts\n" +
      "@@\n" +
      "+*** Update File: phantom-file.ts\n" +
      " context\n" +
      "*** End Patch";
    expect(extractMutationPaths(input)).toEqual(["real-file.ts"]);
  });

  it("keeps absolute paths absolute", () => {
    const input = "*** Update File: /home/dev/proj/src/loader.lisp\n@@\n x\n+ y";
    expect(extractMutationPaths(input)).toEqual(["/home/dev/proj/src/loader.lisp"]);
  });

  it("still parses hashline-format patch strings", () => {
    const input = "[src/loader.lisp#AB12]\n- old line\n+ new line";
    expect(extractMutationPaths(input)).toEqual(["src/loader.lisp"]);
  });

  it("still parses { path, old_string, new_string } objects", () => {
    expect(
      extractMutationPaths({
        path: "src/loader.lisp",
        old_string: "(defun foo ())",
        new_string: "(defun foo () :ok)",
      }),
    ).toEqual(["src/loader.lisp"]);
  });

  it("returns no paths for an envelope with an empty target (fail closed)", () => {
    const input = "*** Begin Patch\n*** Update File:\n@@\n x\n+ y\n*** End Patch";
    expect(extractMutationPaths(input)).toEqual([]);
  });
});

describe("hasWikiMutation — apply_patch envelopes", () => {
  it("sees vault edits through the envelope", () => {
    const wikiPath = "/tmp/vault/.llm-wiki/wiki";
    const input =
      "*** Begin Patch\n" +
      "*** Update File: /tmp/vault/.llm-wiki/wiki/pages/foo.md\n" +
      "@@\n" +
      " x\n" +
      "+y\n" +
      "*** End Patch";
    expect(hasWikiMutation(input, wikiPath)).toBe(true);
    expect(hasWikiMutation("*** Update File: src/other.ts\n@@\n x\n+ y", wikiPath)).toBe(false);
  });
});
