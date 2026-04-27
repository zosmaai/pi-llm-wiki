# 🧠 @zosmaai/pi-llm-wiki

> **Self-maintaining, Obsidian-compatible knowledge base for your pi coding agent.**
> Following Andrej Karpathy's LLM Wiki pattern — drop in sources, let the LLM build and maintain the wiki.

[![Pi Package](https://img.shields.io/badge/pi-package-8B5CF6?style=flat&logo=pinboard)](https://pi.dev/packages)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Follow Karpathy Pattern](https://img.shields.io/badge/pattern-Karpathy%20LLM%20Wiki-blue)](https://gist.github.com/karpathy/442a6bf555914893e9891c19de94f)
[![Obsidian Ready](https://img.shields.io/badge/Obsidian-ready-7C3AED?logo=obsidian)](https://obsidian.md)

---

## ✨ Features

| Capability        | Description                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| **📥 Ingest**     | Drop any source into `raw/` — the LLM reads, summarizes, extracts entities & concepts, cross-references everything |
| **🔍 Query**      | Ask questions against a persistent, interlinked knowledge base — not raw chunks                                    |
| **🧹 Lint**       | Health-check the wiki: contradictions, orphans, missing pages, stale claims, knowledge gaps                        |
| **🌐 Discover**   | Auto-find new sources from the web based on your topics and known gaps                                             |
| **🔄 Full Cycle** | `run` = discover → ingest → lint. One command to refresh everything                                                |
| **⏰ Watch**      | Schedule automatic updates (daily/weekly/hourly) via pi's cron system                                              |
| **📊 Status**     | Quick dashboard showing wiki size, health, and last activity                                                       |
| **📓 Digest**     | Daily/weekly summaries of what changed in the wiki                                                                 |

### Two Modes

- **👤 Personal Wiki** — Learning, journaling, book notes, health, goals, reflections
- **🏢 Company Wiki** — Competitor tracking, market research, customer calls, internal docs, change detection

### Obsidian Integration

Every `[[wikilink]]` the LLM creates becomes a visible connection in Obsidian's graph view. Includes Dataview dashboard, frontmatter for structured queries, and Marp-ready slide decks.

> "The wiki stays maintained because the cost of maintenance is near zero." — Andrej Karpathy

---

## 📦 What's Included

```
@zosmaai/pi-llm-wiki/
├── 📜 skills/llm-wiki/SKILL.md        ← Core schema: architecture, workflows, conventions
│   ├── templates/INDEX.md             ← Master catalog template
│   ├── templates/LOG.md               ← Activity log template
│   ├── templates/DASHBOARD.md         ← Obsidian Dataview dashboard
│   ├── templates/config.yaml          ← Default configuration
│   └── templates/pages/               ← Page templates (entity, concept, source, synthesis)
├── 🔧 extensions/llm-wiki-tools.ts    ← 5 custom tools for the LLM:
│   ├── wiki_ingest                    Process new sources and update wiki pages
│   ├── wiki_status_report             Report wiki health and statistics
│   ├── wiki_lint_report               Scan for contradictions, orphans, gaps
│   ├── wiki_discover_sources          Find new source material from the web
│   └── wiki_watch                     Schedule auto-updates
└── 💬 prompts/                        ← 8 slash commands:
    ├── /wiki:init                     Initialize a new wiki
    ├── /wiki:ingest                   Process new sources
    ├── /wiki:query                    Ask questions against the wiki
    ├── /wiki:lint                     Health check
    ├── /wiki:discover                 Auto-discover sources
    ├── /wiki:run                      Full cycle (discover → ingest → lint)
    ├── /wiki:status                   Wiki health overview
    └── /wiki:digest                   Daily/weekly summary
```

---

## 🚀 Installation

### Prerequisites

- [pi coding agent](https://pi.dev) installed
- Node.js 20+

### Via npm (recommended)

```bash
pi install npm:@zosmaai/pi-llm-wiki@latest
```

### Via git

```bash
pi install git:github.com/zosmaai/pi-llm-wiki@v0.1.0
```

### Via local path (development)

```bash
git clone https://github.com/zosmaai/pi-llm-wiki.git
pi install ./pi-llm-wiki
```

### Verify Installation

```bash
pi list
# Should show: @zosmaai/pi-llm-wiki

# Check loaded resources:
pi --list-skills | grep llm-wiki
pi --list-tools | grep wiki
# Should show: wiki_ingest, wiki_status_report, wiki_lint_report, wiki_discover_sources, wiki_watch
```

---

## 🎯 Quick Start

### 1️⃣ Initialize a new wiki

```bash
pi
```

Then inside pi:

```
/wiki:init "AI Engineering"
```

This creates your wiki directory structure and template files.

### 2️⃣ Add your first sources

Drop content into `raw/`:

- Use [Obsidian Web Clipper](https://obsidian.md/clipper) to save articles
- Save meeting notes, transcripts, or research papers
- Export Slack threads or email threads

### 3️⃣ Ingest

```
/wiki:ingest
```

The LLM reads every new source, creates wiki pages, cross-references everything, and builds the index. A single source typically generates 5-15 wiki pages (summary + entities + concepts + cross-refs).

### 4️⃣ Query

```
/wiki:query What are the key patterns in modern AI engineering?
```

The LLM answers from your wiki, not from general knowledge — giving you answers grounded in your curated sources.

### 5️⃣ Keep it fresh

```bash
# Auto-update daily at 8 AM
/wiki:run --schedule daily

# Or run manually anytime
/wiki:run
```

---

## 🏗️ Architecture

The LLM Wiki follows a three-layer architecture:

```
┌─────────────────────────────────────────────────────────┐
│                    YOU (curate & ask)                     │
├──────────────┬──────────────────────┬────────────────────┤
│   wiki/      │     outputs/         │   Obsidian vault    │
│  (read only) │  (reports, digests)  │  (graph view, UI)   │
├──────────────┴──────────────────────┴────────────────────┤
│              LLM (writes & maintains)                     │
├──────────────────────┬───────────────────────────────────┤
│      raw/            │         schema/SKILL.md            │
│  (immutable sources) │     (rules & conventions)          │
└──────────────────────┴───────────────────────────────────┘
```

### Directory Structure

```
my-wiki/
├── raw/                       ← You add sources here (immutable)
│   ├── articles/              Web articles (markdown)
│   ├── papers/                Research papers
│   ├── notes/                 Personal notes
│   ├── slack/                 Slack thread exports
│   └── assets/                Downloaded images
├── wiki/                      ← LLM manages this entirely
│   ├── INDEX.md               Master catalog
│   ├── LOG.md                 Activity log
│   ├── DASHBOARD.md           Obsidian Dataview dashboard
│   ├── entities/              People, orgs, tools, products
│   ├── concepts/              Ideas, patterns, frameworks
│   ├── sources/               One summary per source
│   ├── syntheses/             Cross-cutting analyses
│   └── changes/               Change detection records
├── outputs/                   Reports and digests
├── config.yaml                Wiki configuration
└── .discoveries/              Auto-discovery metadata
```

---

## 💬 All Commands

| Command          | Description         | Example                                   |
| ---------------- | ------------------- | ----------------------------------------- |
| `/wiki:init`     | Create a new wiki   | `/wiki:init "Rust Programming"`           |
| `/wiki:ingest`   | Process new sources | `/wiki:ingest raw/articles/my-article.md` |
| `/wiki:query`    | Ask a question      | `/wiki:query "Compare RAG vs LLM Wiki"`   |
| `/wiki:lint`     | Health check        | `/wiki:lint --fix`                        |
| `/wiki:discover` | Find new sources    | `/wiki:discover --topic "AI agents"`      |
| `/wiki:run`      | Full cycle          | `/wiki:run --schedule daily`              |
| `/wiki:status`   | Show health         | `/wiki:status`                            |
| `/wiki:digest`   | Daily summary       | `/wiki:digest --period weekly`            |

---

## 🔧 Custom Tools (Extension)

The included TypeScript extension registers 5 tools the LLM can call directly:

| Tool                    | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `wiki_ingest`           | Prepare and track files for ingestion           |
| `wiki_status_report`    | Gather wiki statistics and health metrics       |
| `wiki_lint_report`      | Scan for issues (orphans, contradictions, gaps) |
| `wiki_discover_sources` | Prepare discovery parameters from config        |
| `wiki_watch`            | Generate schedule commands                      |

These tools handle the scaffolding and bookkeeping so the LLM can focus on the actual knowledge work — reading, synthesizing, and writing wiki pages.

---

## 📓 Using with Obsidian

1. Open the `wiki/` directory as an Obsidian vault
2. Install these plugins:
   - [Dataview](https://github.com/blacksmithgu/obsidian-dataview) — Query pages by frontmatter
   - [Graph View](https://obsidian.md) (built-in) — Visualize [[wikilink]] connections
   - [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) — Flashcards
   - [Charts View](https://github.com/caronchen/obsidian-chartsview-plugin) — Dashboard analytics
   - [Marp](https://marp.app/) — Markdown slide decks
3. Browse the graph view to discover connections the LLM found
4. Use the `DASHBOARD.md` for live analytics

### Obsidian Web Clipper

Use the [Obsidian Web Clipper](https://obsidian.md/clipper) browser extension to save articles directly into `raw/articles/`. Set attachment folder to `raw/assets/` in Obsidian settings.

---

## 🏢 Personal vs. Company Wiki

### Personal Wiki (`config.yaml: mode: personal`)

Best for: Learning, research, journaling, book notes, health tracking, goals.

- Extra folders: `wiki/journal/`, `wiki/goals/`
- Daily journal entries can be ingested as raw sources
- Track people you meet, books you read, courses you take

### Company Wiki (`config.yaml: mode: company`)

Best for: Competitive intelligence, market research, customer insights, internal documentation.

- Extra folders: `wiki/decisions/`, `wiki/changes/`
- **Change detection** — Re-check competitor sources for pricing, feature, and positioning changes
- Confidence levels in frontmatter: `high | medium | low`
- Slack/email thread exports as sources
- Generate battlecards with `/wiki:query "Create a battlecard for Competitor X"`

---

## ⏰ Scheduling (Auto-Update)

Keep your wiki current without thinking about it:

```bash
# Inside pi
/wiki:run --schedule daily    # Discover → ingest → lint every day at 8 AM
/wiki:run --schedule weekly   # Every Monday at 9 AM
/wiki:run --schedule hourly   # Every hour (for fast-moving topics)
```

The scheduler uses pi's built-in `schedule_prompt` system. All operations run in the background and the wiki stays updated.

---

## 📚 Examples

### Research Wiki

```bash
/wiki:init "LLM Agents"
# Drop 5 papers into raw/papers/
/wiki:ingest
# Creates ~30-50 wiki pages (entities, concepts, cross-refs)
/wiki:query "What are the main approaches to tool use in LLM agents?"
/wiki:lint
```

### Book Companion

```bash
/wiki:init "Dune" --mode personal
# Drop chapter notes into raw/notes/
/wiki:ingest raw/notes/ch01-opening-test.md
/wiki:query "Who are the main factions and what do they want?"
/wiki:query "Create a timeline of events up to Chapter 5"
```

### Competitive Intelligence

```bash
/wiki:init "PM Tool Market" --mode company
# Drop competitor landing pages, reviews, pricing pages
/wiki:ingest
/wiki:query "Create a comparison table of Linear, Notion, and Jira"
/wiki:run --schedule weekly
```

---

## 🤝 Contributing

Contributions are welcome! This package is maintained at [zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki).

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a PR

### Development

```bash
git clone https://github.com/zosmaai/pi-llm-wiki.git
cd pi-llm-wiki
npm install
pi install ./
```

---

## 📄 License

MIT © zosmaai

---

## 🙏 Acknowledgments

- **Andrej Karpathy** — For the [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) that inspired this package
- **mduongvandinh** — For the comprehensive [llm-wiki](https://github.com/mduongvandinh/llm-wiki) reference implementation
- **tonbistudio** — For the [clean template](https://github.com/tonbistudio/llm-wiki) this draws from
- **Vannevar Bush** — For imagining the Memex in 1945. LLMs finally make it practical.
