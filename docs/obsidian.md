# Obsidian Integration

## Setup

1. Open `wiki/` as an Obsidian vault
2. The extension generates `meta/index.md` as a browsable catalog
3. `meta/backlinks.json` is available for graph plugins

## Recommended Plugins

- [Dataview](https://github.com/blacksmithgu/obsidian-dataview) — Query pages by frontmatter
- [Graph View](https://obsidian.md) (built-in) — Visualize `[[wikilink]]` connections
- [Backlinks](https://obsidian.md) (built-in) — See inbound links

## Web Clipper

Use [Obsidian Web Clipper](https://obsidian.md/clipper) to save articles directly into `raw/articles/`.

## Dataview Dashboard

The extension creates `meta/index.md` with page listings. For custom dashboards, use Dataview queries against frontmatter fields like `type`, `domain`, `category`, `sources`.
