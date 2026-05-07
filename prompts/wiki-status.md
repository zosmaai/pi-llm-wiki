---
description: Show wiki health overview — source count, page stats, orphan count, last activity dates.
argument-hint: ""
section: LLM Wiki
topLevelCli: true
---

# /wiki-status

Show a quick overview of wiki health and statistics.

## Steps

1. Count sources in `raw/` (recursive)
2. Count pages in `wiki/` (by type: entities, concepts, sources, syntheses)
3. Check `wiki/LOG.md` for last ingest, lint, and discover dates
4. Check for orphan pages (zero inbound links)
5. Read `.discoveries/gaps.json` for known gaps
6. Report:

```
📊 LLM Wiki Status
══════════════════
Wiki Root: [topic1], [topic2]
Mode: Personal | Company
Sources: [N] files
Wiki Pages: [N] total ([E] entities, [C] concepts, [S] sources, [Y] syntheses)
Last Ingest: YYYY-MM-DD
Last Lint: YYYY-MM-DD
Orphans: [N]
Knowledge Gaps: [N]
Health: ✅ Good | ⚠️ Warning | 🔴 Needs Attention
```
