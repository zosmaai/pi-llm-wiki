---
description: Capture and decompose a concept into atomic, traceable wiki requirements. Clarifies ambiguous requirements, splits them into atomic pieces, and persists them as wiki/requirements/ pages with status tracking.
argument-hint: "<concept description>"
section: LLM Wiki
topLevelCli: true
---

# /wiki-req

Capture a concept and decompose it into atomic, traceable requirements in the wiki.

Transforms natural language descriptions into structured `wiki/requirements/` pages, preserving the original clarified concept as an immutable source packet in `raw/sources/`.

## User Arguments

$ARGUMENTS

Read the LLM Wiki skill at `.pi/skills/llm-wiki/SKILL.md` first to understand the wiki conventions, architecture, and page type rules.

## Steps

1. **Clarify the concept**
   - Discuss with the user: unpack ambiguous terms, surfaces implicit assumptions, identify scope boundaries
   - Ask targeted questions to resolve unknowns (e.g., "Which providers?", "What's the fallback behavior?", "Who are the actors?")
   - Reach mutual clarity before proceeding

2. **Capture the clarified concept**
   - Call `wiki_capture_source(text=...)` with the clarified conversation as markdown
   - This creates an immutable record in `raw/sources/SRC-YYYY-MM-DD-NNN/`
   - The source captures the original intent verbatim — no interpretation, no decomposition

3. **Decompose into atomic requirements**
   - Break the clarified concept into the smallest meaningful units of functionality
   - Each requirement should represent one independently verifiable behavior
   - For each atomic requirement, call `wiki_ensure_page(type="requirement", title="...", content="...")` where content includes:
     - `type: requirement` and `status: draft` in frontmatter
     - A clear `## Description` section
     - `## Acceptance Criteria` as a checkbox list (the threshold for "done")
     - `source_id` linking back to the source capture
     - `depends_on` linking to any prerequisite requirements
     - `[[wikilinks]]` to relevant entities, concepts, and other wiki pages
   - Set priority based on user input: `p0` (blocking), `p1` (critical), `p2` (important), `p3` (nice-to-have)

4. **Cross-link and finalize**
   - Ensure each requirement page has bidirectional wikilinks to related pages
   - Update any existing entity or concept pages that these requirements reference
   - Report the results: how many requirements created, their priorities, and the source capture ID

**Rules:**
- One atomic requirement per `wiki_ensure_page` call — each must be independently testable
- Always capture the clarified concept first via `wiki_capture_source` before decomposing
- Requirements live in `wiki/requirements/` — they are editable wiki pages, not immutable sources
- Use status values: `draft` → `clarified` → `active` → `implemented` → `deferred` → `rejected`
- Use priority values: `p0` (blocking), `p1` (critical), `p2` (important), `p3` (nice-to-have)
- Do not create requirements in `raw/` — that layer is for external source artifacts only
- Inside Markdown table cells, write aliased wikilinks as `[[target\|alias]]`, never `[[target|alias]]`.
