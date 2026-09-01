# Obsidian Integration

## Setup

1. Open `.llm-wiki/` as an Obsidian vault
2. Your wiki pages live in `wiki/` — Graph View and Backlinks work on these automatically
3. The extension generates `meta/index.md` (browsable catalog) and `meta/backlinks.json` (link map) — both are read-only, regenerated on each rebuild

## Recommended Plugins

- [Dataview](https://github.com/blacksmithgu/obsidian-dataview) — Query pages by frontmatter
- [Graph View](https://obsidian.md) (built-in) — Visualize `[[wikilink]]` connections in `wiki/`
- [Backlinks](https://obsidian.md) (built-in) — See inbound links

## Web Clipper

Use [Obsidian Web Clipper](https://obsidian.md/clipper) to save articles directly into `raw/articles/`.

## Dataview Dashboard

For custom dashboards, use Dataview queries against frontmatter fields like `type`, `domain`, `category`, `sources`. Query the `wiki/` directory for knowledge pages.
