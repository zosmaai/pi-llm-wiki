# Wiki Lint Fresh-Vault + Windows Capture Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two one-line bugs — `wiki_lint` crashing with ENOENT on fresh checkouts (issue #203) and `wiki_capture_source` corrupting the `original/` artifact name on Windows absolute paths (issue #204) — each with a regression test.

**Architecture:** Both fixes slot into existing code with no new modules. #203: `runWikiLint` (private in `tools.ts`) persists the gap snapshot via `writeJson` without ensuring `.llm-wiki/.discoveries/` exists; it gets the same `mkdirSync(recursive)` treatment the `autoFix` report write in the same function already uses. #204: `fileCaptureSource` derives the artifact name with `filePath.split("/").pop()`, which is a no-op on Windows paths; replace with a small exported, platform-aware `originalFileNameForPath()` helper modeled on the existing `originalFileNameForUrl()` sibling so the behavior is unit-testable cross-platform.

**Tech Stack:** TypeScript (ES2022, ESM), Vitest, Biome, pnpm.

**Roadmap:** None

**Phase:** Single-plan implementation (two independent one-line fixes, one branch, one PR)

---

## Background (what the engineer must know)

- Repo: `@zosmaai/pi-llm-wiki`. Two bugs, both confirmed present on current `main`:
  - **#203** — `runWikiLint()` (`extensions/llm-wiki/lib/tools.ts:879`) unconditionally writes `gaps.json` to `paths.discoveries` at ~line 1018. `ensureVaultStructure` (`lib/utils.ts:262`) does create `.discoveries` — but only when bootstrapping a vault. A fresh git checkout/worktree of an existing vault has `.discoveries` gitignored → absent → `writeJson` → `writeFileSync` throws ENOENT → the whole lint run is discarded and no report is ever delivered.
  - **#204** — `fileCaptureSource()` (`extensions/llm-wiki/lib/source-packet.ts:114`) computes `const fileName = filePath.split("/").pop() || "unknown"`. On Windows an absolute path like `D:\any\dir\doc.md` contains no `/`, so `fileName` becomes the whole string; `preserveFileOriginal` then writes `join(packetPath, "original", "D:\any\dir\doc.md")` — a drive colon inside a filename segment, illegal on Windows → capture fails, empty packet left behind.
- Test harness facts (verified, so the tests below compile as-is):
  - `test/lint-okf.test.ts` drives the tool via `registerWikiLint({ registerTool: ... } as unknown as ExtensionAPI)` and `tool.execute("test", params, undefined, undefined, { cwd: root, hasUI: false })`. It imports `existsSync`, `rmSync`, `writeFileSync`, `readFileSync` from `node:fs` and `getVaultPaths`, `ensureVaultStructure` from `lib/utils.js` — everything this plan's test needs is already imported.
  - Without a `Runtime` (the test case), `dispatchReported` (`tools.ts:82`) runs `work()` inline with **no catch** — so the ENOENT rejection propagates out of `tool.execute()`. That is why the failing test below fails by throwing.
  - `test/source-capture.test.ts` already imports `{ captureFile, captureText, captureUrl }` from `lib/source-packet.js` and has a `makePaths()` helper + `mockPi()` from `./helpers.js`.
- Commands: `pnpm test` (vitest), `pnpm typecheck`, `pnpm lint` (biome). Node/pnpm available; `pnpm --version` = 9.15.4.
- Issue #171 is explicitly out of scope.

## File Structure

| File | Change | Responsibility in this plan |
|---|---|---|
| `extensions/llm-wiki/lib/tools.ts` | Modify (~line 1015, inside `runWikiLint`) | One-line `mkdirSync(paths.discoveries, { recursive: true })` before the gaps write |
| `extensions/llm-wiki/lib/source-packet.ts` | Modify (line 3 import, line 114, new helper after `originalFileNameForUrl` at ~line 256) | Export `originalFileNameForPath(filePath)`; use it in `fileCaptureSource` |
| `test/lint-okf.test.ts` | Modify (append one `it(...)` after the "refreshes a stale gap snapshot to empty on audit-only lint" test, ~line 183) | Regression test: lint on a vault without `.discoveries` completes and persists `gaps.json` |
| `test/source-capture.test.ts` | Modify (extend the `source-packet.js` import; add one `it(...)` after the "should copy local non-PDF file content to extracted.md" test) | Unit test: `originalFileNameForPath` strips the platform's directory prefix |

