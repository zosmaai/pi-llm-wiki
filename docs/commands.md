# Commands

## Slash Commands

| Command          | Description                           |
| ---------------- | ------------------------------------- |
| `/wiki-init`     | Create a new wiki vault               |
| `/wiki-ingest`   | Process new sources                   |
| `/wiki-query`    | Ask questions against the wiki        |
| `/wiki-lint`     | Health check                          |
| `/wiki-discover` | Auto-discover sources                 |
| `/wiki-run`      | Full cycle (discover → ingest → lint) |
| `/wiki-status`   | Show wiki health                      |
| `/wiki-digest`   | Daily/weekly summary                  |
| `/wiki-retro`    | Save atomic insights from tasks        |
| `/wiki-model`    | View/set the background-task model     |
| `/wiki-trajectories` | Enable/disable agent working-memory (`on`/`off`, opt-in) |
| `/wiki-record`   | Capture the completed task's trajectory (requires trajectories enabled) |
| `/wiki-skills`   | Search distilled skills + past cases (requires trajectories enabled) |
| `/wiki-req` | Decompose a concept into atomic requirement pages |
| `/wiki-settings` | Browse or change all `llm-wiki` settings (project or global scope) |
| `/wiki-dashboard` | Read-only vault health: pages, freshness, activity, ingest queue, backlinks, embeddings |

## Extension Tools

The extension always registers 14 tools the LLM can call directly. The 3 agent-trajectory
tools (`wiki_capture_trajectory`, `wiki_distill_skills`, `wiki_recall_skill`) are **opt-in,
off by default** (issue #80) — registered only when `llm-wiki.trajectories` is enabled
(`/wiki-trajectories on`).

| Tool                  | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `wiki_bootstrap`      | Initialize a new vault                      |
| `wiki_capture_source` | Capture URL/file/text into immutable packet |
| `wiki_recall`         | Search personal + project wikis for task-relevant pages (layered) |
| `wiki_retro`          | Save atomic insights from completed tasks   |
| `wiki_ingest`         | Get batch of uningested sources             |
| `wiki_ensure_page`    | Create canonical page from template         |
| `wiki_search`         | Search the wiki registry                    |
| `wiki_lint`           | Health check with auto-fix                  |
| `wiki_status`         | Instant stats                               |
| `wiki_observe` | Record a timestamped observation from the current session |
| `wiki_rebuild_meta`   | Force metadata rebuild                      |
| `wiki_reindex`        | Rebuild/repair the QMD search index at `meta/qmd` (lexical model-free; vectors may download ~2 GB) |
| `wiki_reindex_embeddings` | Refresh semantic embeddings (no-op when no embedding provider) |
| `wiki_log_event`      | Record custom event                         |
| `wiki_watch`          | Schedule auto-updates                       |
| `wiki_capture_trajectory` | Capture the completed task's tool-call trajectory |
| `wiki_distill_skills` | Batch undistilled trajectories for skill synthesis |
| `wiki_recall_skill`   | Recall distilled skills + similar past cases |

## Workflows

### Capture → Ingest → Synthesize

1. `wiki_capture_source(url="...")` — creates packet + skeleton
2. `wiki_ingest()` — get batch of sources needing synthesis
3. Read `.llm-wiki/raw/sources/SRC-*/extracted.md`
4. Update skeleton source page with summary, entities, concepts
5. `wiki_ensure_page(type="entity", title="...")` for each entity
6. Add `[[wikilinks]]` between related pages
7. Extension auto-rebuilds metadata

### Query → Answer → File

1. `wiki_search(query="...")` to find relevant pages
2. Read those pages
3. Synthesize answer with `[[wikilink]]` citations
4. If novel: create analysis page via `wiki_ensure_page(type="analysis")`
5. Extension auto-updates metadata

### Task → Record → Distill (agent working-memory)

_Opt-in: enable first with `/wiki-trajectories on`._

1. Finish a non-trivial task (debug, refactor, integration)
2. `wiki_capture_trajectory(title="...")` — auto-extracts the tool-call trajectory from the live session into `raw/trajectories/TRJ-*` with a self-contained summary (no skeleton to flesh)
3. `wiki_distill_skills()` — get undistilled trajectories
4. `wiki_ensure_page(type="skill", title="...")` — generalize into a reusable skill citing `[[trajectories/TRJ-...]]` (and optionally a `case` page)
5. Next time, `wiki_recall_skill(query="...")` surfaces the skill/case before you start
