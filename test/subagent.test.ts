import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { type RunSubAgentArgs, runSubAgent } from "../extensions/llm-wiki/lib/subagent.js";

/**
 * Issue #222: when the background task model belongs to an
 * extension-registered provider, the sub-agent stream path throws
 * ("No API provider registered for api: X") inside agentLoop's *detached*
 * promise (void + .then, no .catch). The rejection escapes as an
 * uncaughtException and kills the entire pi process, while runSubAgent's
 * own await hangs on a stream that is never ended.
 *
 * These tests pin the contract:
 *   1. provider-side failures must REJECT runSubAgent (catchable by
 *      BackgroundRuntime.launchTask's try/catch → warning toast), never
 *      crash the process or hang;
 *   2. a provider's own streamSimple must be usable as `streamFn` so
 *      extension models can actually stream;
 *   3. Runtime.resolveModel must surface the registered provider's
 *      streamSimple as `streamFn` on the resolve result.
 */

// A model whose api is neither built into pi-ai nor in pi-ai's
// apiProviderRegistry — i.e. what an extension-registered provider looks
// like to the default stream path (e.g. claude-bridge on pi 0.85.x).
const CUSTOM_API_MODEL = {
  id: "bridge-model",
  name: "Bridge Model",
  api: "custom-bridge",
  provider: "bridge-prov",
  baseUrl: "http://localhost:9999",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000,
  maxTokens: 1024,
} as unknown as Model<Api>;

/** A minimal successful stream: one assistant text message, stop. */
function fakeStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "custom-bridge",
      provider: "bridge-prov",
      model: "bridge-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  return stream;
}

function baseArgs(): Omit<RunSubAgentArgs, "streamFn"> {
  return {
    model: CUSTOM_API_MODEL,
    apiKey: "k",
    systemPrompt: "sp",
    userPrompt: "hi",
    tools: [] as AgentTool[],
  };
}

// ── hardening: failures must reject, not crash or hang ───────────────
describe("issue #222 hardening", () => {
  it("runSubAgent rejects when the model's api is unregistered (no crash, no hang)", async () => {
    // Before the fix: the rejection escapes agentLoop's detached promise as
    // an uncaughtException (process dies) and this await never settles
    // (the stream is never ended), so the test crashes or times out.
    await expect(runSubAgent(baseArgs())).rejects.toThrow(
      /No API provider registered for api: custom-bridge/,
    );
  }, 15_000);

  it("runSubAgent resolves when a working streamFn is supplied for the custom api", async () => {
    const streamFn = vi.fn((_model: Model<Api>) => fakeStream());
    await expect(runSubAgent({ ...baseArgs(), streamFn })).resolves.toBeUndefined();
    expect(streamFn).toHaveBeenCalledTimes(1);
    // The stream function must receive the resolved model.
    expect(streamFn.mock.calls[0][0]).toBe(CUSTOM_API_MODEL);
  }, 15_000);
});

// ── resolveModel surfaces the provider's streamSimple ────────────────
describe("Runtime.resolveModel streamFn (issue #222)", () => {
  function makeRegistryWithProvider(
    providerConfig: { api?: string; streamSimple?: unknown } | undefined,
  ) {
    return {
      find: (_p: string, _i: string) => undefined,
      getApiKeyAndHeaders: async (_m: unknown) => ({ ok: true, apiKey: "k" }),
      getRegisteredProviderConfig: (p: string) =>
        p === "bridge-prov" ? providerConfig : undefined,
    };
  }

  it("returns the registered provider's streamSimple when apis match", async () => {
    const streamSimple = () => fakeStream();
    const rt = new Runtime();
    const res = await rt.resolveModel({
      model: CUSTOM_API_MODEL,
      modelRegistry: makeRegistryWithProvider({ api: "custom-bridge", streamSimple }),
      hasUI: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.streamFn).toBe(streamSimple);
  });

  it("returns no streamFn when the registered api differs from the model's api", async () => {
    const streamSimple = () => fakeStream();
    const rt = new Runtime();
    const res = await rt.resolveModel({
      model: CUSTOM_API_MODEL,
      modelRegistry: makeRegistryWithProvider({ api: "other-api", streamSimple }),
      hasUI: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.streamFn).toBeUndefined();
  });

  it("returns no streamFn when the registry lacks getRegisteredProviderConfig (pi < 0.85)", async () => {
    const rt = new Runtime();
    const res = await rt.resolveModel({
      model: CUSTOM_API_MODEL,
      modelRegistry: {
        find: () => undefined,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
      },
      hasUI: false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.streamFn).toBeUndefined();
  });
});