No new files. No config, docs, or schema changes.

---

### Task 1: Fix #203 — `wiki_lint` ENOENT on fresh vault

**Files:**
- Modify: `extensions/llm-wiki/lib/tools.ts` (inside `runWikiLint`, the gaps write at ~lines 1015-1020)
- Test: `test/lint-okf.test.ts`

- [x] **Step 1: Write the failing test**

Append this `it(...)` to `test/lint-okf.test.ts`, immediately after the closing `});` of the test named `"refreshes a stale gap snapshot to empty on audit-only lint"` (that test ends with `expect(status.content[0].text).toContain("Gaps: 0");` + `});`, ~line 183). All symbols used are already imported in this file:

```ts
it("completes on a fresh checkout where .discoveries is not yet created (issue #203)", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  // Fresh checkouts / worktrees of an existing vault do not have the
  // gitignored .discoveries directory — simulate that.
  rmSync(paths.discoveries, { recursive: true, force: true });
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Fresh lint" }));
  writeFileSync(
    join(paths.wiki, "concepts", "valid.md"),
    "---\ntype: concept\n---\n\nValid.\n",
  );

  let tool: TestTool | undefined;
  registerWikiLint({
    registerTool: (definition: unknown) => {
      tool = definition as TestTool;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_lint was not registered");
  const result = await tool.execute("test", { auto_fix: false }, undefined, undefined, {
    cwd: root,
    hasUI: false,
  });

  expect(result.isError).not.toBe(true);
  // auto_fix:false returns the run summary (not the reportLines file content).
  expect(result.content[0].text).toContain("LLM Wiki lint complete");
  expect(existsSync(join(paths.discoveries, "gaps.json"))).toBe(true);
  const snapshot = JSON.parse(readFileSync(join(paths.discoveries, "gaps.json"), "utf8"));
  expect(snapshot.gaps).toEqual([]);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/lint-okf.test.ts -t "fresh checkout"`

Expected: FAIL — the `await tool.execute(...)` line throws `Error: ENOENT: no such file or directory, open '<root>/.llm-wiki/.discoveries/gaps.json'` (rejection propagates because `dispatchReported` has no runtime in tests).

- [x] **Step 3: Write the minimal implementation**

In `extensions/llm-wiki/lib/tools.ts`, inside `runWikiLint`, change this block (~lines 1015-1020):

```ts
  // The gap snapshot is generated discovery metadata consumed by wiki_status:
  // persist it on every successful lint so status never reports a stale count.
  // Corrective actions below (report, event, meta rebuild) stay autoFix-only.
  writeJson(join(paths.discoveries, "gaps.json"), {
    gaps,
    generated: new Date().toISOString(),
  });
```

to:

```ts
  // The gap snapshot is generated discovery metadata consumed by wiki_status:
  // persist it on every successful lint so status never reports a stale count.
  // Corrective actions below (report, event, meta rebuild) stay autoFix-only.
  // mkdir mirrors the autoFix report write below: on a fresh checkout the
  // gitignored .discoveries dir does not exist yet (issue #203).
  mkdirSync(paths.discoveries, { recursive: true });
  writeJson(join(paths.discoveries, "gaps.json"), {
    gaps,
    generated: new Date().toISOString(),
  });
```

