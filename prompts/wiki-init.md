---
description: Initialize a new LLM Wiki in the current directory. Creates the full directory structure, config, and template files.
argument-hint: "<topic> [--mode personal|company]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-init

Initialize a new LLM Wiki in the current directory.

## User Arguments

$ARGUMENTS

Read the LLM Wiki skill at `.pi/skills/llm-wiki/SKILL.md` (or wherever the skill is installed) first to understand the full schema and conventions.

## Steps

1. Ask the user for the wiki topic and mode (`personal` or `company`)
2. Create the directory structure:
   - `raw/articles/`, `raw/papers/`, `raw/notes/`, `raw/assets/`
   - `wiki/entities/`, `wiki/concepts/`, `wiki/sources/`, `wiki/syntheses/`, `wiki/changes/`
   - `outputs/`
   - `.discoveries/`
3. Create `config.yaml` with the topic, mode, and default settings
4. Create `wiki/INDEX.md` with section headings organized by page type
5. Create `wiki/LOG.md` with initial entry
6. Create `wiki/DASHBOARD.md` with Dataview queries for Obsidian
7. Create `.gitignore` to exclude `outputs/` from version control if desired
8. Initialize git repo if not already present
9. Report the structure and suggest first steps: "Drop sources into `raw/` and run `/wiki-ingest`"

If `--mode company`, add the `change_detection: true` flag to config.yaml and add a `wiki/decisions/` folder.
