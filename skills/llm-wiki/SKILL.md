---
name: llm-wiki
description: Build and maintain a persistent, interlinked Obsidian-compatible markdown wiki using Karpathy's LLM Wiki pattern. Extension-backed with auto-generated metadata, guardrails, and 13 custom tools (+3 opt-in agent-trajectory tools).
whenToUse: Call wiki_recall at task start to find relevant wiki pages. Call wiki_retro at task end to save new insights. When agent-trajectory working-memory is enabled (opt-in, /wiki-trajectories on), also call wiki_recall_skill at task start to find reusable skills / past cases ("have I done this before?") and wiki_capture_trajectory after non-trivial tasks to record how you solved them. The extension injects a brief status line, but explicit calls with task-specific terms get better results.
---

# LLM Wiki for Pi

You are a disciplined wiki maintainer. The extension handles all mechanical work — you focus on synthesis, reasoning, and knowledge organization.

## Architecture (4 Layers)

```
WIKI_ROOT/
└── .llm-wiki/                 # All wiki content (one dot-dir)
    ├── config.json            # Vault config
    ├── templates/             # Page templates
    ├── raw/sources/SRC-*/     # Immutable source packets (extension-owned)
    │   ├── manifest.json
    │   ├── original/
    │   ├── extracted.md
    │   └── attachments/
    ├── raw/trajectories/TRJ-*/ # Immutable agent task packets (extension-owned)
    │   ├── manifest.json      # Capture metadata (format: trajectory)
    │   ├── packet.json        # Full tool-call sequence
    │   └── extracted.md       # README summary
    ├── wiki/                  # Editable knowledge pages (you own this)
    │   ├── sources/           # One summary per source
    │   ├── entities/          # People, orgs, tools, products
    │   ├── concepts/          # Ideas, patterns, frameworks
    │   ├── syntheses/         # Cross-cutting analyses
    │   ├── analyses/          # Durable query answers
    │   ├── cases/             # One specific past task per trajectory
    │   └── skills/            # Reusable patterns distilled from trajectories
    ├── meta/                  # Auto-generated (extension-owned)
    │   ├── registry.json      # Master page catalog
    │   ├── backlinks.json     # Inbound link map
    │   ├── index.md           # Human-readable catalog
    │   ├── log.md             # Activity log
    │   └── events.jsonl       # Structured event stream
    ├── outputs/               # Generated artifacts
    └── .discoveries/          # Discovery tracking
```

## Golden Rules

1. **RAW IS IMMUTABLE.** Never edit `raw/`. Use `wiki_capture_source` to add sources.
2. **META IS AUTO-GENERATED.** Never edit `meta/`. The extension rebuilds it automatically.
3. **YOU OWN THE WIKI.** Create, update, and cross-reference everything in `wiki/`.
4. **ONE FILE PER THING.** Each entity, concept, source gets its own `.md` file.
5. **CROSS-REFERENCE EVERYTHING.** Every page needs at least 2 `[[wikilinks]]`.
6. **CITE SOURCES.** Every claim links back to its raw source packet.
7. **FLAG CONTRADICTIONS.** When sources disagree, document both sides.

## Agent Working-Memory (Trajectories)

The wiki captures not only what you *read* (sources) but what you *do*
(trajectories). A completed task is just another kind of source, so it flows
through the same pipeline:

```
raw/trajectories/TRJ-*  →  wiki/skills/*  (+ optional wiki/cases/*)  →  meta/*
```

