---
description: Auto-discover new sources from the web. Searches based on config topics and known knowledge gaps.
argument-hint: "[--topic <topic>]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-discover

Find new source material for the wiki by searching the web.

## User Arguments

$ARGUMENTS

Read the LLM Wiki skill at `.pi/skills/llm-wiki/SKILL.md` first. Also read `config.yaml` for topics and feeds.

## Steps

1. Read `config.yaml` → extract topics, keywords, feeds
2. Read `.discoveries/gaps.json` → knowledge gaps to fill
3. Read `.discoveries/history.json` → already-fetched URLs
4. Search for new sources:
   - Web search each topic + latest keywords
   - Search for gaps from `.discoveries/gaps.json`
   - If `--topic` specified, focus search on that topic
5. For each promising result:
   a. Fetch full content
   b. Save to `raw/articles/YYYY-MM-DD-slug.md` with frontmatter (title, url, discovered, topic)
6. Update `.discoveries/history.json`
7. Report: "Discovered [N] new sources. Run `/wiki-ingest` to process them."

**Rules:** Max 5-10 sources. Skip ads, listicles, duplicates. Prefer in-depth analysis.
