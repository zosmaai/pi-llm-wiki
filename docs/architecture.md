# Architecture

## Layered Vault Architecture

pi-llm-wiki supports multiple vault layers that are searched together:

| Layer | Location | Resolution | Searched by recall |
|-------|----------|------------|-------------------|
| **Personal** | `~/.llm-wiki/` | Fallback when no project wiki found | ✅ Always |
| **Project** | `{project}/.llm-wiki/` | Walk up from cwd | ✅ When present |

### Resolution Order

1. Check current directory for `.llm-wiki/` → use as project wiki
2. Walk up parent directories looking for `.llm-wiki/` → use as project wiki
3. Check `WIKI_HOME` env var → use as personal wiki
4. Fall back to `~/.llm-wiki/` → create if doesn't exist

This means a project wiki is always preferred when you're inside a project that has one, but your personal wiki is always available as the fallback.

### Dual-Vault Recall

`wiki_recall` uses `searchWikiLayered()` which:
1. Searches the **project vault** (if one exists in cwd)
2. Searches the **personal vault** (`~/.llm-wiki/` or `WIKI_HOME`)
3. Deduplicates results by page ID (project takes priority on duplicates)
4. Tags personal results with "📓 personal" label
5. Merges results: personal first, then project

Results are injected into the context with vault source tags so the model can distinguish between personal and project knowledge.

---

## Four-Layer Page Model (within each vault)

```
WIKI_ROOT/
└── .llm-wiki/                 # All wiki content under one dot-dir
    ├── config.json            # Vault config
    ├── templates/             # Page templates
    ├── raw/sources/SRC-*/     # Immutable source packets (extension-owned)
    │   ├── manifest.json      # Capture metadata
    │   ├── original/          # Original artifact
    │   ├── extracted.md       # Normalized markdown
    │   └── attachments/       # Downloaded images, PDFs
    ├── raw/trajectories/TRJ-*/ # Immutable agent task packets (extension-owned)
    │   ├── manifest.json      # Capture metadata (format: trajectory)
    │   ├── packet.json        # Full tool-call sequence
    │   └── extracted.md       # README summary
    ├── wiki/                  # Editable knowledge pages (you + LLM)
    │   ├── sources/           # One summary per source
    │   ├── entities/          # People, orgs, tools, products
    │   ├── concepts/          # Ideas, patterns, frameworks
    │   ├── syntheses/         # Cross-cutting analyses
    │   ├── analyses/          # Durable query answers
    │   ├── cases/             # One specific past task per trajectory
    │   └── skills/            # Reusable patterns distilled from trajectories
    ├── meta/                  # Durable event source + generated internal projections
    │   ├── registry.json      # Master page catalog
    │   ├── backlinks.json     # Inbound link map
    │   ├── index.md           # Human-readable catalog
    │   ├── log.md             # Activity log
    │   └── events.jsonl       # Structured event stream
    ├── outputs/               # Generated artifacts
    └── .discoveries/          # Discovery tracking
```

## Ownership Rules

| Path      | Owner                    | Rule                     |
| --------- | ------------------------ | ------------------------ |
| Path                  | Owner                    | Rule                     |
| --------------------- | ------------------------ | ------------------------ |
| `.llm-wiki/raw/**`    | Extension                | Immutable after capture  |
| `.llm-wiki/wiki/**`   | Model + user             | Editable knowledge pages |
| `.llm-wiki/meta/events.jsonl` | Extension tools | Authoritative, append-only; preserve in full-vault backups |
| `.llm-wiki/meta/**` except `events.jsonl` | Extension | Generated projections |
| `.llm-wiki/meta/qmd/**` | Extension | Generated QMD search index (mirrors + SQLite); local, rebuildable with `wiki_reindex` |
| `.llm-wiki/` | Human + explicit request | Operating rules          |

`events.jsonl` records selected extension operations, not every filesystem edit. `meta/log.md` and OKF-mode `wiki/log.md` are one-way projections; neither can recover the event stream.

## Generated QMD Search Index (phase 2)

`.llm-wiki/meta/qmd/**` is extension-owned, generated, local, and **generated and rebuildable** via `wiki_reindex`. It is a validated, independently repairable search index that no recall path depends on yet (active recall stays the legacy heuristic until Phase 3).

