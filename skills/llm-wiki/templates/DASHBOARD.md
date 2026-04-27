# Wiki Dashboard

> Live views powered by Obsidian Dataview. Install the [Dataview plugin](https://github.com/blacksmithgu/obsidian-dataview) for this to work.

## Recent Updates

```dataview
TABLE updated, type AS "Type", file.folder AS "Folder"
FROM "wiki"
SORT updated DESC
LIMIT 20
```

## By Type

```dataview
TABLE rows.file.link AS "Pages"
FROM "wiki"
GROUP BY type
```

## Low Confidence Pages

```dataview
TABLE confidence, updated, file.folder AS "Folder"
FROM "wiki"
WHERE confidence = "low"
SORT updated ASC
```

## Orphan Pages

_Pages with no inbound [[wikilinks]] — run `/wiki-lint` to detect and fix._

## Most-Connected Concepts

_Pages with the most inbound [[wikilinks]] — these are the knowledge hubs._

## Knowledge Gaps

_Topics mentioned but lacking their own page — run `/wiki-lint` to detect._

## Recent Activity

```dataview
LIST
FROM "wiki/LOG.md"
SORT file.mtime DESC
LIMIT 10
```
