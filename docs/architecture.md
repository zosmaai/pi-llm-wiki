# Architecture

## Four Layers

```
WIKI_ROOT/
├── raw/sources/SRC-*/       # Immutable source packets (extension-owned)
│   ├── manifest.json         # Capture metadata
│   ├── original/             # Original artifact
│   ├── extracted.md          # Normalized markdown
│   └── attachments/          # Downloaded images, PDFs
├── wiki/                     # Editable knowledge pages (you + LLM)
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

## Ownership Rules

| Path      | Owner                    | Rule                     |
| --------- | ------------------------ | ------------------------ |
| `raw/**`  | Extension                | Immutable after capture  |
| `wiki/**` | Model + user             | Editable knowledge pages |
| `meta/*`  | Extension                | Auto-generated           |
| `.wiki/*` | Human + explicit request | Operating rules          |

## Source Packet Format

Each captured source becomes a packet:

```
raw/sources/SRC-YYYY-MM-DD-NNN/
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

## Linking Style

- Internal: `[[folder/page-name]]`
- Citation: `[[sources/SRC-YYYY-MM-DD-NNN]]`

## Guardrails

The extension blocks direct edits to `raw/**` and `meta/**`. Metadata rebuilds automatically after `wiki/**` edits.
