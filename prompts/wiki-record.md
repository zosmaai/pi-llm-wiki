---
description: Capture the just-completed task's tool-call trajectory into the wiki as agent working-memory, then optionally distill it into a reusable skill.
argument-hint: "<title> [--outcome success|failure|partial]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-record

Capture the trajectory of the task you just completed — the sequence of tool calls that solved it — into the wiki's working-memory layer.

This is the counterpart to source capture: instead of recording what you *read*, it records what you *did*, so the wiki compounds over your own work.

## User Arguments

$ARGUMENTS

Read the LLM Wiki skill at `.pi/skills/llm-wiki/SKILL.md` first to understand the wiki conventions.

## Steps

1. Call `wiki_capture_trajectory` with:
   - `title`: short descriptive phrase for the task (≤60 chars, noun phrase)
   - `outcome`: optional — `success` (default), `failure`, or `partial`
   - The extension auto-extracts the tool-call trajectory from the live session, so you usually do **not** pass `steps` manually.
2. Open the generated skeleton case page in `wiki/cases/` and flesh out:
   - **Task** — what was requested
   - **Approach** — the key steps and decisions (not every tool call, just the meaningful ones)
   - **Outcome** — the result, and anything worth reusing or avoiding next time
3. If the task taught a reusable pattern, run `wiki_distill_skills` and create a `skill` page via `wiki_ensure_page(type="skill")` that cites `[[trajectories/TRJ-...]]`.
4. Confirm the case (and any skill) will be surfaced by `wiki_recall` / `wiki_recall_skill` in future sessions.

**Rules:**
- Only record tasks worth learning from — non-trivial debugging, refactors, integrations, multi-step workflows. Skip trivial one-shot answers.
- The raw trajectory packet under `raw/trajectories/` is immutable. Edit the `case`/`skill` pages, never the packet.
- One trajectory per `wiki_capture_trajectory` call.