> **Opt-in, off by default** (issue #80). The three tools below are only registered
> when `llm-wiki.trajectories` is enabled. Turn it on with `/wiki-trajectories on`
> (off with `/wiki-trajectories off`); toggling reloads the extension. When off, the
> tools are absent entirely — no system-prompt cost.

- `wiki_capture_trajectory` writes the immutable packet + a **self-contained summary**
  (`extracted.md`), auto-extracting the tool-call sequence from the live session (you
  usually only pass a `title`). It does **not** emit a to-be-fleshed skeleton — capture
  is a single lightweight call.
- `wiki_distill_skills` returns undistilled trajectories so you can generalize them
  into reusable `skill` pages (and optionally `case` pages) via `wiki_ensure_page`.
- `wiki_recall_skill` filters layered recall to `skill`/`case` pages —
  "have I done something like this before?". Call it at task start.

A **skill** generalizes across many trajectories ("how I do X"); a **case** is one
concrete past run ("the time I did X for project Y"). Trajectory packets live under
`raw/**` and are therefore immutable under the same guardrail as source packets —
edit the `case`/`skill` pages, never the packet.

### When to use which memory tool

| Tool | Stores | Use for |
|------|--------|---------|
| `wiki_capture_trajectory` | A structured, **replayable** tool-call packet (`packet.json`: tool names + arguments + results + errors) | "How did I *mechanically* solve this?" — the exact step sequence, to distill into a repeatable skill |
| `wiki_retro` | A durable prose **insight** (one markdown file) | "What did I learn?" — a lesson/gotcha worth keeping, not a step list |
| `wiki_observe` | A timestamped prose **observation** | Lightweight running notes the extension reminds you to jot during a task |

Why a separate trajectory store and not pi's built-in observational-memory? pi's
observational-memory keeps **prose** for context-compaction survival — it does not
persist the structured tool-call sequence (names, arguments, results). The trajectory
packet is the only artifact that captures a task as a replayable record, which is what
makes skill distillation possible.

## How the Extension Helps You

| Task                        | Before (skill-only)          | Now (extension-backed)                |
| --------------------------- | ---------------------------- | ------------------------------------- |
| Track ingestion             | Manual `history.json`        | Automatic via `meta/registry.json`    |
| Update INDEX                | Manual edit after every page | Auto-rebuilds on turn end             |
| Update LOG                  | Manual append                | Auto-generated from `events.jsonl`    |
| Find orphans                | Shell `grep` scans           | Instant from `backlinks.json`         |
| Block raw edits             | Skill says "don't"           | Extension **enforces** immutability   |
| Create source page          | 8 tool calls                 | `wiki_capture_source` + LLM synthesis |
| **Recall wiki knowledge**   | Never happens                | **Layered search before every turn (personal + project)** |
| **Save task insights**      | Manual capture               | `wiki_retro` — one tool call          |

## 🔄 Wiki Usage

### At Start — Call wiki_recall

**Call `wiki_recall` at the START of every task** to find relevant wiki pages:

```
wiki_recall(query="key terms from the user's request", max_results=5)
```

This searches both your **personal wiki** (`~/.llm-wiki/`) and the **project wiki** (`.llm-wiki/` in the current directory), merging results.

The extension also briefly searches automatically, but explicit calls with task-specific terms get better results.

#### Two-Stage Recall (links-first for large vaults)

Recall scales with vault size via **two-stage retrieval** (memex-style):

- **Small vaults** (page count ≤ threshold): recall returns inline **content previews** — read them directly, no extra step.
- **Large vaults** (page count > threshold): recall returns a **ranked list of links** only — `id`, `title`, `type`, `score`, and a 1-line snippet. **No full previews are injected**, to protect your context window.

**The two-step contract for large vaults:**

1. **Stage 1 — scan the links.** `wiki_recall` (and the auto-injected "Relevant Wiki Knowledge (links-first)" section) gives you ranked `[[id]]` links with scores and short snippets. Use the scores and snippets to pick the few pages that actually matter.
2. **Stage 2 — expand on demand.** Call `read` (or `wiki_read`) on the chosen link **paths** to pull their full content. Do **not** assume the snippet is the whole page — open the link before relying on its content.

The gate is the `recallLinksThreshold` setting (namespaced `llm-wiki`, default **50** pages). Page count is read from `meta/registry.json` (O(1), no page-body I/O). Set it to `0` to force links-first always, or a large number to always keep previews inline.

### At End — Save Insights with wiki_retro

After completing any meaningful task, call `wiki_retro` to save key insights:
- Non-obvious bug fixes or workarounds
- Architectural decisions and their rationale
- Tool/library gotchas you discovered
- Patterns worth remembering for future sessions

**Do not wait for the user to ask.** Save insights proactively — one atomic insight per call.

```
wiki_retro(slug="kebab-case-slug", title="Brief descriptive title", body="Insight in your own words with [[wikilinks]]")
```

### Deeper Searches

For thorough research, also use `wiki_search` to browse the full registry:

```
wiki_search(query="broad topic")
```

### Background Model Selection (`/wiki-model`)

The wiki's background work (ingest synthesis, etc.) runs on a model you can choose. By **default it uses the current session model** — zero config.

- **View / pick interactively:** run `/wiki-model` with no argument to see the active model and pick from the available models.
- **Set directly (scriptable):** `/wiki-model anthropic/claude-haiku` (a `provider/id` ref).
- **Revert to session model:** `/wiki-model session` (also `clear`/`default`/`reset`).

The choice is persisted to project settings (`.pi/settings.json` under `llm-wiki.taskModel`) and shown in the status bar.

**Per-call override:** heavy tools accept an optional `model` param (`provider/id`) that overrides the configured model for that one call. Precedence is **override > configured `taskModel` > session model**; an unknown ref degrades gracefully to the configured/session model. Example:

```
wiki_ingest(model="anthropic/claude-haiku")
```

### Auto-Bootstrap (One-Time)

The extension creates the wiki vault automatically on startup. On the first turn, it injects a directive asking you to infer topic and mode, then call:
```
wiki_bootstrap(topic="...", mode="personal|company")
```

This is a one-time step.

## Available Tools

Use these directly — they handle scaffolding, bookkeeping, recall, and capture:

- `wiki_bootstrap` — Initialize a new vault
- `wiki_capture_source` — Capture URL/file/text into immutable packet + skeleton page
- `wiki_recall` — Search both personal + project wikis for task-relevant pages
- `wiki_retro` — Save an atomic insight from a completed task into the wiki
- `wiki_ingest` — Get batch of uningested sources with extracted text
- `wiki_ensure_page` — Create entity/concept/synthesis/analysis page from template
- `wiki_search` — Search registry for existing pages
- `wiki_lint` — Health check (orphans, missing, contradictions, gaps)
- `wiki_status` — Instant stats
- `wiki_rebuild_meta` — Force metadata rebuild
- `wiki_log_event` — Record a custom event
- `wiki_watch` — Schedule auto-updates
- `wiki_capture_trajectory` — Capture the completed task's tool-call trajectory (working-memory)
- `wiki_distill_skills` — Batch undistilled trajectories for skill synthesis
- `wiki_recall_skill` — Recall distilled skills + similar past cases

## Workflows

### Capture → Ingest → Synthesize

1. **Capture**: `wiki_capture_source(url="...")` → creates packet + skeleton
2. **Ingest**: `wiki_ingest()` → get batch of sources needing synthesis
3. **Read**: `read raw/sources/SRC-*/extracted.md`
4. **Write**: Update skeleton source page with summary, entities, concepts
5. **Ensure**: `wiki_ensure_page(type="entity", title="...")` for each entity
6. **Cross-ref**: Add `[[wikilinks]]` between related pages
7. **Done**: Extension auto-rebuilds metadata

### Query → Answer → File

1. **Layered recall**: Extension searches personal + project vaults, injects matching pages with vault labels
2. For better results: call `wiki_recall` explicitly with task-specific terms
3. Read those pages
4. Synthesize answer with `[[wikilink]]` citations
5. If novel: create analysis page via `wiki_ensure_page(type="analysis")`
6. Extension auto-updates metadata

### Task → Capture → Retro

1. Complete a meaningful task
2. Call `wiki_retro` to save key insights
3. The insight is saved as a single markdown file
4. Extension auto-updates metadata
5. Next time, layered recall surfaces your saved insight

### Task → Record → Distill (agent working-memory)

1. Finish a non-trivial task (debug, refactor, integration)
2. `wiki_capture_trajectory(title="...")` — auto-extracts the tool-call trajectory into `raw/trajectories/TRJ-*` with a self-contained summary (no skeleton)
3. Flesh out the `wiki/cases/` page (Task → Approach → Outcome)
4. `wiki_distill_skills()` — get undistilled trajectories
5. `wiki_ensure_page(type="skill", title="...")` — generalize into a reusable skill citing `[[trajectories/TRJ-...]]`
6. Next time, `wiki_recall_skill(query="...")` surfaces the skill/case before you start

## Page Conventions

### Naming

- `kebab-case.md` for all files
- Folder-qualified wikilinks: `[[concepts/retrieval-augmented-generation]]`

### Frontmatter

```yaml
---
type: entity | concept | source | synthesis | analysis | skill | case | trajectory
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [sources/SRC-YYYY-MM-DD-NNN]
---
```

Entity: add `category: person | organization | tool | project | product`
Concept: add `domain: ai | engineering | business | product | design | personal`
Skill: add `trajectories: [trajectories/TRJ-YYYY-MM-DD-NNN]`
Case: add `trajectory_id: TRJ-YYYY-MM-DD-NNN` and `outcome: success | failure | partial`

### Citations

Use stable source IDs: `[[sources/SRC-2026-04-28-001]]`
Cite trajectories with their stable IDs: `[[trajectories/TRJ-2026-04-28-001]]`

### Contradictions

```markdown
> ⚠️ **Contradiction:** Source A claims X, but Source B claims Y.
> See [[page-a]] and [[page-b]].
```

## Variants

### Personal Wiki

- Extra: `wiki/journal/`, `wiki/goals/`
- Track: learning, books, health, reflections

### Company Wiki

- Extra: `wiki/changes/`, `wiki/decisions/`
- Track: competitors, market, strategy
- Frontmatter: `confidence: high | medium | low`

## Obsidian Integration

Open `wiki/` as an Obsidian vault. The extension generates:

- `meta/index.md` — browsable catalog
- `meta/backlinks.json` — for graph plugins
- `[[wikilinks]]` — native Obsidian links

Recommended plugins: Dataview, Graph View, Backlinks

## Tips

- **Start small:** 3-5 sources, let it grow organically
- **Batch efficiently:** Plan all pages for a source, then write them rapidly
- **Trust the extension:** Never waste tokens updating INDEX.md or LOG.md manually
- **Evolve the schema:** Update `WIKI_SCHEMA.md` as conventions mature
