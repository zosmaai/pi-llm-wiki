# QMD Compatibility

pi-llm-wiki pins `@tobilu/qmd` **2.8.3** exactly, in
`package.json#optionalDependencies` and as `QMD_PACKAGE_VERSION` in
`extensions/llm-wiki/lib/qmd-store.ts`. It is an **optional** dependency: every
wiki feature except the semantic index works without it.

## Runtime

- Node.js: `>=22.0.0`
- TypeScript: qmd declares `peer typescript@^5.9.3`. The peer is compile-time
  only for qmd's published JavaScript, but it decides whether npm installs qmd
  at all — see [Installing on npm hosts](#installing-on-npm-hosts).
- Package manager: pnpm 9

Users requiring Node.js 18 must remain on the previous pi-llm-wiki major.

## Installing on npm hosts

npm removes an optional subtree whose peer requirements it cannot satisfy, and it
does not warn. Because qmd declares `peer typescript@^5.9.3`, any install that
has TypeScript 6 or 7 in the tree loses `@tobilu/qmd` silently: the install
output stays green, `node_modules/@tobilu/qmd` does not exist, and the first
`wiki_reindex` reports that qmd is not installed. Issue #302 has a full
reproduction.

`pi install npm:@zosmaai/pi-llm-wiki` is not affected. pi passes
`--legacy-peer-deps` to npm — `getNpmInstallArgs` in pi's
`dist/core/package-manager.js` — precisely so host-provided peers cannot block
an install.

Check whether you have it:

```bash
ls ~/.pi/agent/npm/node_modules/@tobilu/qmd    # pi's own install location
```

If it is missing, install it with peer resolution relaxed:

```bash
cd <directory containing node_modules/@zosmaai/pi-llm-wiki>
npm install @tobilu/qmd@2.8.3 --legacy-peer-deps
```

`wiki_reindex` reports `ready` afterwards. Until then, keyword recall works and
semantic search is unavailable. The same flag applies to a plain
`npm install --save-dev @zosmaai/pi-llm-wiki` in your own project.

The clean fix is upstream: qmd's published JavaScript does not need TypeScript
5, so that peer range should be widened or dropped. Until then the flag above is
the supported workaround, and `describeQmdUnavailable()` in
`extensions/llm-wiki/lib/qmd-store.ts` names this cause instead of blaming a
native build.

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