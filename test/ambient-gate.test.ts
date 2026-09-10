import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReminderState,
  registerObservationReminder,
} from "../extensions/llm-wiki/lib/observation.js";
import { loadTaskConfig, personalVaultIsAmbient } from "../extensions/llm-wiki/lib/task-config.js";
import {
  getPersonalWikiRoot,
  resolveProjectVaultRoot,
  resolveVaultRoot,
} from "../extensions/llm-wiki/lib/utils.js";

/**
 * Ambient surfaces (session notice, observe/retro reminder, before_agent_start
 * recall) must stay silent in a repository that never initialized a wiki.
 *
 * They used to fire everywhere: `resolveVaultRoot` falls back to the personal
 * vault, so once `~/.llm-wiki` existed every unrelated directory looked like it
 * had a wiki. Under omp the plugin is installed once and loads in every
 * project, which turned that fallback into reminders and cross-project recall
 * hits in repositories that have nothing to do with the wiki.
 */

let tmpDir: string;
let priorWikiHome: string | undefined;

beforeEach(() => {
  tmpDir = join(tmpdir(), `llm-wiki-ambient-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  priorWikiHome = process.env.WIKI_HOME;
  for (const key of ["WIKI_HOME"] as const) delete process.env[key];
});

afterEach(() => {
  for (const key of ["WIKI_HOME"] as const) {
    if (priorWikiHome === undefined) delete process.env[key];
    else process.env[key] = priorWikiHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a vault sentinel (the directory is all `detectVaultFormat` needs). */
function makeVault(dir: string): string {
  mkdirSync(join(dir, ".llm-wiki"), { recursive: true });
  return dir;
}

describe("resolveProjectVaultRoot", () => {
  it("returns null when neither cwd nor any ancestor has a vault", () => {
    const project = join(tmpDir, "no-vault");
    mkdirSync(project, { recursive: true });
    expect(resolveProjectVaultRoot(project)).toBeNull();
  });

  it("returns cwd when the project itself has a vault", () => {
    const project = makeVault(join(tmpDir, "own-vault"));
    expect(resolveProjectVaultRoot(project)).toBe(project);
  });

  it("walks up to an ancestor vault (monorepo / nested workspace)", () => {
    const root = makeVault(join(tmpDir, "mono"));
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectVaultRoot(nested)).toBe(root);
  });

  it("honors an explicit WIKI_HOME over an ancestor walk", () => {
    const root = makeVault(join(tmpDir, "mono2"));
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    process.env.WIKI_HOME = join(tmpDir, "chosen");
    expect(resolveProjectVaultRoot(nested)).toBe(join(tmpDir, "chosen"));
  });

  it("never reports the personal-vault fallback as a project vault", () => {
    const project = join(tmpDir, "unrelated");
    mkdirSync(project, { recursive: true });
    // The personal root is what `resolveVaultRoot` falls back to; the project
    // resolver must not confuse the two, whether or not a personal vault exists.
    expect(resolveVaultRoot(project)).toBe(getPersonalWikiRoot());
    expect(resolveProjectVaultRoot(project)).toBeNull();
  });
});

describe("personalVaultIsAmbient", () => {
  it("defaults per host: on under pi, off under omp", () => {
    expect(personalVaultIsAmbient(undefined, "pi")).toBe(true);
    expect(personalVaultIsAmbient({}, "pi")).toBe(true);
    expect(personalVaultIsAmbient(undefined, "omp")).toBe(false);
    expect(personalVaultIsAmbient({}, "omp")).toBe(false);
  });

  it("an explicit setting wins on either host", () => {
    expect(personalVaultIsAmbient({ ambientPersonalVault: false }, "pi")).toBe(false);
    expect(personalVaultIsAmbient({ ambientPersonalVault: true }, "omp")).toBe(true);
  });

  it("is read from the llm-wiki settings namespace", () => {
    const project = join(tmpDir, "cfg");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(
      join(project, ".omp", "settings.json"),
      JSON.stringify({ "llm-wiki": { ambientPersonalVault: true } }),
    );
    expect(loadTaskConfig(project).ambientPersonalVault).toBe(true);
    expect(personalVaultIsAmbient(loadTaskConfig(project), "omp")).toBe(true);
  });

  it("ignores a non-boolean value and falls back to the host default", () => {
    const project = join(tmpDir, "cfg-bad");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(
      join(project, ".omp", "settings.json"),
      JSON.stringify({ "llm-wiki": { ambientPersonalVault: "yes" } }),
    );
    expect(loadTaskConfig(project).ambientPersonalVault).toBeUndefined();
    expect(personalVaultIsAmbient(loadTaskConfig(project), "omp")).toBe(false);
  });
});

// ─── the gate as index.ts composes it ─────────────────────

/** Exactly the expression `index.ts` uses for every ambient surface. */
function wikiAppliesTo(
  cwd: string,
  config: Parameters<typeof personalVaultIsAmbient>[0],
  host: "pi" | "omp",
) {
  return resolveProjectVaultRoot(cwd) !== null || personalVaultIsAmbient(config, host);
}

describe("ambient gate", () => {
  it("stays closed under omp for a project with no wiki", () => {
    const project = join(tmpDir, "plain");
    mkdirSync(project, { recursive: true });
    expect(wikiAppliesTo(project, {}, "omp")).toBe(false);
  });

  it("opens under omp as soon as the project has a wiki", () => {
    const project = makeVault(join(tmpDir, "inited"));
    expect(wikiAppliesTo(project, {}, "omp")).toBe(true);
  });

  it("opens under omp when the user opts the personal vault back in", () => {
    const project = join(tmpDir, "opted-in");
    mkdirSync(project, { recursive: true });
    expect(wikiAppliesTo(project, { ambientPersonalVault: true }, "omp")).toBe(true);
  });

  it("stays open under pi for a project with no wiki (historical behavior)", () => {
    const project = join(tmpDir, "pi-plain");
    mkdirSync(project, { recursive: true });
    expect(wikiAppliesTo(project, {}, "pi")).toBe(true);
  });
});

// ─── reminder gate ────────────────────────────────────────

interface Sent {
  msg: { customType: string; content: string; display: boolean };
}

function mockPi() {
  const handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
  const messages: Sent[] = [];
  const pi = {
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    sendMessage: (msg: Sent["msg"]) => {
      messages.push({ msg });
    },
  } as unknown as ExtensionAPI;
  const emit = async (event: string, data?: unknown) => {
    for (const h of handlers[event] ?? []) await h(data ?? {}, {});
  };
  return { pi, emit, messages };
}

describe("registerObservationReminder — ambient gate", () => {
  it("never sends while the gate is closed, however many turns pass", async () => {
    const { pi, emit, messages } = mockPi();
    registerObservationReminder(pi, createReminderState(), {
      turnsBetweenReminders: 1,
      enabled: () => false,
    });
    for (let i = 0; i < 10; i++) await emit("agent_end", {});
    expect(messages).toHaveLength(0);
  });

  it("does not bank turns while closed, so opening the gate is not an instant nag", async () => {
    const { pi, emit, messages } = mockPi();
    let open = false;
    registerObservationReminder(pi, createReminderState(), {
      turnsBetweenReminders: 3,
      enabled: () => open,
    });

    for (let i = 0; i < 5; i++) await emit("agent_end", {});
    expect(messages).toHaveLength(0);

    // Session moved into a wiki-bearing project: the counter starts from zero.
    open = true;
    await emit("agent_end", {});
    await emit("agent_end", {});
    expect(messages).toHaveLength(0);
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);
    expect(messages[0].msg.customType).toBe("wiki-observe-reminder");
  });

  it("sends as before when no gate is supplied", async () => {
    const { pi, emit, messages } = mockPi();
    registerObservationReminder(pi, createReminderState(), { turnsBetweenReminders: 1 });
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);
  });

  it("display:false is not a substitute — it still injects", async () => {
    const { pi, emit, messages } = mockPi();
    registerObservationReminder(pi, createReminderState(), {
      turnsBetweenReminders: 1,
      display: false,
    });
    await emit("agent_end", {});
    expect(messages).toHaveLength(1);
    expect(messages[0].msg.display).toBe(false);
  });
});
