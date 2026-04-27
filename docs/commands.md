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

## Extension Tools

The extension registers 10 tools the LLM can call directly:

| Tool                  | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `wiki_bootstrap`      | Initialize a new vault                      |
| `wiki_capture_source` | Capture URL/file/text into immutable packet |
| `wiki_ingest`         | Get batch of uningested sources             |
| `wiki_ensure_page`    | Create canonical page from template         |
| `wiki_search`         | Search the wiki registry                    |
| `wiki_lint`           | Health check with auto-fix                  |
| `wiki_status`         | Instant stats                               |
| `wiki_rebuild_meta`   | Force metadata rebuild                      |
| `wiki_log_event`      | Record custom event                         |
| `wiki_watch`          | Schedule auto-updates                       |

## Workflows

### Capture → Ingest → Synthesize

1. `wiki_capture_source(url="...")` — creates packet + skeleton
2. `wiki_ingest()` — get batch of sources needing synthesis
3. Read `raw/sources/SRC-*/extracted.md`
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
