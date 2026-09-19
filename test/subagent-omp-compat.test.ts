import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type RunSubAgentArgs, runSubAgent } from "../extensions/llm-wiki/lib/subagent.js";

/**
 * omp (compiled binary) rewrites @earendil-works/* specifiers at load time to
 * its bundled @oh-my-pi/* copies (omp-legacy-pi-bundled:), and the bundled
 * pi-agent-core dropped runAgentLoop — it only exports agentLoop (which
 * returns an EventStream instead of taking an emit callback). A static
 * `import { runAgentLoop }` therefore fails extension validation under omp:
 * "Export named 'runAgentLoop' not found".
 *
 * This file simulates the omp-bundled pi-agent-core (module WITHOUT
 * runAgentLoop) and pins the contract:
 *   1. runSubAgent must still drive the loop to completion via the
 *      agentLoop + for-await fallback — no static import to fail;
 *   2. a stream failure must REJECT runSubAgent (catchable by
 *      BackgroundRuntime.launchTask's try/catch → warning toast), never
 *      crash the process or hang (issue #222 contract preserved).
 */

// The omp-bundled surface: agentLoop exists, runAgentLoop does not. Return
// runAgentLoop: undefined explicitly — vitest's mock proxy throws on access
// to an absent named export, which would mask the feature-detection path we
// are pinning (the real omp synthetic module resolves a missing export to
// undefined, like any ESM namespace). vi.hoisted keeps the mock fn available
// to the hoisted vi.mock factory before any module under test is loaded
// (pre-fix subagent.ts statically imports runAgentLoop, which forces the
// factory to run at load time).
const { agentLoopMock } = vi.hoisted(() => ({ agentLoopMock: vi.fn() }));

vi.mock("@earendil-works/pi-agent-core", () => ({
  agentLoop: agentLoopMock,
  runAgentLoop: undefined,
}));

function fakeStreamFn(): StreamFn {
  return vi.fn() as unknown as StreamFn;
}

/** A stream whose async iterator yields `events` then completes/throws. */
function fakeEventStream(events: unknown[] = [], error?: Error): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
      if (error) throw error;
    },
  };
}

function baseArgs(): Omit<RunSubAgentArgs, "streamFn"> {
  return {
    model: { id: "test-model" } as unknown as Model<Api>,
    apiKey: "test-key",
    systemPrompt: "You are a test sub-agent.",
    userPrompt: "process this",
    tools: [] as AgentTool[],
    maxTokens: 256,
  };
}

describe("omp-bundled pi-agent-core (no runAgentLoop export)", () => {
  it("drives the loop via agentLoop and resolves", async () => {
    agentLoopMock.mockReturnValue(fakeEventStream());

    await expect(runSubAgent({ ...baseArgs(), streamFn: fakeStreamFn() })).resolves.toBeUndefined();

    expect(agentLoopMock).toHaveBeenCalledTimes(1);
    const [, context, _config, _signal, streamFn] = agentLoopMock.mock.calls[0];
    expect(context.messages).toEqual([]);
    expect(context.tools).toEqual([]);
    expect(streamFn).toBeDefined();
  });

  it("rejects when the agentLoop stream fails (issue #222 contract)", async () => {
    const failure = new Error("No API provider registered for api: test");
    agentLoopMock.mockReturnValue(fakeEventStream([], failure));

    await expect(runSubAgent({ ...baseArgs(), streamFn: fakeStreamFn() })).rejects.toThrow(
      "No API provider registered",
    );
  });
});