`mkdirSync` is already imported at the top of `tools.ts` (line 1: `import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";`) — no import change.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/lint-okf.test.ts`

Expected: PASS — all tests in the file green, including the new one.

- [x] **Step 5: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: all green (no unrelated breakage).

- [x] **Step 6: Commit**

```bash
git add test/lint-okf.test.ts extensions/llm-wiki/lib/tools.ts
git commit -m "fix: ensure .discoveries exists before lint persists the gap snapshot (#203)"
```

---

### Task 2: Fix #204 — Windows drive colon in captured file name

**Files:**
- Modify: `extensions/llm-wiki/lib/source-packet.ts` (line 3 import; line 114 in `fileCaptureSource`; new exported helper after `originalFileNameForUrl`, which ends ~line 256)
- Test: `test/source-capture.test.ts`

- [x] **Step 1: Write the failing test**

First, extend the existing import at line 5 of `test/source-capture.test.ts`:

```ts
import { captureFile, captureText, captureUrl } from "../extensions/llm-wiki/lib/source-packet.js";
```

becomes:

```ts
import {
  captureFile,
  captureText,
  captureUrl,
  originalFileNameForPath,
} from "../extensions/llm-wiki/lib/source-packet.js";
```

Then append this `it(...)` inside the `describe("source packet capture", ...)` block, immediately after the test named `"should copy local non-PDF file content to extracted.md"` (ends with `expect(existsSync(join(result.packetPath, "original", "notes.md"))).toBe(true);` + `});`):

```ts
it("derives the original artifact name with platform basename so drive letters stay out of file names (issue #204)", () => {
  const absPath =
    process.platform === "win32" ? "D:\\any\\dir\\doc.md" : "/home/user/any/dir/doc.md";
  expect(originalFileNameForPath(absPath)).toBe("doc.md");
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/source-capture.test.ts -t "drive letters"`

Expected: FAIL — module load error: `No export named "originalFileNameForPath"` (the named ESM import does not exist yet).

- [x] **Step 3: Write the minimal implementation**

In `extensions/llm-wiki/lib/source-packet.ts`, make three edits:

1. Line 3 import — change:

```ts
import { extname, join } from "node:path";
```

to:

```ts
import { basename, extname, join } from "node:path";
```

2. After `originalFileNameForUrl` (the function ending `return "source.html";` + `});`/`}`, ~line 256), add:

```ts
/**
 * Original-artifact name for a local file capture. Uses platform basename so
 * Windows absolute paths (drive colon + backslashes) cannot leak into the
 * packet/original file name (issue #204).
 */
export function originalFileNameForPath(filePath: string): string {
  return basename(filePath) || "unknown";
}
```

3. Inside `fileCaptureSource` (~line 114) — change:

```ts
  const fileName = filePath.split("/").pop() || "unknown";
```

to:

```ts
  const fileName = originalFileNameForPath(filePath);
```

`fileName` flows into `preserveFileOriginal(packetPath, filePath, fileName, content)` and the manifest `title` — both now get the clean basename.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/source-capture.test.ts`

Expected: PASS — all tests in the file green, including the new one.

Note (honest ceiling): on Linux, POSIX `basename("D:\\any\\dir\\doc.md")` returns the string unchanged, so this assertion only has teeth on `win32` — it pins the operation choice (platform basename vs. slash-split) rather than reproducing Windows. Full Windows coverage needs a Windows CI leg or manual repro.

- [x] **Step 5: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: all green.

- [x] **Step 6: Commit**

```bash
git add test/source-capture.test.ts extensions/llm-wiki/lib/source-packet.ts
git commit -m "fix: use platform basename for file capture artifact names (#204)"
```

---

### Task 3: Push branch, open PR

**Files:** none (git/gh only)

- [x] **Step 1: Push and open the PR**

```bash
git push -u origin fix/lint-fresh-vault-and-windows-basename
gh pr create \
  --title "fix: lint ENOENT on fresh vaults (#203) + Windows capture basename (#204)" \
  --body "Fixes #203. Fixes #204.

Two one-line fixes with regression tests:
- wiki_lint: mkdirSync the gitignored .discoveries dir before persisting the gap snapshot (mirrors the autoFix report write in the same function).
- wiki_capture_source: derive the original artifact name with platform basename instead of split('/').pop() so Windows absolute paths no longer embed a drive colon in the file name."
```

Expected: PR created; `Fixes #203` / `Fixes #204` auto-close the issues on merge.

---

## Setup (before Task 1)

- [x] **Step 0: Branch from main**

Working tree is clean (verified 2026-09-02); current branch is `qmd-phase-1` — do the work on a dedicated branch off `main`:

```bash
git checkout main
git pull --ff-only
git checkout -b fix/lint-fresh-vault-and-windows-basename
```

Expected: `Switched to a new branch 'fix/lint-fresh-vault-and-windows-basename'`.
