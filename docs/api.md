# API Reference

## Extension Tools

### wiki_bootstrap

Initialize a new LLM Wiki vault.

```
wiki_bootstrap(topic: string, mode?: "personal" | "company", root?: string)
```

### wiki_capture_source

Capture a URL, file, or text into an immutable source packet.

```
wiki_capture_source(
  inputType: "url" | "file" | "text",
  value: string,
  title?: string,
  kind?: string,
  tags?: string[],
  createSourcePage?: boolean
)
```

### wiki_ingest

Get a batch of sources needing synthesis.

```
wiki_ingest(batch_size?: number)
```

### wiki_ensure_page

Create or resolve a canonical page.

```
wiki_ensure_page(
  type: "concept" | "entity" | "synthesis" | "analysis",
  title: string,
  aliases?: string[],
  tags?: string[],
  summary?: string,
  createIfMissing?: boolean
)
```

### wiki_search

Search the wiki registry.

```
wiki_search(query: string, type?: string, limit?: number)
```

### wiki_lint

Health check the wiki.

```
wiki_lint(mode?: string, writeReport?: boolean, limit?: number)
```

### wiki_status

Show wiki statistics.

```
wiki_status()
```

### wiki_rebuild_meta

Force metadata rebuild.

```
wiki_rebuild_meta()
```

### wiki_log_event

Record a structured event.

```
wiki_log_event(
  kind: string,
  title: string,
  summary?: string,
  sourceIds?: string[],
  pagePaths?: string[],
  notes?: string[],
  actor?: "agent" | "user" | "extension"
)
```

### wiki_watch

Schedule auto-updates.

```
wiki_watch(schedule: string, command: string)
```
