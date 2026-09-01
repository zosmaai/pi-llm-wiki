# Keyless Provider Ingest Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `wiki_ingest` background synthesis silently no-oping for keyless local providers (llama.cpp, self-hosted models).

**Architecture:** One-line logic fix in `Runtime.resolveModel()` + one new test. The `!auth.apiKey` check in the auth gate wrongly rejects providers where `getApiKeyAndHeaders` returns `{ ok: true }` without an `apiKey` field — the correct response for a server that needs no key.

**Tech Stack:** TypeScript, Vitest

**Roadmap:** None

**Phase:** Single-plan implementation

**Issue:** [#174](https://github.com/zosmaai/pi-llm-wiki/issues/174)

---

## Context

`Runtime.resolveModel()` at `extensions/llm-wiki/lib/runtime.ts:135-140` gates background work on API key presence:

```ts
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
if (!auth.ok || !auth.apiKey) {    // ← bug: || !auth.apiKey
  const provider = (model as { provider?: string }).provider ?? "unknown";
  return { ok: false, reason: `no API key for provider "${provider}"` };
}
return { ok: true, model, apiKey: auth.apiKey, headers: auth.headers };
```

For keyless providers, the host's `getApiKeyAndHeaders` returns `{ ok: true, headers: {...} }` — `ok: true` because auth is satisfied, no `apiKey` because the server doesn't need one. But `!auth.apiKey` is `true` (undefined is falsy), so `resolveModel` returns `ok: false`.

Downstream in `tools.ts:408`:
```ts
const resolved = await runtime.resolveModel(ctx, override);
if (resolved.ok) {
  // launch background synthesis ... ← NEVER REACHED for keyless providers
}
// falls through to synchronous "📥 N source(s) ready" — no synthesis, no ingest event
```

The synchronous fallback looks like success to the agent and user, so the bug is invisible.

**The fix:** Remove `|| !auth.apiKey`. The `!auth.ok` clause alone is sufficient — when a provider *requires* auth and has no key, the host returns `{ ok: false }`. When a provider needs no key, `{ ok: true }` without `apiKey` is correct.

---

## Files

| Action | File | Purpose |
|--------|------|---------|
| Modify | `extensions/llm-wiki/lib/runtime.ts:135-141` | Fix the auth gate |
| Modify | `test/runtime.test.ts` — `makeRegistry` + new test | Add keyless provider test |

---

### Task 1: Fix the auth gate in resolveModel

**Files:**
- Modify: `extensions/llm-wiki/lib/runtime.ts:135-140`

- [ ] **Step 1: Read the current code to confirm the line numbers**

```bash
awk 'NR>=133 && NR<=143' extensions/llm-wiki/lib/runtime.ts
```

Expected: lines 135-136 show `if (!auth.ok || !auth.apiKey)` and line 141 shows `apiKey: auth.apiKey`.

- [ ] **Step 2: Apply the fix**

Edit `extensions/llm-wiki/lib/runtime.ts` — replace lines 135-140:

Old:
```ts
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      const provider = (model as { provider?: string }).provider ?? "unknown";
      return { ok: false, reason: `no API key for provider "${provider}"` };
    }
    return { ok: true, model, apiKey: auth.apiKey, headers: auth.headers };
```

New:
```ts
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const provider = (model as { provider?: string }).provider ?? "unknown";
      return { ok: false, reason: `no API key for provider "${provider}"` };
    }
    return { ok: true, model, apiKey: auth.apiKey ?? "", headers: auth.headers };
```

Two changes:
1. `|| !auth.apiKey` removed from the condition (line 136)
2. `auth.apiKey` → `auth.apiKey ?? ""` on the return (line 140) — defaults to empty string for keyless providers

- [ ] **Step 3: Run typecheck to verify no type errors**

```bash
pnpm typecheck
```

Expected: clean exit (no errors). The `apiKey` field is typed `string` in `ResolveResult`; `?? ""` satisfies it.

---

### Task 2: Update tests — existing + new keyless provider case

**Files:**
- Modify: `test/runtime.test.ts` — `makeRegistry` helper + new test

- [ ] **Step 1: Read the existing test to confirm it still applies**

```bash
awk 'NR>=176 && NR<=181' test/runtime.test.ts
```

Expected: the test uses `authOk: false` — this tests "provider requires auth but has no key" → should still be rejected. This test is correct and stays unchanged.

- [ ] **Step 2: Fix `makeRegistry` to support explicit `apiKey: undefined`**

The current `makeRegistry` defaults `apiKey` to `"key-123"` when `authOk: true`, so passing `apiKey: undefined` doesn't produce the keyless scenario. Fix the helper to use `"apiKey" in opts` to distinguish "not passed" from "explicitly undefined":

Old:
```ts
function makeRegistry(opts: {
  found?: unknown;
  authOk?: boolean;
  apiKey?: string;
}) {
  return {
    find: (_p: string, _i: string) => opts.found,
    getApiKeyAndHeaders: async (_m: unknown) => ({
      ok: opts.authOk ?? true,
      apiKey: opts.apiKey ?? (opts.authOk === false ? undefined : "key-123"),
      headers: { "x-test": "1" },
    }),
  };
}
```

New:
```ts
function makeRegistry(opts: {
  found?: unknown;
  authOk?: boolean;
  apiKey?: string | undefined;
  _apiKeySet?: boolean; // true when caller explicitly passed apiKey
}) {
  const apiKeyExplicit = opts._apiKeySet ?? false;
  return {
    find: (_p: string, _i: string) => opts.found,
    getApiKeyAndHeaders: async (_m: unknown) => ({
      ok: opts.authOk ?? true,
      // When apiKey was explicitly passed (even as undefined), use it as-is.
      // When omitted, default: "key-123" for auth-ok, undefined for auth-fail.
      apiKey: apiKeyExplicit ? opts.apiKey : (opts.authOk === false ? undefined : "key-123"),
      headers: { "x-test": "1" },
    }),
  };
}
```

And update all existing call sites to pass `_apiKeySet: false` (or omit it — the default handles existing tests). Only the new keyless test passes `_apiKeySet: true`.

- [ ] **Step 3: Add the new keyless provider test**

After the existing "returns ok:false when the provider has no API key" test (line 181), add:

```ts
  it("accepts a keyless provider (authOk, no apiKey)", async () => {
    const rt = new Runtime();
    const reg = makeRegistry({ found: undefined, authOk: true, apiKey: undefined, _apiKeySet: true });
    const res = await rt.resolveModel({ model: SESSION_MODEL, modelRegistry: reg, hasUI: false });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.model).toBe(SESSION_MODEL);
      expect(res.apiKey).toBe("");
      expect(res.headers).toEqual({ "x-test": "1" });
    }
  });
```

This tests the exact scenario from #174: `getApiKeyAndHeaders` returns `{ ok: true, apiKey: undefined }` (keyless provider). The fix should make this pass.

- [ ] **Step 3: Run the test suite**

```bash
pnpm test
```

Expected: all tests pass, including the new keyless provider test. The existing "no API key" test (authOk: false) still passes — it tests a different case.

- [ ] **Step 4: Run the full gate (typecheck + lint + test)**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add extensions/llm-wiki/lib/runtime.ts test/runtime.test.ts
git commit -m "fix: accept keyless providers in resolveModel (closes #174)

remove the !auth.apiKey guard that wrongly rejected providers where
getApiKeyAndHeaders returns ok:true without an apiKey field (the correct
response for keyless local servers like llama.cpp). apiKey defaults to
\"\" for keyless providers, which local servers ignore.

adds a test for the keyless provider case (authOk, no apiKey)."
```

---

### Task 3: Verify end-to-end

- [ ] **Step 1: Run the full test suite one final time**

```bash
pnpm test
```

Expected: 725+ tests pass (725 from last session + 1 new = 726).

- [ ] **Step 2: Check git diff to confirm minimal change**

```bash
git diff HEAD~1 --stat
```

Expected: 2 files changed, ~3 lines removed, ~10 lines added (test).

- [ ] **Step 3: Verify no other callers of resolveModel are affected**

```bash
grep -rn "resolveModel" extensions/ --include="*.ts"
```

Expected: only `runtime.ts` (definition) and `tools.ts` (caller). Both are safe — `tools.ts` already handles `ok: true` with empty `apiKey` via `runSubAgent`.

---

## What was skipped

- **Docs update:** No user-facing docs change needed — this is a bug fix, not a feature. The `docs/configuration.md` already documents `taskModel` configuration. The fix makes the documented behavior actually work for keyless providers.
- **Changelog entry:** Will be captured in the PR description and release notes when merged.

## When to add

- **Robustness:** If a provider returns `{ ok: true, apiKey: "" }` explicitly (not just undefined), the `?? ""` still handles it correctly.
- **End-to-end test with real llama.cpp:** Not feasible in CI (needs a running local server), but the unit test covers the exact code path. Manual verification: point pi at a keyless local provider, run `wiki_capture_source` + `wiki_ingest`, confirm background synthesis launches.
