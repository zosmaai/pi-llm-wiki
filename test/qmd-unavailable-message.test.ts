import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeQmdUnavailable,
  QMD_PACKAGE_VERSION,
} from "../extensions/llm-wiki/lib/qmd-store.js";

// Issue #302: `wiki_reindex` reported the same native-build message for two
// different install failures. npm silently drops @tobilu/qmd when its
// `peer typescript@^5.9.3` cannot be met, which is not a native-build problem
// and has a different remedy. These tests pin the two messages apart.
function moduleNotFoundError(): Error {
  const err = new Error("Cannot find package '@tobilu/qmd' imported from qmd-store.ts");
  (err as Error & { code: string }).code = "ERR_MODULE_NOT_FOUND";
  return err;
}

function nativeLoadError(): Error {
  const err = new Error(
    "@tobilu/qmd is unavailable: Could not locate the bindings file " +
      " Tried: .../node_modules/better-sqlite3/build/better_sqlite3.node",
  );
  (err as Error & { code: string }).code = "ERR_DLOPEN_FAILED";
  return err;
}

describe("describeQmdUnavailable (issue #302)", () => {
  it("names the peer-resolution cause and the peer-resolution fix when the module is absent", () => {
    const message = describeQmdUnavailable(moduleNotFoundError());
    expect(message).toContain("is not installed");
    expect(message).toContain("peer typescript@^5.9.3");
    expect(message).toContain(`npm install @tobilu/qmd@${QMD_PACKAGE_VERSION} --legacy-peer-deps`);
    expect(message).toContain("pi install");
    expect(message).toContain("Keyword recall keeps working");
  });

  it("does not send an absent-module user to debug a native build", () => {
    const message = describeQmdUnavailable(moduleNotFoundError());
    expect(message).not.toContain("better-sqlite3");
    expect(message).not.toContain("C++ toolchain");
    expect(message).not.toContain("GitHub access");
  });

  it("detects an absent module from the message alone, without a code", () => {
    const message = describeQmdUnavailable(new Error("Cannot find module '@tobilu/qmd'"));
    expect(message).toContain("is not installed");
    expect(message).toContain("--legacy-peer-deps");
  });

  it("keeps the native-build diagnosis when the module is present but fails to load", () => {
    const message = describeQmdUnavailable(nativeLoadError());
    expect(message).toContain("is installed but failed to load");
    expect(message).toContain("Could not locate the bindings file");
    expect(message).toContain("better-sqlite3");
    expect(message).toContain("C++ toolchain");
  });

  it("does not suggest --legacy-peer-deps for a native load failure", () => {
    expect(describeQmdUnavailable(nativeLoadError())).not.toContain("legacy-peer-deps");
  });

  it("quotes the qmd version this package actually pins", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(QMD_PACKAGE_VERSION).toBe(pkg.optionalDependencies["@tobilu/qmd"]);
    expect(describeQmdUnavailable(moduleNotFoundError())).toContain(QMD_PACKAGE_VERSION);
    expect(describeQmdUnavailable(nativeLoadError())).toContain(QMD_PACKAGE_VERSION);
  });
});

describe("openQmdIndexStore wiring (issue #302)", () => {
  const src = readFileSync(
    new URL("../extensions/llm-wiki/lib/qmd-store.ts", import.meta.url),
    "utf8",
  );

  it("wraps the load failure with the cause-specific message and keeps the cause", () => {
    expect(src).toMatch(/throw new Error\(describeQmdUnavailable\(cause\), \{ cause \}\)/);
  });

  it("no longer prints the single blanket native-build message", () => {
    expect(src).not.toContain("optional dependency skipped during install");
  });
});
