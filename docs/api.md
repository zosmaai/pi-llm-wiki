# API Reference

All 13 tools registered by the extension. Parameters marked `?` are optional.

---

## wiki_bootstrap

Initialize a new LLM Wiki vault with the 4-layer architecture. Creates config, templates, schema,
and metadata scaffolding.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `topic` | `string` | ✅ | Main topic of the wiki |
| `mode` | `string` | — | `"personal"` or `"company"` (default: `"personal"`) |
| `root` | `string` | — | Root directory to bootstrap in (default: current working directory) |

**Returns**

```
details: { root: string, mode: string, topic: string }
```

Confirmation text includes the vault path, directory layout, and a prompt to capture the first source.

---

## wiki_capture_source

Capture a URL, local file, or pasted text into an immutable source packet and skeleton source page.
Provide exactly one of `url`, `file_path`, or `text`.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | `string` | — | URL to fetch and capture |
| `file_path` | `string` | — | Absolute or relative path to a local file (PDF, md, txt, html, XML, JSON) |
| `text` | `string` | — | Pasted text content to capture directly |
| `title` | `string` | — | Title override (used for `text` captures; inferred from URL/file otherwise) |

**Returns**

```
details: {
  sourceId: string,          // e.g. "SRC-2026-06-03-001"
  packetPath: string,        // path to raw/sources/SRC-.../
  sourcePagePath: string,    // path to wiki/sources/SRC-....md (skeleton)
  extractedPreview: string   // first 300 chars of extracted content
}
```

Errors with `isError: true` if no vault exists or no source input is provided.

---

## wiki_ingest

Return a batch of uningested source packets for the LLM to synthesize. Does not write anything
itself — the model reads the returned extracted content, fills in the skeleton source page,
and creates entity/concept pages.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source_id` | `string` | — | Process a specific source ID only; leave empty to get the next unprocessed batch |
| `batch_size` | `number` | — | Max sources to return (default: `3`, max: `5`) |

**Returns**

```
details: {
  batch: string[],    // source IDs in this batch, e.g. ["SRC-2026-06-03-001"]
  remaining: number   // sources still waiting after this batch
}
```

Each batch entry includes the source title, char count, and the path to read (`raw/sources/{id}/extracted.md`).
Returns a "all sources ingested" message with `{ ingested, total }` when nothing is pending.

---

## wiki_ensure_page

Resolve or safely create a canonical wiki page. Returns immediately if the page already exists
(no overwrite). Uses a built-in template when `content` is not provided.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | `string` | ✅ | Page type: `"entity"`, `"concept"`, `"synthesis"`, `"analysis"`, or `"requirement"` |
| `title` | `string` | ✅ | Human-readable page title; auto-slugified to a kebab-case filename |
| `content` | `string` | — | Full markdown content for the page; if omitted, the type-appropriate template is used |

**Returns**

```
details: { path: string, created: boolean }
```

`created: false` means the page already existed and was not modified.

---

## wiki_recall

Search both the personal (`~/.llm-wiki/`) and project (`.llm-wiki/`) vaults for pages relevant to
a query. Uses chunk-level scoring, weighted field matching, and pseudo-relevance feedback. Also
called automatically before every agent turn.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` | ✅ | Search query — use the user's full request or key terms |
| `max_results` | `number` | — | Maximum pages to return (default: `5`, max: `10`) |

**Returns**

```
details: {
  query: string,
  matches: Array<{
    id: string,           // folder-qualified page ID, e.g. "concepts/rag"
    title: string,
    type: string,         // "source" | "entity" | "concept" | "synthesis" | "analysis"
    preview: string,      // best-matching chunk or page intro (~200 chars)
    path: string,         // absolute filesystem path to the .md file
    score: number,        // relevance score (higher = better)
    vaultLabel?: string   // "📓 personal" when result is from the personal vault
  }>
}
```

Returns empty `matches: []` with a hint to use `wiki_retro` when the wiki has no matching pages.

---

## wiki_search

Exact keyword search across the generated registry. Faster and simpler than `wiki_recall` — no
scoring, no PRF, no vault layering. Use for lookups when you already know what you're looking for.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` | ✅ | Search term matched against page IDs, titles, and types |
| `type` | `string` | — | Filter results to a specific page type (e.g. `"concept"`, `"entity"`) |

**Returns**

```
details: {
  query: string,
  matches: Array<{ id: string, title: string, type: string }>
}
```

---

## wiki_retro

Save an atomic insight from a completed task as a single lightweight markdown file in
`wiki/sources/`. Does not create a full source packet. Rebuilds metadata immediately so the
insight is searchable in the same session.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `slug` | `string` | ✅ | Unique kebab-case identifier (e.g. `"jwt-revocation-pattern"`). Used as the filename and for lookups. |
| `title` | `string` | ✅ | Short descriptive title, 60 chars max. Noun phrase, not a sentence. |
| `body` | `string` | ✅ | Markdown content explaining what was learned. Include `[[wikilinks]]` to related pages. |
| `category` | `string` | — | Optional grouping label (e.g. `"frontend"`, `"architecture"`, `"devops"`, `"bugfix"`) |

