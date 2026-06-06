---
description: Process new source packets and synthesize them into wiki knowledge pages.
argument-hint: "[source_id]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-ingest

Process uningested source packets and synthesize them into wiki knowledge pages.

## User Arguments

$ARGUMENTS

## Steps

1. Call `wiki_ingest(source_id=<id if provided>, batch_size=3)`.
2. If the tool reports "All sources ingested", inform the user and stop.
3. **If the tool reports it is ingesting in the background**, the synthesis sub-agent is handling those sources on the configured task model. Do NOT synthesize them yourself — just report which sources were dispatched and stop. (You'll be notified as each completes.)
4. **Otherwise** (the tool returned extracted content — background unavailable or `background=false`), for each source in the returned batch:
   a. Read the extracted text from `raw/sources/<SOURCE_ID>/extracted.md`
   b. Update the skeleton source page in `wiki/sources/` with a proper summary, key entities, and concepts
   c. Use `wiki_ensure_page(type=entity, title=<name>)` for each new entity (people, orgs, tools, products)
   d. Use `wiki_ensure_page(type=concept, title=<name>)` for each new concept (ideas, patterns, frameworks)
   e. Add `[[wikilinks]]` cross-references between related pages
   f. Flag any contradictions with existing wiki content using `⚠️ **Contradiction**` markers
5. After processing a synchronous batch, call `wiki_rebuild_meta` to update metadata.
6. Report: "Ingested [N] sources → [M] pages created/updated. [X] contradictions flagged."

> **Background vs synchronous:** ingestion runs in the background by default (non-blocking) when a task model is available, so the main agent is never stalled. It falls back to the synchronous main-agent flow above when no model/API key is configured, or when called with `background=false`.

**Rules:**
- Never modify files in `raw/` — source packets are immutable after capture.
- Never fabricate information — always cite sources with `[[sources/SRC-...]]`.
- The extension auto-updates metadata — you do NOT need to manually edit `meta/` files.
