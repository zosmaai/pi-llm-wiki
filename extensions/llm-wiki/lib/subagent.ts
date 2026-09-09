import {
  type AgentContext,
  type AgentLoopConfig,
  type AgentTool,
  runAgentLoop,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";

/**
 * Thin sub-agent runner for the LLM Wiki background lane (issue #64, part of #63).
 *
 * Wraps the agent loop so background tasks (ingest synthesis, topic inference,
 * etc.) can run a focused, single-purpose agent on a resolved model with its
 * own system prompt and tools — mirroring pi-observational-memory's
 * `runObserver`. The caller drives behavior entirely through `tools`
 * (tool-side effects accumulate results); this wrapper just drives the loop to
 * completion.
 *
 * This is infrastructure: it makes no wiki-specific decisions. Concrete
 * background workers (issues #65, #66) supply the prompts and tools.
 */
export interface RunSubAgentArgs<TApi extends Api = Api> {
  model: Model<TApi>;
  apiKey: string;
  headers?: Record<string, string>;
  /** System prompt that defines the sub-agent's role. */
  systemPrompt: string;
  /** The user-turn instruction/payload to process. */
  userPrompt: string;
  /** Tools the sub-agent may call (side effects accumulate caller-side). */
  tools: AgentTool[];
  /** Max output tokens per model call. Default 4096. */
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Stream function for the model's API (issue #222). Providers registered by
   * extensions through `pi.registerProvider()` may not be resolvable by pi-ai's
   * default stream path; the caller (Runtime.resolveModel) supplies the
   * provider's own `streamSimple` when the model belongs to such a provider.
   */
  streamFn?: StreamFn;
  /** Provider-scoped env from auth resolution (issue #222; pi >= 0.85). */
  env?: Record<string, string>;
}

/**
 * Run a sub-agent loop to completion.
 *
 * Returns nothing useful directly — by design, results are collected by the
 * `tools` the caller passes (their `execute` accumulates into caller-owned
 * state). This keeps the runner generic across every background task type.
 *
 * Rejections from the loop (provider errors, auth failures, a streamFn that
 * throws) reject this promise, so `BackgroundRuntime.launchTask`'s try/catch
 * degrades them to a warning toast.
 */
export async function runSubAgent<TApi extends Api = Api>(
  args: RunSubAgentArgs<TApi>,
): Promise<void> {
  const {
    model,
    apiKey,
    headers,
    systemPrompt,
    userPrompt,
    tools,
    maxTokens,
    signal,
    streamFn,
    env,
  } = args;

  const text = userPrompt.trim();
  if (!text) return;

  const prompts: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  ];

  const context: AgentContext = {
    systemPrompt,
    messages: [],
    tools,
  };

  const reasoning = (model as unknown as { reasoning?: unknown }).reasoning;
  const config: AgentLoopConfig = {
    model,
    apiKey,
    headers,
    maxTokens: maxTokens ?? 4096,
    convertToLlm: (msgs) => msgs as Message[],
    toolExecution: "sequential",
    ...(reasoning ? { reasoning: "high" as const } : {}),
    // Provider-scoped env from auth resolution (issue #222). pi-agent-core
    // spreads the config into the stream options, where pi-ai >= 0.85 honors
    // it; the conditional spread keeps this compiling on pi < 0.85.
    ...(env ? { env } : {}),
  };

  // Drive the loop directly instead of agentLoop(): agentLoop() wraps the
  // loop in a detached promise (`void runAgentLoop(...).then(...)` with no
  // .catch), so a rejection from the stream path — e.g. "No API provider
  // registered for api: X" for a model from an extension-registered provider
  // — escaped as an uncaughtException and killed the whole pi process while
  // this function's stream drain hung forever (issue #222). runAgentLoop is
  // the same loop with the rejection propagating to THIS promise.
  await runAgentLoop(prompts, context, config, async () => {}, signal, streamFn);
}
