# QMD Compatibility

pi-llm-wiki's next major pins `@tobilu/qmd` **2.5.3**, the latest version published to npm when Phase 1 was planned.

## Runtime

- Node.js: `>=22.0.0`
- TypeScript development peer: `^5.9.3`
- Package manager: pnpm 9

Users requiring Node.js 18 must remain on the previous pi-llm-wiki major.

## Native compatibility

Clean-install CI covers:

- Linux x64
- macOS arm64
- Windows x64

QMD brings `better-sqlite3`, `sqlite-vec`, and `node-llama-cpp`. Failure to install required native packages is an installation failure, not a runtime lexical fallback.

## Model-free contract

`createStore`, `update`, `searchLex`, `getStatus`, and `close` must work without downloading or loading an embedding, expansion, or reranking model. Ordinary CI tests this path with `QMD_FORCE_CPU=1`.

## Model-backed contract

The scheduled/manual model smoke exercises:

- `embed`
- `searchVector`
- typed hybrid `search` with reranking disabled
- `expandQuery`
- expanded/reranked `search`

QMD stores default models under `~/.cache/qmd/models`. First use downloads roughly 2 GB across embedding, reranking, and expansion models. CI caches that directory. `QMD_FORCE_CPU=1` avoids GPU probing in compatibility jobs.

## Upgrade rule

Do not widen the QMD version range. A QMD upgrade requires:

1. exact-version lock update
2. SDK contract and clean-install CI passing
3. model smoke passing
4. retrieval benchmark comparison before production use
5. updated model and native-support documentation