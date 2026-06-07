<div align="center">

# @zosmaai/pi-llm-wiki

**English** | <a href="./README.zh.md">中文</a> | <a href="./README.es.md">Español</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.de.md">Deutsch</a> | <a href="./README.fr.md">Français</a> | <a href="./README.pt.md">Português</a> | <a href="./README.ru.md">Русский</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.hi.md">हिंदी</a>

[![CI](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zosmaai/pi-llm-wiki)](https://www.npmjs.com/package/@zosmaai/pi-llm-wiki)
[![npm downloads](https://img.shields.io/npm/dm/@zosmaai/pi-llm-wiki)](https://www.npmjs.com/package/@zosmaai/pi-llm-wiki)
[![Coverage](https://codecov.io/gh/zosmaai/pi-llm-wiki/branch/main/graph/badge.svg)](https://codecov.io/gh/zosmaai/pi-llm-wiki)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![CodeQL](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/codeql.yml/badge.svg)](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/codeql.yml)
[![GitHub Repo Stars](https://img.shields.io/github/stars/zosmaai/pi-llm-wiki?style=social)](https://github.com/zosmaai/pi-llm-wiki/stargazers)

</div>

<br/>

<div align="center">
  <a href="https://github.com/zosmaai/pi-llm-wiki/stargazers">
    <img src="./assets/thank-you-for-the-star.png" alt="Thank you for starring pi-llm-wiki!" width="100%" />
  </a>
  <br/>
  <sub>
    If you find pi-llm-wiki useful,
    <a href="https://github.com/zosmaai/pi-llm-wiki">⭐ star the repo</a> —
    it lets us know we're building something that matters.
  </sub>
</div>

<br/>

**Self-maintaining, Obsidian-compatible knowledge base for [pi](https://pi.dev).**
Follows Andrej Karpathy's [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Turn raw sources (URLs, PDFs, markdown, JSON, XML) into a durable, interlinked, LLM-maintained wiki that compounds over time.

---

## Quick Start

```bash
pi install npm:@zosmaai/pi-llm-wiki
```

The extension will proactively suggest creating a wiki on your first session. Alternatively:

```
/wiki-init "AI Engineering"
/wiki-ingest
/wiki-query What are the key patterns?
```

---

## Why This Package?

Most file-based LLM workflows behave like one-shot RAG: the model searches raw documents every time you ask a question. Synthesis is ephemeral.

**pi-llm-wiki** creates a middle layer:

- **Raw source packets** preserve source-of-truth inputs
- **Source pages** summarize what each source says
- **Canonical wiki pages** track what the wiki currently believes
- **Generated metadata** keeps everything searchable and navigable

The result is a wiki that **compounds** as you capture sources, ask questions, and file durable analyses.

---

## Features

| Capability | Description |
|------------|-------------|
| 🏠 **Personal fallback** | Always-on `~/.llm-wiki/` vault — knowledge compounds across projects even when no project wiki exists |
| 🔗 **Immutable source capture** | URLs, local files (PDF/md/txt/html/XML/JSON), or pasted text → structured source packets |
| 🧠 **Automated ingestion** | `wiki_ingest` batch-processes sources into concept, entity, synthesis & analysis pages |
| 🔍 **Full-text search** | Generated registry with keyword lookup across all pages and sources |
| 🩺 **Mechanical linting** | Orphans, broken links, duplicate aliases, coverage gaps, stale captures |
| 📊 **Dashboard** | `wiki_status` — counts, source states, recent activity |
| 🤖 **Auto-update watch** | `wiki_watch` — schedule periodic discovery + ingest |
| 🧠 **Layered recall** | Searches both personal (`~/.llm-wiki/`) and project (`.llm-wiki/`) vaults — personal knowledge follows you everywhere |
| 📝 **Auto-bootstrap** | Extension suggests creating a wiki when none exists in the current directory |
| 💾 **Lightweight capture** | `wiki_retro` — save atomic insights as a single markdown file; full 4-layer pipeline also available via `wiki_capture_source` |
| 🧭 **Agent working-memory** | `wiki_capture_trajectory` records *how* a task was solved (tool-call trajectory) → distill into reusable `skill`/`case` pages → `wiki_recall_skill` surfaces them next time |
| 🌐 **MCP Server** | Use with Claude Code, Cursor, Windsurf via stdio MCP transport |
| 📝 **Obsidian-friendly** | Folder-qualified wikilinks, stable source-ID citations, compatible vault |
| 🛡️ **Guardrails** | Blocks direct edits to raw sources and generated metadata |
| 🔧 **Configurable PDF extraction** | MarkItDown timeout via `WIKI_MARKITDOWN_TIMEOUT_MS` env var |
| 🧪 **38+ tests, CI, CodeQL** | TypeScript, Vitest, Biome, Codecov |

---

## Tools

| Tool | Description |
|------|-------------|
| `wiki_bootstrap` | Initialize a new wiki vault with config, templates, schema, and metadata |
| `wiki_capture_source` | Capture a URL, local file, or pasted text into an immutable source packet |
| `wiki_recall` | Search wiki for task-relevant pages — searches both personal (`~/.llm-wiki/`) and project (`.llm-wiki/`) vaults, deduplicated |
| `wiki_retro` | Save atomic insights from completed tasks into the wiki |
| `wiki_ingest` | Process uningested source packets into wiki pages (batch) |
| `wiki_ensure_page` | Resolve or safely create entity / concept / synthesis / analysis pages |
| `wiki_search` | Search the generated wiki registry |
| `wiki_lint` | Deterministic health checks (orphans, gaps, contradictions, auto-fix) |
| `wiki_status` | Show counts, source states, and recent activity |
| `wiki_rebuild_meta` | Force a full metadata rebuild (registry, backlinks, index, log) |
| `wiki_log_event` | Append a structured event to the wiki activity log |
| `wiki_watch` | Schedule automatic wiki updates (daily / weekly / hourly) |
| `wiki_capture_trajectory` | Capture the completed task's tool-call trajectory (agent working-memory) |
| `wiki_distill_skills` | Batch undistilled trajectories for synthesis into reusable skill pages |
| `wiki_recall_skill` | Recall distilled skills + similar past cases — "have I done this before?" |

### Slash Commands

| Command | Description |
|---------|-------------|
| `/wiki-init <topic>` | Initialize a new LLM Wiki vault |
| `/wiki-ingest [path]` | Process new source files and update the wiki |
| `/wiki-query <question>` | Ask questions against the wiki with citations |
| `/wiki-discover [--topic <topic>]` | Auto-discover new sources from the web |
| `/wiki-run [--schedule daily\|weekly]` | Full cycle: discover → ingest → lint |
| `/wiki-lint [--fix]` | Health check (orphans, contradictions, gaps) |
| `/wiki-status` | Show a concise operational summary |
| `/wiki-digest [--period daily\|weekly]` | Generate a digest of recent activity |
| `/wiki-retro` | Save atomic insights from completed tasks |
| `/wiki-req <concept>` | Decompose a concept into atomic, traceable requirement pages |
| `/wiki-record <title>` | Capture the completed task's trajectory (agent working-memory) |
| `/wiki-skills [query]` | Search distilled skills + past cases relevant to the task |

---

## Layered Vault Architecture

Knowledge follows you everywhere. pi-llm-wiki uses a layered vault system:

| Layer | Location | Purpose |
|-------|----------|---------|
| 🏠 **Personal** | `~/.llm-wiki/` | Always active. Zero setup. Knowledge compounds across all your sessions — regardless of which project you're in. |
| 📁 **Project** | `{project}/.llm-wiki/` | Explicit opt-in. Dedicated wiki per project, sharing personal knowledge when relevant. |
| 🏢 **Company** (future) | git-tracked | Shared wiki across a team. `wiki_publish` promotes personal/project pages to the company wiki. |

**How it works:**

1. `resolveVaultRoot()` checks: cwd → walk up for `.llm-wiki/` → `~/.llm-wiki/`
2. `wiki_recall` (layered) searches **both** personal and project vaults, merging results with vault labels
3. Personal results are shown first in recall output, tagged as "📓 personal"
4. `wiki_retro` writes to whichever vault is active (project takes priority)
5. Set `WIKI_HOME` env var to override the personal wiki location

This means: you can have a project wiki for team documentation **and** a personal wiki for your own notes, and recall searches both simultaneously.

---

## Quick Start (Detailed)

### 1) Create a new wiki

```bash
mkdir my-wiki
cd my-wiki
pi
```

Ask pi:

```
Initialize an llm wiki here for AI research.
```

This calls `wiki_bootstrap` and creates:

```
.llm-wiki/
├── config.json
├── templates/
├── raw/
├── wiki/
├── meta/
└── WIKI_SCHEMA.md
```

### 2) Capture a source

```
Capture this article into the wiki: https://example.com/some-article
```

```
Capture this PDF into the wiki: ./papers/context-windows.pdf
```

```
Capture these notes into the wiki: ...pasted text...
```

### 3) Integrate the source

1. Capture the source
2. Read `.llm-wiki/wiki/sources/SRC-*.md`
3. Update that source page
4. Search for impacted canonical pages with `wiki_search`
5. Create missing pages with `wiki_ensure_page`
6. Update concept / entity / synthesis pages with citations
7. Mark the integration with `wiki_log_event kind=integrate`

### 4) Query the wiki

```
Based on the wiki, what are the main tradeoffs between long-context models and RAG?
```

By default, query mode is **read-only**. To file a durable answer:

```
Answer the question and file the result as an analysis page.
```

---

## Vault Layout

```
my-wiki/
└─ .llm-wiki/
   ├─ config.json               # Vault config
   ├─ templates/                 # Page templates
   ├─ raw/
   │  └─ sources/
   │     └─ SRC-2026-05-11-001/
   │        ├─ manifest.json
   │        ├─ original/           # Original artifact
   │        ├─ extracted.md        # Normalized text
   │        └─ attachments/
   ├─ wiki/
   │  ├─ sources/                  # Source pages (what each source says)
   │  ├─ concepts/                 # Concepts and recurring ideas
   │  ├─ entities/                 # People, orgs, products, papers, systems
   │  ├─ syntheses/                # Cross-source theses and tensions
   │  └─ analyses/                 # Durable filed answers from queries
   ├─ meta/
   │  ├─ registry.json             # Auto-generated search index
   │  ├─ backlinks.json
   │  ├─ index.md
   │  ├─ events.jsonl              # Append-only event log
   │  ├─ log.md
   │  └─ lint-report.md
   └─ WIKI_SCHEMA.md               # Operating manual
```

### Ownership Model

| Path | Owner | Rule |
|------|-------|------|
| Path | Owner | Rule |
|------|-------|------|
| `.llm-wiki/raw/**` | Extension tools | Immutable after capture |
| `.llm-wiki/wiki/**` | Model + user | Editable knowledge pages |
| `.llm-wiki/meta/registry.json` | Extension | Generated |
| `.llm-wiki/meta/backlinks.json` | Extension | Generated |
| `.llm-wiki/meta/index.md` | Extension | Generated |
| `.llm-wiki/meta/events.jsonl` | Extension / tool | Append-only |
| `.llm-wiki/meta/log.md` | Extension | Generated from events |
| `.llm-wiki/meta/lint-report.md` | Extension | Generated |
| `.llm-wiki/WIKI_SCHEMA.md` | Human + explicit request | Operating manual |

---

## Linking & Citation Style

### Internal Navigation

```markdown
[[concepts/retrieval-augmented-generation]]
[[entities/openai|OpenAI]]
[[syntheses/long-context-vs-rag]]
```

### Factual Citations

```markdown
[[sources/SRC-2026-04-04-001|SRC-2026-04-04-001]]
```

Stable source-page IDs keep provenance stable even if titles change.

---

## Guardrails

The extension **blocks** direct tool-call edits to:

- `.llm-wiki/raw/**` — immutable source artifacts
- `.llm-wiki/meta/registry.json`
- `.llm-wiki/meta/backlinks.json`
- `.llm-wiki/meta/events.jsonl`
- `.llm-wiki/meta/index.md`
- `.llm-wiki/meta/log.md`
- `.llm-wiki/meta/lint-report.md`

If the model directly edits `.llm-wiki/wiki/**` using Pi's built-in `write` or `edit` tools, the extension **automatically rebuilds** generated metadata at the end of the agent turn.

---

## Source Packet Format

Each captured source is stored as a structured packet:

```
.llm-wiki/raw/sources/SRC-YYYY-MM-DD-NNN/
├─ manifest.json     # Capture metadata (title, URL, format, timestamp)
├─ original/         # Original artifact (preserved as-is)
├─ extracted.md      # Normalized text (PDF→md, XML→md, JSON→md, etc.)
└─ attachments/      # Future attachment downloads
```

This preserves both the **original artifact** and a **normalized extracted view** for reading.

---

## MCP Server

Use the wiki from **any MCP-compatible tool** — Claude Code, Cursor, Windsurf, and others.

The package ships a standalone MCP server exposing 5 wiki tools over stdio:

| Tool | Description |
|------|-------------|
| `wiki_recall` | Search wiki for task-relevant pages |
| `wiki_search` | Full registry search |
| `wiki_status` | Wiki stats (page counts, type breakdown) |
| `wiki_retro` | Save atomic insights |
| `wiki_capture_source` | Capture text as a source packet |

### Usage

```bash
# Auto-discovered by pi:
pi install npm:@zosmaai/pi-llm-wiki

# Standalone with any MCP client:
WIKI_ROOT=~/my-wiki node node_modules/@zosmaai/pi-llm-wiki/mcp/index.js
```

Set `WIKI_ROOT` to your wiki vault directory. If unset, the server auto-detects from the current working directory.

---

## Skill Behavior

The bundled `llm-wiki` skill teaches the model to:

- ❌ Never edit raw sources directly
- ❌ Never edit generated metadata files
- ✅ Capture first, integrate second
- ✅ Search before creating new canonical pages
- ✅ Cite facts using source-page IDs
- ✅ Keep query mode read-only by default
- ✅ Use "Tensions / caveats" and "Open questions" when evidence is mixed

---

## Architecture

### Vault Layers

See the [Layered Vault Architecture](#layered-vault-architecture) section above for the personal/project/company layering.

### Four-Layer Page Model

Each wiki vault has four layers with clear ownership:

```
.llm-wiki/raw/sources/SRC-*/     # Immutable source packets (extension-owned)
.llm-wiki/wiki/                   # Editable knowledge pages (you + LLM)
.llm-wiki/meta/                   # Auto-generated registry, backlinks, index, log
.llm-wiki/                        # Config and templates
```

Read [docs/architecture.md](docs/architecture.md) for the full design document.

---

## Documentation

| Document | What it covers |
|----------|---------------|
| [Architecture](docs/architecture.md) | How the four layers work, ownership model |
| [Commands](docs/commands.md) | All slash commands and tool reference |
| [Obsidian Integration](docs/obsidian.md) | Vault setup and recommended plugins |
| [Configuration](docs/configuration.md) | Wiki modes, topics, environment variables |
| [API](docs/api.md) | Extension tool parameter reference |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, test patterns, and PR workflow.

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=zosmaai/pi-llm-wiki&type=Date)](https://star-history.com/#zosmaai/pi-llm-wiki&Date)

## Contributors

Thanks to everyone who has contributed! This list is regenerated automatically by [`.github/workflows/contributors.yml`](.github/workflows/contributors.yml) — see [#60](https://github.com/zosmaai/pi-llm-wiki/issues/60) for the rationale.

<!-- readme: contributors -start -->
<table>
	<tbody>
		<tr>
            <td align="center">
                <a href="https://github.com/arjun-zosma">
                    <img src="https://avatars.githubusercontent.com/u/25246034?v=4" width="64;" alt="arjun-zosma"/>
                    <br />
                    <sub><b>Arjun Nayak</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/jfraser">
                    <img src="https://avatars.githubusercontent.com/u/165964?v=4" width="64;" alt="jfraser"/>
                    <br />
                    <sub><b>James Fraser</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/Shanvit7">
                    <img src="https://avatars.githubusercontent.com/u/64424817?v=4" width="64;" alt="Shanvit7"/>
                    <br />
                    <sub><b>Shanvit S Shetty</b></sub>
                </a>
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

<sub>Full history: [contributors graph](https://github.com/zosmaai/pi-llm-wiki/graphs/contributors).</sub>

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://github.com/zosmaai">zosmaai</a> · </sub>
  <a href="https://pi.dev">pi.dev</a> · <a href="https://github.com/zosmaai/pi-llm-wiki/issues">Issues</a>
</div>

## License

MIT
