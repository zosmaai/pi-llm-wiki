import {
  type AgentContext,
  type AgentLoopConfig,
  type AgentTool,
  agentLoop,
} from "@mariozechner/pi-agent-core";
import type { Api, Message, Model } from "@mariozechner/pi-ai";

/**
 * Thin sub-agent runner for the LLM Wiki background lane (issue #64, part of #63).
 *
 * Wraps `agentLoop` so background tasks (ingest synthesis, topic inference,
 * etc.) can run a focused, single-purpose agent on a resolved model with its
 * own system prompt and tools — mirroring pi-observational-memory's
 * `runObserver`. The caller drives behavior entirely through `tools`
 * (tool-side effects accumulate results); this wrapper just drives the loop to
 * completion and drains its event stream.
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
}

/**
 * Run a sub-agent loop to completion.
 *
 * Returns nothing useful directly — by design, results are collected by the
 * `tools` the caller passes (their `execute` accumulates into caller-owned
 * state). This keeps the runner generic across every background task type.
 */
export async function runSubAgent<TApi extends Api = Api>(
  args: RunSubAgentArgs<TApi>,
): Promise<void> {
  const { model, apiKey, headers, systemPrompt, userPrompt, tools, maxTokens, signal } = args;

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
  };

  const stream = agentLoop(prompts, context, config, signal);
  for await (const _event of stream) {
    // Drain events; tool `execute` callbacks collect results caller-side.
  }
  await stream.result();
}
