---
description: Ask questions against the wiki. Synthesizes answers from wiki pages with cross-reference citations.
args: <question>
section: LLM Wiki
topLevelCli: true
---

# /wiki:query

Ask a question and get an answer synthesized from wiki content.

Read the LLM Wiki skill at `.pi/skills/llm-wiki/SKILL.md` first to understand the full schema and conventions.

## Steps

1. Read `wiki/INDEX.md` to find pages relevant to the question
2. Read those pages in full (don't stop at 1-2 pages — get thorough context)
3. Synthesize an answer with `[[wikilink]]` citations to specific wiki pages
4. If the answer reveals a new connection or analysis, save it as a synthesis page in `wiki/syntheses/`
5. Append to `wiki/LOG.md`

**Rules:** Answer ONLY from wiki content, not from general knowledge. If the wiki lacks information, say so clearly and suggest what sources would help fill the gap.

**Example:**

```
/wiki:query What are the key differences between RAG and LLM Wiki?
→ Reads INDEX.md, finds pages on RAG and LLM Wiki patterns
→ Reads both pages
→ Synthesizes a comparison table with [[wikilink]] citations
→ Saves as wiki/syntheses/rag-vs-llm-wiki.md
```
