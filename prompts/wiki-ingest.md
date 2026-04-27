---
description: Process new source files in raw/ and update the wiki. Creates summaries, entities, concepts, and cross-references.
args: [path]
section: LLM Wiki
topLevelCli: true
---

# /wiki:ingest

Process new files in `raw/` and integrate them into the wiki.

Read the LLM Wiki skill at `.pi/skills/llm-wiki/SKILL.md` first to understand the full schema, page formats, and conventions.

## Steps

1. Read `config.yaml` and `.discoveries/history.json`
2. If a specific path is given (e.g., `/wiki:ingest raw/articles/my-file.md`), process just that file
3. If no path given, scan all files in `raw/` and find ones not in history
4. For each new source:
   a. Read the full content
   b. Briefly discuss with the user: "This is about [topic]. Key points: [summary]. Any specific emphasis?"
   c. Create/update pages in `wiki/sources/`, `wiki/entities/`, `wiki/concepts/`
   d. Add `[[wikilinks]]` cross-references between related pages
   e. Flag any contradictions with existing wiki content
5. Update `wiki/INDEX.md` with all new/updated pages
6. Append to `wiki/LOG.md`
7. Update `.discoveries/history.json`
8. Report: "Ingested [N] sources → [M] pages created/updated. [X] contradictions flagged."

**Rules:** Never modify raw/ files. Never fabricate information. Always cite sources.
