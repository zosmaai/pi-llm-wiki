import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildMetadataLight } from "../extensions/llm-wiki/lib/metadata.js";
import {
  createReminderState,
  registerObservationReminder,
  saveObservation,
} from "../extensions/llm-wiki/lib/observation.js";
import { searchWiki } from "../extensions/llm-wiki/lib/recall.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

describe("wiki observation", () => {
  let tmpDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `observation-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vaultDir = (() => {
      const dir = join(tmpDir, `vault-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const llmWiki = join(dir, ".llm-wiki");
      const dirs = [
        "raw/articles",
        "raw/papers",
        "raw/notes",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/syntheses",
        "meta",
        "outputs",
        ".discoveries",
      ];
      for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });
      return dir;
    })();
    ensureVaultStructure(getVaultPaths(vaultDir));

    // Write config.json
    const dotWiki = join(vaultDir, ".llm-wiki");
    writeFileSync(
      join(dotWiki, "config.json"),
      JSON.stringify({
        topic: "Test Vault",
        mode: "personal",
        created: "2026-05-27",
        version: "1.0",
      }),
      "utf-8",
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("should save an observation and create a page file", () => {
    const paths = getVaultPaths(vaultDir);
    const result = saveObservation(paths, {
      title: "JWT auth middleware added",
      content:
        "User decided to use JWT with refresh tokens. Implementation at src/auth/jwt.ts. Tests passing.",
      relevance: "high",
      tags: "auth jwt backend",
      source_context: "Adding authentication module",
    });

    expect(result.slug).toContain("obs-");
    expect(result.slug).toContain("jwt-auth-middleware-added");
    expect(existsSync(result.pagePath)).toBe(true);

    const content = readFileSync(result.pagePath, "utf-8");
    expect(content).toContain("Observation: JWT auth middleware added");
    expect(content).toContain("User decided to use JWT with refresh tokens");
    expect(content).toContain("relevance: high");
    expect(content).toContain("- auth");
    expect(content).toContain("- jwt");
    expect(content).toContain("- backend");
    expect(content).toContain("source_context: Adding authentication module");
  });

  it("should save an observation with default optional fields", () => {
    const paths = getVaultPaths(vaultDir);
    const result = saveObservation(paths, {
      title: "Quick fix applied",
      content: "Fixed the login timeout bug by increasing TTL.",
      relevance: "medium",
    });

    expect(existsSync(result.pagePath)).toBe(true);
    const content = readFileSync(result.pagePath, "utf-8");
    expect(content).toContain("relevance: medium");
    expect(content).not.toContain("tags:");
    expect(content).not.toContain("source_context:");
  });

  it("should save an observation with critical relevance", () => {
    const paths = getVaultPaths(vaultDir);
    const result = saveObservation(paths, {
      title: "User is colorblind",
      content: "User stated they are colorblind; red/green indicators do not work for them.",
      relevance: "critical",
    });

    const content = readFileSync(result.pagePath, "utf-8");
    expect(content).toContain("relevance: critical");
  });

  it("should make observations searchable via wiki_recall", () => {
    const paths = getVaultPaths(vaultDir);
    saveObservation(paths, {
      title: "Postgres migration constraint",
      content:
        "Migration from MySQL to Postgres: discovered that JSONB queries use different syntax.",
      relevance: "high",
      tags: "migration postgres database",
    });

    rebuildMetadataLight(paths);
    const results = searchWiki(paths, "postgres migration");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title.includes("Postgres migration"))).toBe(true);
  });

  it("should search observation content in wiki_recall", () => {
    const paths = getVaultPaths(vaultDir);
    saveObservation(paths, {
      title: "Auth decision",
      content: "Team chose Lucia for session-based auth over NextAuth and Clerk.",
      relevance: "high",
      tags: "auth decision",
    });

    rebuildMetadataLight(paths);
    // Search for content-specific terms
    const results = searchWiki(paths, "Lucia session-based auth");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title.includes("Auth decision"))).toBe(true);
  });

  it("should handle multiple observations independently", () => {
    const paths = getVaultPaths(vaultDir);
    const obs1 = saveObservation(paths, {
      title: "First finding",
      content: "Found bug in login flow.",
      relevance: "high",
    });
    const obs2 = saveObservation(paths, {
      title: "Second finding",
      content: "Fixed the bug by adding validation.",
      relevance: "medium",
    });

    expect(obs1.slug).not.toBe(obs2.slug);
    expect(existsSync(obs1.pagePath)).toBe(true);
    expect(existsSync(obs2.pagePath)).toBe(true);

    const content1 = readFileSync(obs1.pagePath, "utf-8");
    const content2 = readFileSync(obs2.pagePath, "utf-8");
    expect(content1).toContain("First finding");
    expect(content2).toContain("Second finding");
  });

  it("should slugify titles correctly", () => {
    const paths = getVaultPaths(vaultDir);
    const result = saveObservation(paths, {
      title: "Complex/Edge Case: 100% Done!",
      content: "Edge case handling completed.",
      relevance: "low",
    });

    expect(result.slug).toContain("complex-edge-case-100-done");
    expect(result.slug).not.toContain("//");
    expect(result.slug).not.toContain("_");
  });
});

// ─── registerObservationReminder (retry deduplication) ──────────────────────

/**
 * Helper to create a mock pi that captures event handlers and sent messages.
 * Returns the mock pi, a way to emit events, and the collected messages.
 */
