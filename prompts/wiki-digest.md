---
description: Generate a daily or weekly digest of wiki changes — new sources, pages, insights, and gaps.
argument-hint: "[--period daily|weekly]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-digest

Generate a digest of recent wiki activity.

## User Arguments

$ARGUMENTS

## Steps

1. Read `wiki/LOG.md` — filter entries since last digest
2. Read pages created/updated in that period
3. Summarize:
   - New sources ingested
   - New pages created
   - Key insights or connections
   - Knowledge gaps identified
   - Health trends
4. Save → `outputs/digest-YYYY-MM-DD.md`
5. Report concise digest
