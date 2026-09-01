# AGENTS.md

Instructions for AI agents working on this codebase.

## Project

`@zosmaai/pi-llm-wiki` — A package that implements Andrej Karpathy's LLM Wiki pattern as a self-maintaining knowledge base. It loads under **two hosts**: pi (`@mariozechner/pi-coding-agent`) and oh-my-pi (`omp`).

## Tech Stack

- TypeScript (ES2022, ESM)
- Vitest for testing
- Biome for linting/formatting
- GitHub Actions for CI
- npm for publishing

## File Layout

```
├── extensions/llm-wiki/     # TypeScript extension (14 tools + 3 opt-in trajectory tools + guardrails)
│   ├── index.ts             # Entry point
│   └── lib/                 # tools.ts, metadata.ts, guardrails.ts, utils.ts, source-packet.ts, host.ts
├── skills/llm-wiki/         # SKILL.md + templates
├── prompts/                 # slash command templates (source of truth; pi reads these)
├── commands/                # generated mirror of prompts/ (oh-my-pi reads these) — do not hand-edit
├── test/                    # Vitest tests
├── docs/                    # Documentation
└── scripts/                 # release.js, build-mcp.js, build-commands.js
```

## Conventions

- Use `node:fs/promises` for async file I/O, not sync
- Prefer small, pure functions in `lib/`
- Extension tools must have: name, label, description, promptSnippet, promptGuidelines, parameters (TypeBox), execute
- Guardrails block `.llm-wiki/raw/**` and `.llm-wiki/meta/**` edits at the tool_call hook level
- Metadata auto-rebuilds on `turn_end` after `.llm-wiki/wiki/**` edits
- Source IDs: `SRC-YYYY-MM-DD-NNN`
- Page filenames: `kebab-case.md`
- Wikilinks: folder-qualified, e.g. `[[concepts/retrieval-augmented-generation]]`
- Never resolve `.pi` / `.omp` config paths by hand — go through `lib/host.ts`
- After editing anything in `prompts/`, run `pnpm build:commands` (a test enforces parity)

## Testing

```bash
pnpm test              # run tests
pnpm test:coverage     # run with coverage
pnpm typecheck         # TypeScript check
pnpm lint              # biome check
```

## Release

```bash
npm run release:patch  # or minor/major
npm run release:push   # push tags
```

Never edit `package.json` version manually — use the release script.
