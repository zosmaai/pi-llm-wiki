import { describe, expect, it } from "vitest";
import {
  buildAgentStartInjection,
  WIKI_RECALL_MESSAGE_TYPE,
  WIKI_STATUS_BLOCK,
} from "../extensions/llm-wiki/lib/inject.js";

/**
 * Cache-safety contract for the `before_agent_start` injection (issue #92).
 *
 * The system prompt is the LLM provider's primary cache prefix. Any per-turn
 * variation in it forces a full cache miss (re-prompt-fill) every turn. The
 * extension's recall results are keyed on the user's prompt, so they differ
 * every turn — they MUST NOT land in the system prompt. They ride in a tail
 * conversation message instead, which never invalidates the cached prefix.
 *
 * These tests pin that contract so the regression can never silently return.
 */
describe("buildAgentStartInjection (issue #92 cache safety)", () => {
  const BASE = "You are a helpful agent.";
  const RECALL_A = "## Relevant Wiki Knowledge\n1. [[page-a]] — score 99";
  const RECALL_B = "## Relevant Wiki Knowledge\n1. [[page-b]] — score 42";

  it("the returned systemPrompt is INVARIANT across different volatile content", () => {
    // The core regression guard: whatever the recall result is, the system
    // prompt the provider caches must be byte-identical turn over turn.
    const a = buildAgentStartInjection(BASE, [RECALL_A]);
    const b = buildAgentStartInjection(BASE, [RECALL_B]);
    expect(a.systemPrompt).toBe(b.systemPrompt);
  });

  it("the systemPrompt never contains the volatile recall content", () => {
    const { systemPrompt } = buildAgentStartInjection(BASE, [RECALL_A]);
    expect(systemPrompt).not.toContain("Relevant Wiki Knowledge");
    expect(systemPrompt).not.toContain("page-a");
  });

  it("the systemPrompt is exactly the base plus the static footer", () => {
    const { systemPrompt } = buildAgentStartInjection(BASE, [RECALL_A]);
    expect(systemPrompt).toBe(`${BASE}\n\n${WIKI_STATUS_BLOCK}`);
  });

  it("accepts OMP's segmented system prompt", () => {
    const { systemPrompt } = buildAgentStartInjection([BASE, "Follow project rules."], []);
    expect(systemPrompt).toBe(`${BASE}\n\nFollow project rules.\n\n${WIKI_STATUS_BLOCK}`);
  });

  it("volatile blocks ride in a hidden tail message, joined in order", () => {
    const topic = "## Wiki Setup Required\ninfer topic";
    const { message } = buildAgentStartInjection(BASE, [topic, RECALL_A]);
    expect(message).toBeDefined();
    expect(message?.customType).toBe(WIKI_RECALL_MESSAGE_TYPE);
    expect(message?.display).toBe(false);
    expect(message?.content).toBe(`${topic}\n\n${RECALL_A}`);
  });

  it("emits no message when there is no volatile content", () => {
    expect(buildAgentStartInjection(BASE, []).message).toBeUndefined();
    expect(buildAgentStartInjection(BASE, [undefined, "", "   "]).message).toBeUndefined();
  });

  it("does not stack the footer on carry-forward (retry-safe)", () => {
    // A turn that aborts can carry the prior (footer-bearing) system prompt
    // back in; re-running must still yield exactly one footer.
    const once = buildAgentStartInjection(BASE, []).systemPrompt;
    const twice = buildAgentStartInjection(once, []).systemPrompt;
    expect(twice).toBe(once);
    expect(twice.split(WIKI_STATUS_BLOCK)).toHaveLength(2); // appears exactly once
  });
});
