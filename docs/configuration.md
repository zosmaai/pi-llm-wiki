# Configuration

Wiki configuration lives in `.wiki/config.json`.

## Modes

### Personal

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
