---
description: Search the wiki's distilled skills and past cases for patterns relevant to the current task — "have I done something like this before?".
argument-hint: "[query] [--kind skill|case]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-skills

Search the agent working-memory layer of the wiki: reusable **skills** distilled from past trajectories, and specific past **cases**.

## User Arguments

$ARGUMENTS

## Steps

1. Call `wiki_recall_skill` with:
   - `query`: the current task description or key terms (defaults to `$ARGUMENTS`)
   - `kind`: optional — `skill`, `case`, or `any` (default)
   - `max_results`: optional (default 5)
2. Read the most relevant skill/case pages with `read`.
3. Apply the recalled pattern to the current task, citing the source page with `[[skills/...]]` or `[[cases/...]]` where helpful.
4. If no relevant skill/case exists, proceed with the task and consider running `/wiki-record` afterward so the next attempt benefits.

**Tip:** Skills generalize across many trajectories ("how I do X"); cases are concrete past runs ("the time I did X for project Y"). Search `any` first, then narrow.