function createMockPi() {
  const handlers: Record<
    string,
    Array<(event: unknown, ctx: unknown) => void | Promise<void>>
  > = {};
  const messages: Array<{
    msg: { customType: string; content: string; display: boolean };
    opts: { deliverAs: string };
  }> = [];

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    sendMessage: (
      msg: { customType: string; content: string; display: boolean },
      opts: { deliverAs: string },
    ) => {
      messages.push({ msg, opts });
    },
  } as unknown as ExtensionAPI;

  const emit = async (event: string, eventData?: unknown) => {
    for (const h of handlers[event] ?? []) {
      await h(eventData ?? {}, {});
    }
  };

  return { pi, emit, messages, handlers };
}

describe("registerObservationReminder — retry deduplication", () => {
  it("sends reminder after N turns (default 5)", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 3 });

    // Simulate 2 agent_end events — no reminder yet (below threshold)
    await emit("agent_end", {});
    await emit("agent_end", {});
    expect(messages).toHaveLength(0);

    // 3rd agent_end — reminder fires
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);
    expect(messages[0].msg.customType).toBe("wiki-observe-reminder");
    expect(messages[0].opts.deliverAs).toBe("nextTurn");
  });

  it("skips reminder when willRetry is true (connection retry dedup)", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 1 });

    // Simulate 3 retries — all with willRetry: true
    await emit("agent_end", { willRetry: true });
    await emit("agent_end", { willRetry: true });
    await emit("agent_end", { willRetry: true });

    // No reminder should have been queued
    expect(messages).toHaveLength(0);
  });

  it("sends reminder only on final agent_end after retries", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 1 });

    // 2 retries, then final success
    await emit("agent_end", { willRetry: true });
    await emit("agent_end", { willRetry: true });
    await emit("agent_end", { willRetry: false }); // final

    // Only 1 reminder (from the final event)
    expect(messages).toHaveLength(1);
    expect(messages[0].msg.customType).toBe("wiki-observe-reminder");
  });

  it("does not count retries toward the turn interval", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 3 });

    // 5 retries (should be skipped and not count)
    for (let i = 0; i < 5; i++) {
      await emit("agent_end", { willRetry: true });
    }

    // Now 2 normal turns — still below threshold
    await emit("agent_end", {});
    await emit("agent_end", {});
    expect(messages).toHaveLength(0);

    // 3rd normal turn — fires
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);
  });

  it("skips reminder when observeDoneThisSession is true", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 1 });

    // Simulate wiki_observe being called
    state.observeDoneThisSession = true;

    await emit("agent_end", {});
    expect(messages).toHaveLength(0);
  });

  it("resets state on session_start", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 1 });

    // Complete some turns, then session_start resets
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);

    state.observeDoneThisSession = true; // pretend observe was called
    await emit("session_start");

    // State reset — reminder can fire again after threshold
    await emit("agent_end", {});
    expect(messages).toHaveLength(2);
  });

  it("resets turn counter on session_compact but preserves observeDoneThisSession", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 1 });

    await emit("agent_end", {});
    state.observeDoneThisSession = true;

    await emit("session_compact");

    // Compaction must NOT resurrect the nag — observeDoneThisSession preserved
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);
  });

  it("allows reminder to resume after session_compact when observe not done", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 1 });

    // 1 turn fires reminder (counter resets after queueing)
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);

    // Compaction happens mid-retry within the same user turn — it must not
    // re-arm the reminder on its own.
    await emit("session_compact");
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);

    // A new user turn re-arms the reminder
    await emit("message_start", { message: { role: "user" } });
    await emit("agent_end", {});
    expect(messages).toHaveLength(2);
  });

  it("handles willRetry undefined (legacy pi versions)", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 1 });

    // event without willRetry field at all
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);
  });

  it("queues at most one reminder per user turn on retry storms (no willRetry field)", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 1 });

    // One user turn: original run + 4 rate-limit retries = 5 agent_end events.
    // pi never forwards willRetry to extensions (zosmaai/pi-llm-wiki#151), so
    // each event looks like a normal turn end.
    await emit("message_start", { message: { role: "user" } });
    for (let i = 0; i < 5; i++) await emit("agent_end", {});
    expect(messages).toHaveLength(1);

    // The next user turn queues fresh
    await emit("message_start", { message: { role: "user" } });
    await emit("agent_end", {});
    expect(messages).toHaveLength(2);
  });

  it("re-queues only after REMINDER_INTERVAL user turns, not on the next agent_end", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, { turnsBetweenReminders: 2 });

    const userTurn = async () => {
      await emit("message_start", { message: { role: "user" } });
      await emit("agent_end", {});
    };

    await userTurn();
    expect(messages).toHaveLength(0);
    await userTurn(); // 2nd user turn crosses the interval
    expect(messages).toHaveLength(1);
    await userTurn(); // counter reset after queueing — must not re-queue
    expect(messages).toHaveLength(1);
    await userTurn(); // interval elapsed again
    expect(messages).toHaveLength(2);
  });

  it("respects display option (false = silent injection)", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    registerObservationReminder(pi, state, {
      turnsBetweenReminders: 1,
      display: false,
    });

    await emit("agent_end", {});
    expect(messages).toHaveLength(1);
    expect(messages[0].msg.display).toBe(false);
  });

  it("respects display option as function resolver", async () => {
    const { pi, emit, messages } = createMockPi();
    const state = createReminderState();
    let noticesOn = true;
    registerObservationReminder(pi, state, {
      turnsBetweenReminders: 1,
      display: () => noticesOn,
    });

    await emit("agent_end", {});
    expect(messages[0].msg.display).toBe(true);

    noticesOn = false;
    // Same user turn: a retry-style agent_end must not re-queue
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);

    // A new user turn re-arms, and display is re-resolved
    await emit("message_start", { message: { role: "user" } });
    await emit("agent_end", {});
    expect(messages).toHaveLength(2);
    expect(messages[1].msg.display).toBe(false);
  });
});
