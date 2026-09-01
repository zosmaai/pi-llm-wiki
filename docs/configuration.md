# Configuration

Wiki configuration lives in `.llm-wiki/config.json`.

## Modes

### Personal

The personal vault lives at `~/.llm-wiki/` (or `$WIKI_HOME`) and is always available as a fallback when no project wiki exists. It accumulates knowledge across all your sessions.

- Extra folders: `wiki/journal/`, `wiki/goals/`
- Track: learning, books, health, reflections

### Company

- Extra folders: `wiki/changes/`, `wiki/decisions/`
- Track: competitors, market, strategy
- Frontmatter: `confidence: high | medium | low`

## Settings

| Setting                    | Default | Description                        |
| -------------------------- | ------- | ---------------------------------- |
| `max_sources_per_discover` | 8       | Sources fetched per discovery run  |
| `auto_fix_lint`            | false   | Auto-fix lint issues               |
| `batch_ingest_size`        | 3       | Sources processed per ingest batch |

## Environment Variables

| Variable                      | Default     | Description                                     |
| ----------------------------- | ----------- | ----------------------------------------------- |
| `WIKI_HOME`                   | `~/.llm-wiki` | Override the personal wiki vault location     |
| `WIKI_MARKITDOWN_TIMEOUT_MS` | 180000      | Timeout (ms) for MarkItDown PDF/text extraction |
| `LLM_WIKI_HOST`              | auto        | Force the host layout: `pi` or `omp`            |

## Agent Settings

Runtime settings for the wiki's background tasks live under the `llm-wiki`
namespace of the host's settings file. Both host layouts are read and merged,
lowest precedence first:

1. `<agentDir>/settings.json`, then `config.yml` / `config.yaml`
   — `~/.pi/agent` under pi, `~/.omp/agent` under oh-my-pi
2. `<cwd>/.pi/{settings.json,config.yml,config.yaml}`
3. `<cwd>/.omp/{settings.json,config.yml,config.yaml}`

The **host-native** project directory is applied last, so it wins: `.omp` under
oh-my-pi, `.pi` under pi. Reading the other host's directory means a vault
configured under pi keeps working after `omp` takes over the repository.

`/wiki-model` and `/wiki-trajectories` write JSON only, into whichever project
config directory already exists (host-native first, created if neither is
present). A hand-authored `config.yml` is read but never rewritten.

| Setting                | Default    | Description                                                  |
All of the above are viewable and editable in the `/wiki-settings` TUI (persists to project or global settings).
| ---------------------- | ---------- | ------------------------------------------------------------ |
| `taskModel`            | —          | Model for background tasks (`{ provider: "openai", id: "gpt-4o" }`) |
| `synthesisLanguage`    | —          | BCP 47 language tag for ingest synthesis (e.g. `"ru"`, `"fr"`). When unset, synthesis defaults to English. |
| `synthesisMaxTokens`     | 16384    | Max output tokens for ingest/synthesis runs (stored as a plain number)                        |
| `wikilinkValidation`   | warn       | Pre-write wikilink gate for page writes (ingest, `wiki_ensure_page`, `wiki_retro`, MCP `wiki_retro`). `off` ignore, `warn` report, `normalize` rewrite resolvable links, `strict` block writes with unresolved/ambiguous links |
| `trajectories`         | false      | Enable agent-trajectory working-memory                       |
| `notices`              | true       | Show wiki activity notices in chat                           |
| `ambientPersonalVault` | host-dependent | Let the personal vault act as the ambient vault in projects that have no wiki. `true` under pi, `false` under oh-my-pi — see below. |
| `semanticWeight`       | 0.5      | Weight of the semantic sub-score in hybrid recall (clamped 0–1)                               |
| `recallLinksThreshold` | 50       | Page-count gate for two-stage links-first recall (0 = always links-first, issue #68)          |
| `recallSkillInlineMax` | 1600     | Max chars of a skill/case body inlined into recall output (0 = links only)                    |
| `embeddingProvider`    | —        | Embedding provider (e.g. `openai`); embeddings stay off until this is set                     |
| `embeddingModel`       | —        | Embedding model name (provider-specific)                                                      |
| `embeddingBaseUrl`     | —        | Optional API base URL override for the embedding provider                                     |
| `embeddingApiKey`      | —        | API key literal — prefer `embeddingApiKeyEnv` so no secret lands in settings                  |
| `embeddingApiKeyEnv`   | —        | Name of the environment variable holding the embedding API key                                |

Example:

```json
{
  "llm-wiki": {
    "synthesisLanguage": "ru",
    "taskModel": {
      "provider": "openai",
      "id": "gpt-4o"
    }
  }
}
```

## Vault Resolution

The vault root is resolved in this priority order:

1. **Project vault**: walk up from current directory looking for `.llm-wiki/`
2. **Personal vault**: fall back to `$WIKI_HOME` or `~/.llm-wiki/`

This means when you're in a project with its own `.llm-wiki/`, that project wiki is active. When you're outside any project wiki, your personal `~/.llm-wiki/` takes over automatically.

### Ambient surfaces in projects without a wiki

Three surfaces fire without being asked: the session notice, the periodic
observe/retro reminder, and the `before_agent_start` recall injection (plus its
`<wiki_status>` system-prompt footer).

Because vault resolution falls back to the personal vault, those surfaces would
otherwise speak up in *every* directory as soon as `~/.llm-wiki/` exists —
injecting reminders and unrelated cross-project recall hits into repositories
where no wiki was ever initialized. Under oh-my-pi the plugin is installed once
and loads in every project, so that fallback is **off** by default there; under
pi the historical behaviour is kept.

`ambientPersonalVault` overrides the host default in either direction:

```json
{ "llm-wiki": { "ambientPersonalVault": true } }
```

The gate only affects unprompted injections. Tools and slash commands are
always registered, so `/wiki-init` and `wiki_bootstrap` work in any directory —
and once a project has its own `.llm-wiki/`, every ambient surface turns back on
for it.

## Page Frontmatter

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
