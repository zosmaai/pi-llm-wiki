<div align="center">

# @zosmaai/pi-llm-wiki

**English** | <a href="./README.zh.md">中文</a> | <a href="./README.es.md">Español</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.de.md">Deutsch</a> | <a href="./README.fr.md">Français</a> | <a href="./README.pt.md">Português</a> | <a href="./README.ru.md">Русский</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.hi.md">हिंदी</a>

[![CI](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zosmaai/pi-llm-wiki)](https://www.npmjs.com/package/@zosmaai/pi-llm-wiki)
[![npm downloads](https://img.shields.io/npm/dm/@zosmaai/pi-llm-wiki)](https://www.npmjs.com/package/@zosmaai/pi-llm-wiki)
[![Coverage](https://img.shields.io/badge/coverage-85.09%25-brightgreen.svg)](https://codecov.io/gh/zosmaai/pi-llm-wiki)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![CodeQL](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/codeql.yml/badge.svg)](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/codeql.yml)
[![GitHub Repo Stars](https://img.shields.io/github/stars/zosmaai/pi-llm-wiki?style=social)](https://github.com/zosmaai/pi-llm-wiki/stargazers)

</div>

<br/>



**Self-maintaining, Obsidian-compatible knowledge base for [pi](https://pi.dev).**
Follows Andrej Karpathy's [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Turn raw sources (URLs, PDFs, markdown, JSON, XML) into a durable, interlinked, LLM-maintained wiki that compounds over time.

### Native Open Knowledge Format (OKF) v0.2 support

Build a knowledge base you can carry forward — not another closed, app-specific export:

- **Create portable OKF v0.2 documents** with canonical frontmatter, standard Markdown links, and stable source citations.
- **Read both legacy and OKF pages** so existing vaults keep working without an automatic migration or rewrite.
- **Generate deterministic indexes and logs** from authoritative pages, keeping navigation and metadata reproducible.
- **Use the same knowledge model from Pi or MCP** with Claude Code, Cursor, Windsurf, and other MCP clients.
- **Stay Obsidian-compatible** while keeping your knowledge ready for tools that support Open Knowledge Format.

Start with a new OKF vault, or point pi-llm-wiki at an existing vault and adopt the format on your terms. See the [OKF Foundation specification](docs/superpowers/specs/2026-08-02-okf-foundation-design.md) for implementation details.

---

## Demo

<div align="center">
  <img src="./assets/demo.gif" alt="pi-llm-wiki demo" width="1920" />
</div>

---

## Quick Start

**pi** ([`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono)):

```bash
pi install npm:@zosmaai/pi-llm-wiki
```

**oh-my-pi** ([`omp`](https://github.com/can1357/oh-my-pi)):

```bash
omp install @zosmaai/pi-llm-wiki
```

Both hosts load the same extension, skill, and `/wiki-*` slash commands — see
[Dual-host support](#dual-host-support-pi--oh-my-pi) for what differs.

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
| 🤖 **Auto-update watch** | `wiki_watch` — print a `crontab` line that runs the full cycle on a schedule |
| 🧠 **Layered recall** | Searches both personal (`~/.llm-wiki/`) and project (`.llm-wiki/`) vaults — personal knowledge follows you everywhere |
| 📝 **Auto-bootstrap** | Extension suggests creating a wiki when none exists in the current directory |
| 💾 **Lightweight capture** | `wiki_retro` — save atomic insights as a single markdown file; full 4-layer pipeline also available via `wiki_capture_source` |
| 🧭 **Agent working-memory** _(opt-in)_ | `wiki_capture_trajectory` records *how* a task was solved (tool-call trajectory) → distill into reusable `skill`/`case` pages → `wiki_recall_skill` surfaces them next time. Off by default; enable with `/wiki-trajectories on` |
| 🌐 **OKF v0.2 native** | Portable Open Knowledge Format documents, dual-read legacy compatibility, deterministic projections |
| 🌐 **MCP Server** | Use the same OKF-aware wiki from Claude Code, Cursor, Windsurf via stdio MCP transport |
| 📝 **Obsidian-friendly** | Folder-qualified wikilinks, stable source-ID citations, compatible vault |
| 🛡️ **Guardrails** | Blocks direct edits to raw sources and generated metadata |
| 🔧 **Configurable PDF extraction** | MarkItDown timeout via `WIKI_MARKITDOWN_TIMEOUT_MS` env var |
| 🧪 **562 tests, 85.09% coverage** | TypeScript, Vitest, Biome, Codecov, CodeQL |

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
| `wiki_reindex` | Rebuild/repair the generated QMD search index at `meta/qmd` (lexical is model-free; vectors may download ~2 GB) |
| `wiki_log_event` | Append a structured event to the wiki activity log |
| `wiki_watch` | Print a `crontab` line for automatic wiki updates (daily / weekly / hourly) — does not install it |
| `wiki_capture_trajectory` _(opt-in)_ | Capture the completed task's tool-call trajectory (agent working-memory) |
| `wiki_distill_skills` _(opt-in)_ | Batch undistilled trajectories for synthesis into reusable skill pages |
| `wiki_recall_skill` _(opt-in)_ | Recall distilled skills + similar past cases — "have I done this before?" |

> The three agent-trajectory tools are **off by default** (issue #80). Enable them with `/wiki-trajectories on` (sets `llm-wiki.trajectories`); when off they are not registered at all.

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
| `/wiki-trajectories <on\|off>` | Enable/disable agent working-memory (opt-in, off by default) |
| `/wiki-record <title>` | Capture the completed task's trajectory (requires trajectories enabled) |
| `/wiki-skills [query]` | Search distilled skills + past cases (requires trajectories enabled) |

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
| `.llm-wiki/meta/events.jsonl` | Extension / tool | Authoritative append-only state; back up for activity continuity |
| `.llm-wiki/meta/log.md` | Extension | Generated from events |
| `.llm-wiki/meta/lint-report.md` | Extension | Generated |
| `.llm-wiki/meta/qmd/**` | Extension | Generated QMD search index (mirrors + SQLite); local, rebuildable with `wiki_reindex` |
| `.llm-wiki/WIKI_SCHEMA.md` | Human + explicit request | Operating manual |

### Generated QMD search index (phase 2)

`.llm-wiki/meta/qmd/**` is extension-owned, generated, local, and **rebuildable** with `wiki_reindex`.

- `.llm-wiki/wiki/**` remains authoritative and user editable; QMD never scans it directly.
- `manifest.json` maps validated mirrors back to stable `(vault_id, page_id)` identities.
- `documents/{canonical,evidence}/**` hold parser-valid mirrors that QMD indexes; the two collections never overlap.
- `current/index.sqlite` is the live store. Do **not** copy, partially restore, or edit individual SQLite/WAL/SHM files inside `current` — restore the whole generated directory or rebuild with `wiki_reindex`.
- Ordinary write-triggered updates are **lexical and model-free**. Selecting `vectors` may download approximately 2 GB of models on first use.
- Cancellation and failures retain the last usable `current` store; stale/error/recovering state is repaired with `wiki_reindex`.
- Full-vault backups include the generated searchable text (`meta/qmd`); OKF-only exports do not.
- **Active recall still uses the legacy heuristic until Phase 3.** QMD indexing is observable and repairable, but no recall path depends on it yet.

### Activity history, backup, and portability

`meta/events.jsonl` is the authoritative source for recorded extension activity. Unlike registry, backlinks, indexes, logs, and embeddings, it cannot be rebuilt from wiki pages or raw packets. Preserve it when backing up or Git-synchronizing a complete pi-llm-wiki vault.

`meta/log.md` and OKF-mode `wiki/log.md` are generated views. `wiki/log.md` can travel with the OKF bundle as a readable snapshot, but it cannot reconstruct or resume the originating JSONL stream. Manual page edits are intentionally absent, so this is selected extension activity rather than a complete revision audit.

File-capture events omit machine-local paths from the public log projection. Callers of `wiki_log_event` still control arbitrary detail fields and must not record secrets or private host paths.

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

The package ships a standalone MCP server exposing 6 wiki tools over stdio:

| Tool | Description |
|------|-------------|
| `wiki_bootstrap` | Initialize a new wiki vault with config, templates, schema, and metadata |
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
WIKI_ROOT=~/my-wiki node node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js
```

Set `WIKI_ROOT` to your wiki vault directory. If unset, the server auto-detects from the current working directory.

### Client configuration

The same server as an entry in `.mcp.json` (Claude Code) or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": { "WIKI_ROOT": "/absolute/path/to/my-wiki" }
    }
  }
}
```

> MCP clients spawn the command **without a shell**, so `~` is never expanded. A `~/my-wiki` in `args` or `env` is passed through literally and the server fails to start, which the client reports only as a generic connection error — use absolute paths here. The shell snippet above is fine: your shell expands `~` before `node` sees it.

---

## Dual-host support (pi + oh-my-pi)

The package targets two hosts from a single codebase:

| | **pi** (`@mariozechner/pi-coding-agent`) | **oh-my-pi** (`omp`) |
|---|---|---|
| Extension entry | `package.json#pi.extensions` | `package.json#omp.extensions` (falls back to `#pi`) |
| Skill | `skills/llm-wiki/SKILL.md` via `pi.skills` | same file, found by directory convention |
| Slash commands | `prompts/*.md` via `pi.prompts` | `commands/*.md` (generated mirror of `prompts/`) |
| Project config | `<cwd>/.pi/settings.json` | `<cwd>/.omp/settings.json`, then `.omp/config.yml` |
| User config | `~/.pi/agent/settings.json` | `~/.omp/agent/settings.json`, then `config.yml` |
| MCP server | auto-registered via `pi.mcpservers` | register manually (see below) |
| Ambient surfaces without a project wiki | on (personal vault) | off — see below |

No source changes are needed for the imports: oh-my-pi rewrites
`@mariozechner/pi-*` and bare `typebox` specifiers onto its own bundled
packages when it loads a legacy extension.

**Settings are read from both layouts.** `llm-wiki` config is merged from every
file above, host-native directory last. A vault configured under pi keeps
working after `omp` takes over the same repository, and writes land in whichever
config directory already exists (so a `.pi`-only repo does not sprout a second
settings file). Writes are always JSON — a hand-authored `config.yml` is read
but never rewritten.

Set `LLM_WIKI_HOST=pi|omp` to override host detection; by default it is derived
from the resolved agent directory.

**Ambient surfaces are gated under oh-my-pi.** The session notice, the periodic
observe/retro reminder, and `before_agent_start` recall all fire unprompted, and
vault resolution falls back to the personal vault — so once `~/.llm-wiki/`
exists they would speak up in *every* directory. Under pi that is the historical
behaviour and it is kept; under omp the plugin is installed once and loads in
every project, so a repository that never ran `/wiki-init` stays quiet. Override
either default with `llm-wiki.ambientPersonalVault`. The wiki tools and slash
commands are registered regardless, so `/wiki-init` always works — and a project
with its own `.llm-wiki/` gets every surface back.

**MCP under oh-my-pi.** `pi.mcpservers` is a pi-only manifest key, and the
server's vault auto-detection depends on the client's working directory, so it
cannot be declared with a relative path. Register it explicitly instead:

```jsonc
// <cwd>/.omp/.mcp.json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/abs/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": { "WIKI_ROOT": "/abs/path/to/your/wiki" }
    }
  }
}
```

You rarely need it: under either host the extension already registers the same
capabilities as native tools.

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
.llm-wiki/meta/                   # Durable event source + generated internal projections
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
                <a href="https://github.com/Shanvit7">
                    <img src="https://avatars.githubusercontent.com/u/64424817?v=4" width="64;" alt="Shanvit7"/>
                    <br />
                    <sub><b>Shanvit S Shetty</b></sub>
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
                <a href="https://github.com/mkuhl">
                    <img src="https://avatars.githubusercontent.com/u/61073?v=4" width="64;" alt="mkuhl"/>
                    <br />
                    <sub><b>Mike P. Kuhl</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/CelestialCreator">
                    <img src="https://avatars.githubusercontent.com/u/177931942?v=4" width="64;" alt="CelestialCreator"/>
                    <br />
                    <sub><b>Akshay</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/prestalab">
                    <img src="https://avatars.githubusercontent.com/u/2825421?v=4" width="64;" alt="prestalab"/>
                    <br />
                    <sub><b>PrestaLab</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/xcsf">
                    <img src="https://avatars.githubusercontent.com/u/43439835?v=4" width="64;" alt="xcsf"/>
                    <br />
                    <sub><b>xcsf</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/danielnaab">
                    <img src="https://avatars.githubusercontent.com/u/136512?v=4" width="64;" alt="danielnaab"/>
                    <br />
                    <sub><b>Daniel Naab</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/deestax">
                    <img src="https://avatars.githubusercontent.com/u/152369481?v=4" width="64;" alt="deestax"/>
                    <br />
                    <sub><b>Superdao</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/mystery4f">
                    <img src="https://avatars.githubusercontent.com/u/40482524?v=4" width="64;" alt="mystery4f"/>
                    <br />
                    <sub><b>标准萌新</b></sub>
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
