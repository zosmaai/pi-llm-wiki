import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureTrajectory,
  extractTrajectoryFromSession,
} from "../extensions/llm-wiki/lib/trajectory.js";
import { ensureVaultStructure, getVaultPaths, readJson } from "../extensions/llm-wiki/lib/utils.js";
import { readFile } from "./helpers.js";

describe("agent trajectory memory", () => {
  let wikiDir: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `trajectory-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    wikiDir = join(tmpDir, "vault");
    mkdirSync(wikiDir, { recursive: true });
    const paths = getVaultPaths(wikiDir);
    ensureVaultStructure(paths);
    writeFileSync(
      join(paths.dotWiki, "config.json"),
      JSON.stringify({ topic: "Test", mode: "personal" }),
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("does not eagerly create trajectory dirs (opt-in, lazy on first capture)", () => {
    // Issue #80: an inactive vault carries no trace of the feature.
    const paths = getVaultPaths(wikiDir);
    expect(existsSync(paths.rawTrajectories)).toBe(false);
    expect(existsSync(join(paths.wiki, "cases"))).toBe(false);
    expect(existsSync(join(paths.wiki, "skills"))).toBe(false);

    // raw/trajectories is created on demand by the first capture.
    captureTrajectory(paths, { steps: [{ role: "user", text: "hi" }] });
    expect(existsSync(paths.rawTrajectories)).toBe(true);
  });

  it("captures a trajectory packet with a self-contained summary (no skeleton)", () => {
    const paths = getVaultPaths(wikiDir);
    const result = captureTrajectory(paths, {
      title: "Fix login timeout",
      task: "The login endpoint times out under load",
      model: "test/model-1",
      steps: [
        { role: "user", text: "The login endpoint times out under load" },
        {
          role: "assistant",
          text: "Let me check the query.",
          tool_calls: [{ id: "c1", name: "read", arguments: { path: "auth.ts" } }],
        },
        {
          role: "tool",
          tool_call_id: "c1",
          tool_name: "read",
          text: "...file...",
          is_error: false,
        },
      ],
    });

    // ID format
    expect(result.trajectoryId).toMatch(/^TRJ-\d{4}-\d{2}-\d{2}-\d{3}$/);

    // packet.json is the immutable full trajectory
    const packet = readJson<Record<string, unknown>>(join(result.packetPath, "packet.json"), {});
    expect(packet.id).toBe(result.trajectoryId);
    expect(packet.prompt).toBe("The login endpoint times out under load");
    expect(packet.model).toBe("test/model-1");
    expect(Array.isArray(packet.steps)).toBe(true);
    expect((packet.steps as unknown[]).length).toBe(3);

    // manifest.json keeps it uniform with source packets
    const manifest = readJson<Record<string, unknown>>(
      join(result.packetPath, "manifest.json"),
      {},
    );
    expect(manifest.format).toBe("trajectory");
    expect(manifest.tool_call_count).toBe(1);

    // README/extracted summary is self-contained — no [LLM:] placeholders to flesh.
    const readme = readFile(join(result.packetPath, "extracted.md"));
    expect(readme).toContain("Fix login timeout");
    expect(readme).toContain("`read`");
    expect(readme).not.toContain("[LLM:");

    // No skeleton case page is emitted; capture does not create wiki/cases/.
    expect(existsSync(join(paths.wiki, "cases"))).toBe(false);
  });

  it("registers the trajectory in metadata as type 'trajectory'", () => {
    const paths = getVaultPaths(wikiDir);
    const result = captureTrajectory(paths, {
      title: "Refactor parser",
      steps: [{ role: "user", text: "refactor the parser" }],
    });
    const registry = readJson<{ pages: Record<string, { type: string }> }>(
      join(paths.meta, "registry.json"),
      { pages: {} },
    );
    const trajId = `trajectories/${result.trajectoryId}`;
    expect(registry.pages[trajId]).toBeTruthy();
    expect(registry.pages[trajId].type).toBe("trajectory");
  });

  it("assigns sequential TRJ ids on the same day", () => {
    const paths = getVaultPaths(wikiDir);
    const r1 = captureTrajectory(paths, { steps: [{ role: "user", text: "a" }] });
    const r2 = captureTrajectory(paths, { steps: [{ role: "user", text: "b" }] });
    expect(r1.trajectoryId).not.toBe(r2.trajectoryId);
    const dirs = readdirSync(paths.rawTrajectories).filter((d) => d.startsWith("TRJ-"));
    expect(dirs.length).toBe(2);
  });

  it("extracts a normalized trajectory from a session-manager-like object", () => {
    const sessionManager = {
      getBranch: () => [
        { type: "model_change", provider: "x", modelId: "y" },
        {
          type: "message",
          message: { role: "user", content: "do the thing", timestamp: 1 },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            model: "anthropic/claude",
            content: [
              { type: "text", text: "working on it" },
              { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
            ],
            timestamp: 2,
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "bash",
            content: [{ type: "text", text: "file1\nfile2" }],
            isError: false,
            timestamp: 3,
          },
        },
      ],
    };

    const { steps, model, prompt } = extractTrajectoryFromSession(sessionManager);
    expect(prompt).toBe("do the thing");
    expect(model).toBe("anthropic/claude");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ role: "user", text: "do the thing" });
    expect(steps[1].tool_calls?.[0]).toMatchObject({ id: "t1", name: "bash" });
    expect(steps[2]).toMatchObject({ role: "tool", tool_name: "bash", is_error: false });
  });

  it("returns empty steps for an empty / unknown session manager", () => {
    expect(extractTrajectoryFromSession(undefined).steps).toEqual([]);
    expect(extractTrajectoryFromSession({}).steps).toEqual([]);
    expect(extractTrajectoryFromSession({ getBranch: () => [] }).steps).toEqual([]);
  });
});
