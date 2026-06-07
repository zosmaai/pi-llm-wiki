import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureTrajectory,
  extractTrajectoryFromSession,
} from "../extensions/llm-wiki/lib/trajectory.js";
import { ensureVaultStructure, getVaultPaths, readJson } from "../extensions/llm-wiki/lib/utils.js";
import { readFile } from "./helpers.js";

/**
 * Integration test against pi's REAL SessionManager (not a hand-rolled mock).
 *
 * The unit tests in trajectory.test.ts feed extractTrajectoryFromSession a
 * hand-authored object shaped like a session. That proves the extractor works
 * on the *assumed* shape — but not that the shape matches what pi actually
 * produces. Because the extractor is intentionally shape-defensive (casts to
 * `unknown`), the TypeScript compiler does not enforce the contract either.
 *
 * This test closes that gap: it builds a real `SessionManager.inMemory()`,
 * appends messages through pi's real `appendMessage()` API (so pi — not us —
 * wraps them into SessionMessageEntry with the real `type:"message"` envelope),
 * then reads them back via the real `getBranch()` and runs the extractor on the
 * result. If pi ever changes its message/entry shape, this test breaks.
 */

describe("trajectory extraction — real pi SessionManager", () => {
  let tmpDir: string;
  let wikiDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `trj-int-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    wikiDir = join(tmpDir, "vault");
    mkdirSync(wikiDir, { recursive: true });
    const paths = getVaultPaths(wikiDir);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Integration", mode: "personal" }),
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("extracts a normalized trajectory from a real SessionManager.inMemory()", () => {
    const sm = SessionManager.inMemory(tmpDir);

    // Append through pi's REAL API. pi owns the entry envelope and ordering.
    sm.appendModelChange("anthropic", "claude-haiku-4-5");
    sm.appendMessage({
      role: "user",
      content: "List the files and read notes.txt",
      timestamp: 1,
    });
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "I'll list the files first." },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { cmd: "ls -la" } },
      ],
      // Required AssistantMessage fields, supplied as a real model would.
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
      // biome-ignore lint/suspicious/noExplicitAny: constructing a real AssistantMessage in a test
    } as any);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "bash",
      content: [{ type: "text", text: "notes.txt\npackage.json" }],
      isError: false,
      timestamp: 3,
      // biome-ignore lint/suspicious/noExplicitAny: constructing a real ToolResultMessage in a test
    } as any);

    // Read back through the REAL getBranch() and run the extractor.
    const { steps, model, prompt } = extractTrajectoryFromSession(sm);

    expect(prompt).toBe("List the files and read notes.txt");
    expect(model).toBe("claude-haiku-4-5");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ role: "user", text: "List the files and read notes.txt" });
    expect(steps[1].role).toBe("assistant");
    expect(steps[1].text).toContain("list the files");
    expect(steps[1].tool_calls?.[0]).toMatchObject({ id: "tc-1", name: "bash" });
    expect(steps[2]).toMatchObject({ role: "tool", tool_name: "bash", is_error: false });
    expect(steps[2].text).toContain("notes.txt");
  });

  it("captures a full packet from a real-SessionManager extraction (end-to-end)", () => {
    const sm = SessionManager.inMemory(tmpDir);
    sm.appendMessage({ role: "user", content: "Fix the failing build", timestamp: 1 });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "tsconfig.json" } }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
      // biome-ignore lint/suspicious/noExplicitAny: constructing a real AssistantMessage in a test
    } as any);

    const extracted = extractTrajectoryFromSession(sm);
    const paths = getVaultPaths(wikiDir);
    const result = captureTrajectory(paths, {
      title: "Fix the failing build",
      task: extracted.prompt,
      steps: extracted.steps,
      model: extracted.model,
    });

    // Packet written from a real-session extraction.
    const packet = readJson<Record<string, unknown>>(join(result.packetPath, "packet.json"), {});
    expect(packet.prompt).toBe("Fix the failing build");
    expect(packet.model).toBe("claude-haiku-4-5");
    expect((packet.steps as unknown[]).length).toBe(2);

    // Skeleton case page + README produced.
    expect(existsSync(result.casePagePath)).toBe(true);
    const readme = readFile(join(result.packetPath, "extracted.md"));
    expect(readme).toContain("`read`");
  });
});
