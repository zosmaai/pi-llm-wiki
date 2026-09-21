import type {
  // runAgentLoop is not a static import because omp's legacy-pi shim rewrites
  // @earendil-works/* specifiers at load time to the bundled @oh-my-pi/*
  // copy (omp-legacy-pi-bundled:), which dropped runAgentLoop in favor of the
  // EventStream-returning agentLoop. Types are stripped before omp's source
  // rewrite runs, so type-only imports are safe to keep static.
  AgentContext,
  AgentLoopConfig,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, EventStream, Message, Model } from "@earendil-works/pi-ai";

let cachedDefaultStreamFn: StreamFn | undefined;

/**
 * The default pi-ai stream function (dispatches to registered API providers).
 * It moved from the package root to the `./compat` subpath in pi-ai 0.85, so
 * it is resolved lazily — a static import of either path breaks the other pi
 * version at load time. Cached after the first resolution.
 */
async function resolveDefaultStreamFn(): Promise<StreamFn> {
  if (cachedDefaultStreamFn) return cachedDefaultStreamFn;
  const root = await import("@earendil-works/pi-ai");
  const rootFn = (root as { streamSimple?: StreamFn }).streamSimple;
  if (rootFn) {
    cachedDefaultStreamFn = rootFn;
    return rootFn;
  }
  // pi-ai >= 0.85 exposes streamSimple via the ./compat subpath. The
  // specifier is a variable so static tooling (vite in vitest, jiti in pi)
  // cannot resolve a subpath that does not exist in pi < 0.85; at runtime
  // this branch is only reached when the root import lacks streamSimple.
  const compatSpecifier = "@earendil-works/pi-ai/compat";
  const compat = await import(compatSpecifier);
  cachedDefaultStreamFn = (compat as { streamSimple: StreamFn }).streamSimple;
  return cachedDefaultStreamFn;
}

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
  /** Auth-provided request headers; pi >= 0.85 may carry null (unset) values. */
  headers?: Record<string, string | null>;
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
 * Rejects after `timeoutMs` if `promise` has not settled. Exported for tests;
 * the stall timer is unref'd so a winning race leaves nothing pending.
 */
export function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, stalled]);
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

  // pi >= 0.85 requires streamFn explicitly (its internal fallback throws
  // unless the host configured a default), so we always pass one: the
  // provider-specific function when available, else pi-ai's default.
  const activeStreamFn = streamFn ?? (await resolveDefaultStreamFn());

  // Drive the loop directly instead of agentLoop(): agentLoop() wraps the
  // loop in a detached promise (`void runAgentLoop(...).then(...)` with no
  // .catch), so a rejection from the stream path — e.g. "No API provider
  // registered for api: X" for a model from an extension-registered provider
  // — escaped as an uncaughtException and killed the whole pi process while
  // this function's stream drain hung forever (issue #222). runAgentLoop is
  // the same loop with the rejection propagating to THIS promise.
  //
  // omp (compiled binary) rewrites @earendil-works/* specifiers at load time
  // to its bundled @oh-my-pi/* copies (omp-legacy-pi-bundled:), and the
  // bundled pi-agent-core dropped runAgentLoop in favor of the
  // EventStream-returning agentLoop. runAgentLoop is therefore loaded via a
  // variable specifier (opaque to omp's static source rewrite) and feature-
  // detected: where it exists (regular pi) we keep the direct loop; where it
  // does not (omp bundled) agentLoop drives the same loop and its returned
  // EventStream's async iterator throws on stream.fail(), so for-await
  // propagates rejections to THIS promise just like runAgentLoop.
  const agentCoreSpecifier = "@earendil-works/pi-agent-core";
  const agentCore = (await import(agentCoreSpecifier)) as {
    runAgentLoop?: (
      prompts: Message[],
      context: AgentContext,
      config: AgentLoopConfig,
      emit: (event: unknown) => Promise<void>,
      signal: AbortSignal | undefined,
      streamFn: StreamFn,
    ) => Promise<unknown>;
    agentLoop?: (
      prompts: Message[],
      context: AgentContext,
      config: AgentLoopConfig,
      signal: AbortSignal | undefined,
      streamFn: StreamFn,
    ) => EventStream<unknown>;
  };
  if (agentCore.runAgentLoop) {
    await agentCore.runAgentLoop(prompts, context, config, async () => {}, signal, activeStreamFn);
  } else if (agentCore.agentLoop) {
    const stream = agentCore.agentLoop(prompts, context, config, signal, activeStreamFn);
    // The bundled agentLoop is the detached `void runAgentLoop(...).then(...)`
    // pattern with no `.catch` (verified across pi-agent-core 0.73.1-0.78.0):
    // a rejected loop never ends the stream, so `for await` would hang
    // forever. Cap it so a stall surfaces as a catchable error (degraded to a
    // warning toast by BackgroundRuntime) instead of a hang.
    // ponytail: hard cap — raise if legitimate runs exceed it.
    const drain = (async () => {
      for await (const _event of stream) {
        // Discard events; results are collected caller-side via tool side effects.
      }
    })();
    await raceWithTimeout(drain, 120_000, "omp agentLoop stream stalled: no end/fail event within 120s");
  } else {
    throw new Error("Neither runAgentLoop nor agentLoop is exported by pi-agent-core");
  }
}
