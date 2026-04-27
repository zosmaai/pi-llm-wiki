# @zosmaai/pi-llm-wiki — Architecture Diagram

This Mermaid diagram shows the three-layer architecture of the LLM Wiki pattern.

```mermaid
flowchart TB
    subgraph Human["👤 You (Curate & Ask)"]
        direction LR
        Sources["📄 Drop Sources"] --> Questions["❓ Ask Questions"]
    end

    subgraph LLM["🤖 LLM (Writes & Maintains)"]
        direction TB
        SKILL["📜 SKILL.md Schema"]
        INGEST["📥 Ingest<br/>Read → Summarize → Cross-ref"]
        QUERY["🔍 Query<br/>Index → Synthesize → Cite"]
        LINT["🧹 Lint<br/>Contradictions → Orphans → Gaps"]
        DISCOVER["🌐 Discover<br/>Search → Fetch → Save"]
    end

    subgraph Storage["💾 File System"]
        direction LR
        RAW["raw/<br/>(immutable sources)"]
        WIKI["wiki/<br/>(LLM-managed markdown)"]
        OUTPUTS["outputs/<br/>(reports, digests)"]
    end

    subgraph Obsidian["📓 Obsidian Integration"]
        GRAPH["Graph View<br/>[[wikilinks]]"]
        DATAVIEW["Dataview<br/>Frontmatter queries"]
        DASHBOARD["Dashboard<br/>Analytics"]
    end

    Sources --> RAW
    RAW --> INGEST
    INGEST --> WIKI
    SKILL --> INGEST
    SKILL --> QUERY
    SKILL --> LINT
    SKILL --> DISCOVER
    DISCOVER --> RAW
    QUERY --> WIKI
    QUERY --> OUTPUTS
    LINT --> WIKI
    LINT --> OUTPUTS
    Questions --> QUERY
    WIKI --> GRAPH
    WIKI --> DATAVIEW
    WIKI --> DASHBOARD
```

## Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    YOU (curate & ask)                     │
├──────────────┬──────────────────────┬────────────────────┤
│   wiki/      │     outputs/         │   Obsidian vault    │
│  (read only) │  (reports, digests)  │  (graph view, UI)   │
├──────────────┴──────────────────────┴────────────────────┤
│              LLM (writes & maintains)                     │
├──────────────────────┬───────────────────────────────────┤
│      raw/            │         SKILL.md schema            │
│  (immutable sources) │     (rules & conventions)          │
└──────────────────────┴───────────────────────────────────┘
```

## Three Operations

| Operation  | Trigger              | What Happens                                                                                |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------- |
| **Ingest** | Add source to `raw/` | LLM reads, creates summary, updates 5-15 wiki pages, cross-references, flags contradictions |
| **Query**  | Ask any question     | LLM searches index, reads relevant pages, synthesizes answer with `[[citations]]`           |
| **Lint**   | `/wiki:lint`         | Health check: contradictions, orphans, missing pages, stale claims, knowledge gaps          |

## Two Modes

- **👤 Personal Wiki** — Learning, journaling, goals, book notes
- **🏢 Company Wiki** — Competitive intel, change detection, battlecards
