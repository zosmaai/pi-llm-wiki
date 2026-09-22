---
description: "Run the full wiki cycle: discover → ingest → lint. Optionally schedule for auto-updates."
argument-hint: "[--schedule daily|weekly]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-run

Run the complete wiki maintenance cycle: discover new sources, ingest them, and lint for health.

## User Arguments

$ARGUMENTS

## Steps

1. **Discover:** Use web search to find new sources on the wiki's topic, then capture each with `wiki_capture_source(url=<url>)` (max 5-10).
2. **Ingest:** Call `wiki_ingest(batch_size=3)` and process returned sources — read extracted.md, update source pages, create entity/concept pages, add cross-references.
3. **Lint:** Call `wiki_lint(auto_fix=false)` to run a health check.
4. If critical gaps found → optionally run one more discover+ingest cycle.
5. Save summary to `.llm-wiki/outputs/run-YYYY-MM-DD.md` using the `write` tool.
6. Report final summary.

### Scheduling

If `--schedule` is provided, call `wiki_watch(interval=<daily|weekly|hourly>)`.

**Important:** `wiki_watch` does NOT install a schedule. It only prints a `crontab` line.
Report the printed line to the user verbatim and tell them to install it themselves with
`crontab -e`. Do not claim the schedule is active until they confirm they have done so.
