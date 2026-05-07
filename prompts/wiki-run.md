---
description: Run the full wiki cycle: discover → ingest → lint. Optionally schedule for auto-updates.
argument-hint: "[--schedule daily|weekly]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-run

Run the complete wiki maintenance cycle: discover new sources, ingest them, and lint for health.

## User Arguments

$ARGUMENTS

Read the LLM Wiki skill at `.pi/skills/llm-wiki/SKILL.md` first.

## Steps

1. Run `/wiki-discover` → find new sources
2. Run `/wiki-ingest` → process all new files
3. Run `/wiki-lint` → health check
4. If critical gaps found → optionally one more discover+ingest cycle
5. Save summary → `outputs/run-YYYY-MM-DD.md`
6. Report final summary

### Scheduling

If `--schedule daily` is used, use `schedule_prompt` to set up daily runs:

```
schedule_prompt action=add schedule="0 0 8 * * *" prompt="Run /wiki-run for the LLM Wiki"
```

If `--schedule weekly` is used:

```
schedule_prompt action=add schedule="0 0 9 * * 1" prompt="Run /wiki-run for the LLM Wiki"
```