**Returns**

```
details: { slug: string, title: string, category: string | null }
```

---

## wiki_observe

Record a timestamped, relevance-rated observation during a session. Saved to `wiki/sources/` with
`status: observation`. Immediately searchable via `wiki_recall`. Intended for mid-session capture;
use `wiki_retro` for end-of-task summaries.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | `string` | ✅ | Short descriptive title, ≤80 chars. Noun phrase, not a sentence. |
| `content` | `string` | ✅ | Plain prose: what happened, was decided, or was learned. Preserve specifics (file paths, function names, error messages, numbers). |
| `relevance` | `"low" \| "medium" \| "high" \| "critical"` | ✅ | Retention priority. `low` = routine; `medium` = task context; `high` = non-trivial decisions; `critical` = persistent identity/preference or completed work that must not be redone. |
| `tags` | `string` | — | Space-separated tags for categorisation (e.g. `"auth backend migration"`) |
| `source_context` | `string` | — | What was being worked on (e.g. `"Adding authentication module"`) |

**Returns**

```
details: { slug: string, title: string, relevance: string, tags: string | null }
```

The slug is auto-generated as `obs-YYYY-MM-DD-{title-slug}`.

---

## wiki_lint

Deterministic health check of the wiki. Scans for orphan pages (no inbound links), missing pages
(linked but not created), and contradiction markers. Optionally auto-creates stub pages for
knowledge gaps cited in two or more pages.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `auto_fix` | `boolean` | — | When `true`, auto-creates stub concept pages for gaps mentioned in ≥2 pages (default: `false`) |

**Returns**

```
details: {
  pages: number,
  orphans: number,
  missingPages: number,
  contradictions: number,
  reportPath: string,   // path to the generated lint report .md file
  gaps: number          // knowledge gaps tracked in .discoveries/gaps.json
}
```

The lint report is written to `.llm-wiki/outputs/lint-YYYY-MM-DD.md`.
Contradictions are flagged by the presence of `⚠️ **Contradiction` markers in page content and
always require human review.

---

## wiki_status

Report wiki health and statistics from the generated registry. Reads pre-built metadata — does not
scan files directly.

**Parameters**

None.

**Returns**

```
details: {
  topic: string,
  mode: string,               // "personal" or "company"
  totalPages: number,
  byType: Record<string, number>,  // e.g. { concept: 4, entity: 2, source: 7 }
  orphans: number,
  gaps: number,
  health: "✅ Good" | "⚠️ Warning" | "🔴 Empty"
}
```

Health is `"⚠️ Warning"` when orphan count exceeds 5, `"🔴 Empty"` when the registry has no pages.

---

## wiki_rebuild_meta

Force a full synchronous rebuild of all generated metadata: `registry.json`, `backlinks.json`,
`index.md`, `log.md`. Use when metadata appears out of sync with actual wiki files.

**Parameters**

None.

**Returns**

```
details: { pageCount: number }
```

---

## wiki_log_event

Append a structured event to `meta/events.jsonl` and regenerate `meta/log.md`. Every event is
timestamped automatically.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `kind` | `string` | ✅ | Event kind label (e.g. `"ingest"`, `"query"`, `"decision"`, `"integrate"`) |
| `details` | `object` | — | Arbitrary additional fields to store alongside the event |

**Returns**

```
details: { kind: string }
```

---

## wiki_watch

Output the shell command needed to schedule automatic wiki updates (discover → ingest → lint) via
pi's `schedule_prompt` cron system. Does not schedule anything directly — it returns the command
for the user to run.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `interval` | `string` | ✅ | `"daily"` (8:00 AM), `"weekly"` (Monday 9:00 AM), `"hourly"`, or `"stop"` (prints removal instructions) |

**Returns**

```
details: {
  interval: string,
  cronSchedule: string,   // e.g. "0 0 8 * * *"
  label: string           // e.g. "Daily at 8:00 AM"
}
```

When `interval` is `"stop"`, returns `details: { action: "stop_instructions" }` with instructions
for removing existing jobs via `schedule_prompt action=remove`.

---

## Error Shape

All tools return `isError: true` in their result when a hard error occurs (no vault found, missing
required input). The `text` content will contain a human-readable explanation. Check for `isError`
before using `details`.

```ts
{
  content: [{ type: "text", text: string }],
  details: { error: string },
  isError: true
}
```

The most common error is **"No wiki found — run wiki_bootstrap first"**, returned by every tool
except `wiki_bootstrap` itself when `.llm-wiki/config.json` does not exist in the resolved vault
root.
