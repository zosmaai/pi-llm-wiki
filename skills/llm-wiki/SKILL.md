---
name: llm-wiki
description: Build and maintain a persistent, interlinked Obsidian-compatible markdown wiki using Karpathy's LLM Wiki pattern. Extension-backed with auto-generated metadata, guardrails, and 10 custom tools.
---

# LLM Wiki for Pi

You are a disciplined wiki maintainer. The extension handles all mechanical work — you focus on synthesis, reasoning, and knowledge organization.

## Architecture (4 Layers)

```
WIKI_ROOT/
├── raw/sources/SRC-*/       # Immutable source packets (extension-owned)
│   ├── manifest.json
│   ├── original/
│   ├── extracted.md
│   └── attachments/
├── wiki/                     # Editable knowledge pages (you own this)
│   ├── sources/              # One summary per source
│   ├── entities/             # People, orgs, tools, products
│   ├── concepts/             # Ideas, patterns, frameworks
│   ├── syntheses/            # Cross-cutting analyses
│   └── analyses/             # Durable query answers
├── meta/                     # Auto-generated (extension-owned)
│   ├── registry.json         # Master page catalog
│   ├── backlinks.json        # Inbound link map
│   ├── index.md              # Human-readable catalog
│   ├── log.md                # Activity log
│   └── events.jsonl          # Structured event stream
└── .wiki/                    # Config and templates
    ├── config.json
    └── templates/
```

## Golden Rules

1. **RAW IS IMMUTABLE.** Never edit `raw/`. Use `wiki_capture_source` to add sources.
2. **META IS AUTO-GENERATED.** Never edit `meta/`. The extension rebuilds it automatically.
3. **YOU OWN THE WIKI.** Create, update, and cross-reference everything in `wiki/`.
4. **ONE FILE PER THING.** Each entity, concept, source gets its own `.md` file.
5. **CROSS-REFERENCE EVERYTHING.** Every page needs at least 2 `[[wikilinks]]`.
6. **CITE SOURCES.** Every claim links back to its raw source packet.
7. **FLAG CONTRADICTIONS.** When sources disagree, document both sides.

## How the Extension Helps You

| Task               | Before (skill-only)          | Now (extension-backed)                |
| ------------------ | ---------------------------- | ------------------------------------- |
| Track ingestion    | Manual `history.json`        | Automatic via `meta/registry.json`    |
| Update INDEX       | Manual edit after every page | Auto-rebuilds on turn end             |
| Update LOG         | Manual append                | Auto-generated from `events.jsonl`    |
| Find orphans       | Shell `grep` scans           | Instant from `backlinks.json`         |
| Block raw edits    | Skill says "don't"           | Extension **enforces** immutability   |
| Create source page | 8 tool calls                 | `wiki_capture_source` + LLM synthesis |

## Available Tools

Use these directly — they handle scaffolding and bookkeeping:

- `wiki_bootstrap` — Initialize a new vault
- `wiki_capture_source` — Capture URL/file/text into immutable packet + skeleton page
- `wiki_ingest` — Get batch of uningested sources with extracted text
- `wiki_ensure_page` — Create entity/concept/synthesis/analysis page from template
- `wiki_search` — Search registry for existing pages
- `wiki_lint` — Health check (orphans, missing, contradictions, gaps)
- `wiki_status` — Instant stats
- `wiki_rebuild_meta` — Force metadata rebuild
- `wiki_log_event` — Record a custom event
- `wiki_watch` — Schedule auto-updates

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

1. `wiki_search(query="...")` to find relevant pages
2. Read those pages
3. Synthesize answer with `[[wikilink]]` citations
4. If novel: create analysis page via `wiki_ensure_page(type="analysis")`
5. Extension auto-updates metadata

## Page Conventions

### Naming

- `kebab-case.md` for all files
- Folder-qualified wikilinks: `[[concepts/retrieval-augmented-generation]]`

### Frontmatter

```yaml
---
type: entity | concept | source | synthesis | analysis
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [sources/SRC-YYYY-MM-DD-NNN]
---
```

Entity: add `category: person | organization | tool | project | product`
Concept: add `domain: ai | engineering | business | product | design | personal`

### Citations

Use stable source IDs: `[[sources/SRC-2026-04-28-001]]`

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