```
meta/qmd/
  manifest.json             # maps generated paths -> (vault_id, page_id)
  documents/
    canonical/**/*.md        # parser-valid concept/entity/analysis/synthesis/requirement/skill/case
    evidence/**/*.md         # parser-valid source/unknown types
  current/index.sqlite       # live QMD store (copied, never edited in place)
  index.lock/                # cross-process lock (owner.json)
  swap.json                  # journal for crash-safe promotion
```

- QMD never scans `.llm-wiki/wiki/**` directly; it reads only the validated mirrors QMD owns.
- `manifest.json` maps validated mirrors back to stable `(vault_id, page_id)` identities.
- Canonical and evidence collections never overlap.
- Ordinary write-triggered updates are **lexical and model-free**; `vectors` may download ~2 GB on first use.
- The live store is replaced atomically via a recoverable copy-on-write swap; failures retain the last usable `current`.
- `swap.json` is a **write-ahead journal**: each phase is published before the destructive rename it covers, and recovery re-checks the filesystem, so every crash window restores a usable `current` or an explicit missing/error state.
- Stale `staging-<uuid>` directories left by failed or cancelled pre-journal work are extension-owned and swept while the per-vault lock is held; recovery never touches arbitrary names under `meta/qmd`.
- Malformed generated artifacts (`swap.json`, `manifest.json`, `index-state.json`) report `error`, never `missing` or `ready`.
- Generated status exposes `repairComponents` (valid tool component values) so lint can suggest an exact `wiki_reindex` command. `vectors` refreshes documents before embedding, so `components=["vectors"]` repairs stale vectors and their document index together.
- Do not copy, partially restore, or edit individual SQLite/WAL/SHM files inside `current` — restore the whole directory or rebuild.
- Full-vault backups include generated searchable text; OKF-only exports do not.

## Source Packet Format

Each captured source becomes a packet:

```
.llm-wiki/raw/sources/SRC-YYYY-MM-DD-NNN/
  manifest.json
  original/
  extracted.md
  attachments/
```

## Page Types

- **source** — what this specific source says
- **entity** — people, orgs, tools, products
- **concept** — ideas, patterns, frameworks
- **synthesis** — cross-source theses and tensions
- **analysis** — durable filed answers from queries
- **requirement** — atomic requirements with status, priority, and traceability
- **trajectory** — an immutable captured agent task run (working-memory source)
- **case** — one specific past task implementation, citing its trajectory
- **skill** — a reusable pattern distilled from one or more trajectories

## Agent Working-Memory (Trajectories)

The wiki captures not only what the agent *reads* (sources) but what it *does*
(trajectories). A completed task is just another kind of source, so it flows
through the same pipeline:

```
raw/trajectories/TRJ-*  →  wiki/skills/*  (+ optional wiki/cases/*)  →  meta/*
```

This is **opt-in, off by default** (issue #80): the three tools below are only
registered when `llm-wiki.trajectories` is enabled (`/wiki-trajectories on`), and
the `raw/trajectories`, `wiki/skills`, `wiki/cases` directories are created lazily
on first use — so a vault with the feature off carries no trace of it.

- `wiki_capture_trajectory` writes the immutable packet + a self-contained summary
  (`extracted.md`), auto-extracting the tool-call sequence from the live session.
  It does not emit a to-be-fleshed skeleton — capture is a single lightweight call.
- `wiki_distill_skills` batches undistilled trajectories so the model can
  generalize them into reusable `skill` pages.
- `wiki_recall_skill` filters layered recall to `skill`/`case` pages —
  "have I done something like this before?".

Trajectory packets live under `raw/**` and are therefore immutable under the
same guardrail as source packets — no new ownership rule required.

## Linking Style

- Internal: `[[folder/page-name]]`
- Citation: `[[sources/SRC-YYYY-MM-DD-NNN]]`
- Trajectory citation: `[[trajectories/TRJ-YYYY-MM-DD-NNN]]`

## Guardrails

The extension blocks direct edits to `.llm-wiki/raw/**` and `.llm-wiki/meta/**`. Metadata rebuilds automatically after `.llm-wiki/wiki/**` edits.
