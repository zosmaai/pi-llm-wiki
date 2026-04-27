---
description: Health check the wiki. Detects contradictions, orphans, missing pages, stale claims, and knowledge gaps.
args: [--fix]
section: LLM Wiki
topLevelCli: true
---

# /wiki:lint

Run a comprehensive health check on the wiki.

Read the LLM Wiki skill at `.pi/skills/llm-wiki/SKILL.md` first to understand the full schema and conventions.

## Steps

1. Scan all files in `wiki/`
2. Check for:
   - **Contradictions:** Conflicting claims between pages
   - **Orphans:** Pages with zero inbound `[[wikilinks]]`
   - **Missing pages:** `[[links]]` pointing to non-existent files
   - **Stale claims:** Info superseded by newer sources
   - **Broken raw links:** References to `raw/` files that don't exist
   - **Knowledge gaps:** Topics mentioned but lacking their own page
   - **Quality:** Pages under 3 lines, pages with no sources or cross-refs
3. If `--fix` flag is present: auto-fix broken links, create missing pages for frequently-linked concepts, add cross-refs to orphans. Flag contradictions for human decision.
4. Save report → `outputs/lint-YYYY-MM-DD.md`
5. Update `.discoveries/gaps.json`
6. Append to `wiki/LOG.md`
7. Report key findings
