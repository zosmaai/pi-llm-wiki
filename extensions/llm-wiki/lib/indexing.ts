/**
 * Non-blocking vault (re)indexing.
 *
 * Writing a wiki page (observe / retro / capture / ensure_page) and editing one
 * by hand both require the derived metadata — `meta/registry.json`,
 * `backlinks.json`, `index.md`, `log.md` — to be rebuilt, plus (optionally) the
 * semantic embedding store to be refreshed. That rebuild is O(pages): it
 * rescans every page in the vault. Doing it inline on the tool's / turn's
 * critical path makes every write get slower as the vault grows.
 *
 * `scheduleReindex` moves that work off the caller's stack onto the shared
 * background Runtime (#64) and coalesces a burst of writes into a single pass:
 *
 *   - A leading micro-yield guarantees the caller (a tool's `execute`, or the
 *     turn_end handler) returns BEFORE the heavy rebuild runs.
 *   - A per-vault `dirty` flag + drain loop means writes that land while a pass
 *     is in flight are folded into a trailing rebuild instead of being lost —
 *     this also covers the async window of the embeddings refresh.
 *   - A per-vault `inflight` guard collapses concurrent schedule calls onto the
 *     same promise (single-flight), so N writes in a turn cost one rebuild.
 *
 * Errors are isolated by `Runtime.launchTask`; the promise never rejects. The
 * embeddings step is a no-op unless an embedder is configured (#66/#67).
 */

import { reindexEmbeddings, resolveEmbedder } from "./embeddings.js";
import { rebuildMetadataLight } from "./metadata.js";
import type { LaunchCtx, Runtime } from "./runtime.js";
import type { VaultPaths } from "./utils.js";

/** Promise of the current background pass, keyed by vault root. */
const inflight = new Map<string, Promise<void>>();
/** Vault roots with writes awaiting a (re)build. */
const dirty = new Set<string>();

/** Stable single-flight label for a vault's background index pass. */
export function indexLabel(root: string): string {
  return `index:${root}`;
}

/**
 * Schedule a non-blocking metadata rebuild (+ embeddings refresh) for a vault.
 * Returns the promise of the in-flight pass so callers/tests can await drainage
 * (the agent loop itself never awaits it). Safe to call on every write.
 */
export function scheduleReindex(
  runtime: Runtime,
  ctx: LaunchCtx,
  paths: VaultPaths,
): Promise<void> {
  const root = paths.root;
  dirty.add(root);

  const active = inflight.get(root);
  if (active) return active;

  const pass = runtime.launchTask(ctx, indexLabel(root), async () => {
    // Yield once so the caller returns before the O(pages) rebuild runs. This
    // is what makes the surrounding write non-blocking.
    await Promise.resolve();
    try {
      // Drain: keep rebuilding until no new write arrived during the previous
      // pass. The loop re-checks AFTER the awaited embeddings step, so writes
      // that land during embedding are not lost.
      while (dirty.has(root)) {
        dirty.delete(root);
        rebuildMetadataLight(paths);

        // Refresh embeddings only after metadata is consistent. Stale-aware and
        // a no-op unless an embedder is configured.
        runtime.ensureConfig(root);
        const embedder = resolveEmbedder(runtime.config);
        if (embedder) await reindexEmbeddings(paths, embedder);
      }
    } finally {
      inflight.delete(root);
    }
  });

  inflight.set(root, pass);
  return pass;
}

/** Test-only: clear coalescing state between cases. */
export function __resetIndexingState(): void {
  inflight.clear();
  dirty.clear();
}
