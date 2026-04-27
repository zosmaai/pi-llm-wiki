# Changelog

## [Unreleased]

## [0.2.0] - 2026-04-28

### Added

- **4-layer architecture**: raw/, wiki/, meta/, .wiki/ with explicit ownership rules
- **Source packets**: Structured capture with manifest.json, original/, extracted.md, attachments/
- **10 custom tools** (up from 5): wiki_bootstrap, wiki_capture_source, wiki_ingest, wiki_ensure_page, wiki_search, wiki_lint, wiki_status, wiki_rebuild_meta, wiki_log_event, wiki_watch
- **Auto-generated metadata**: registry.json, backlinks.json, index.md, log.md, events.jsonl
- **Guardrails**: Extension blocks direct edits to raw/** and meta/** via tool_call hook
- **Auto-rebuild**: Metadata rebuilds automatically after wiki/\*\* edits via turn_end hook
- **Batch ingest**: wiki_ingest returns source batches with extracted content previews
- **Improved lint**: Orphans, missing pages, contradictions, knowledge gaps with auto_fix option
- **Release scripts**: Automated semver bumping, changelog updates, git tagging
- **Coverage reporting**: v8 coverage in CI with lcov output

### Changed

- Extension moved from single file to modular directory structure (extensions/llm-wiki/)
- Skill reduced from ~500 lines to ~150 lines — principles over mechanics
- Metadata is now machine-owned; LLM never edits INDEX.md or LOG.md manually
- Source IDs use stable format SRC-YYYY-MM-DD-NNN for rename-safe citations

### Removed

- Manual INDEX.md/LOG.md maintenance from skill workflows
- Legacy flat raw/articles/ structure (replaced by structured source packets)
