# Dependency Security

A clean install of `@zosmaai/pi-llm-wiki` on npm 12 can print two blocks that look
alarming and are not caused by this package: a vulnerability summary from
`npm audit`, and an `install-scripts` warning that native build steps were
skipped. This page explains what each one means and gives the commands that
resolve it. Issue #321 tracks both.

## The short version

- The audit findings come from the transitive tree of the optional
  `@tobilu/qmd` dependency, plus the `undici` pin inside the pi host. Pin patched
  versions in **your** `package.json` with an `overrides` block, then reinstall
  from scratch. The exact block is below, and this repository ships a working
  copy of such a project at `test/fixtures/consumer-audit/package.json`.
- The `install-scripts` warning is npm 12 defaulting dependency lifecycle
  scripts to deny. Approve the six packages it names, then `npm rebuild`.
- Do not run `npm audit fix --force`. It is not a fix here, and it will quietly
  downgrade this package.

## 1. Vulnerable transitive dependencies

A clean `npm install @zosmaai/pi-llm-wiki` resolves 320 packages and reports
9 vulnerabilities (1 moderate, 6 high, 2 critical):

| Package | Severity | Why it appears in your graph | Patched in |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server@2.0.0` | high, 4 advisories | `@tobilu/qmd` pins it exact | 2.3.0+ |
| `zod@4.2.1` | high (GHSA-mrhx-c7xc-m3w5) | `@tobilu/qmd` pins it exact | 4.6.6+ |
| `@simple-git/argv-parser@1.1.1` | critical (GHSA-v5rq-49vh-5v5c) | `@tobilu/qmd` via `node-llama-cpp@3.20.0` via `simple-git@3.36.0` | 2.0.1 |
| `simple-git@3.36.0` | critical (GHSA-x6jw-m9v5-85vh, GHSA-g4wm-2vf7-vfgr, GHSA-858h-whjf-mvg5) | same path | 4.0.1+ |
| `undici@8.10.2` | high, 7 advisories, including TLS certificate validation bypass GHSA-2m5v-pch6-74hx | `@earendil-works/pi-coding-agent@1.4.0` pins it exact | 8.12.2+ |

Add this to your `package.json`. npm honours `overrides` only from the root
package, so we cannot apply it for you from inside our published manifest:

```json
{
  "name": "pi-llm-wiki-consumer-audit",
  "private": true,
  "overrides": {
    "undici": "8.12.3",
    "zod": "^4.6.7",
    "@modelcontextprotocol/server": "2.4.0",
    "simple-git": "4.0.2",
    "@simple-git/argv-parser": "2.0.1"
  }
}
```

`pi-llm-wiki-consumer-audit` is the fixture name used by this repository's CI;
keep your own `name` and paste the `overrides` block into your manifest.

Then reinstall from scratch and audit:

```bash
rm -rf node_modules package-lock.json
npm install
npm audit --audit-level=high
```

Expected result: `found 0 vulnerabilities`. This is the exact install the
`consumer-audit` job in `.github/workflows/security.yml` runs on every push and
pull request, so the block above is tested, not folklore. This repository
carries the same map as `pnpm.overrides`, which is what makes
`pnpm audit --prod --audit-level=high` clean here.

### Four things that will bite you

1. **Do not run `npm audit fix --force`.** Its chosen remedy is to downgrade
   `@zosmaai/pi-llm-wiki` to 0.12.2, which pulls the older `@tobilu/qmd` 2.5.3
   and loses the retrieval work since that release. It "resolves" the advisories
   by taking you to an unsupported version.
2. **Overrides only take effect on a clean reinstall.** An incremental
   `npm install` over an existing tree leaves a stale nested copy that npm marks
   `invalid: "2.4.0"`, and `npm audit` keeps reporting the old version. Delete
   `node_modules` and `package-lock.json` as shown above.
3. **`--omit=optional` does not silence the audit.** `npm audit` resolves from
   registry metadata, so `--omit=optional` removes `@tobilu/qmd` from
   `node_modules` while the advisories it brings still appear in the output.
   Use `overrides`, not `--omit`, to change what audit reports.
4. **`simple-git` 4.x replaces the `^3.36.0` that `node-llama-cpp` declares.**
   The override is a major-version jump through a dependency you did not choose.
   `node-llama-cpp` uses `simple-git` only to check model files out of a git
   repository, so the jump is expected to be safe, but it is **not
   runtime-tested**: nothing in this repository's CI downloads a model, so the
   `node-llama-cpp` checkout path against `simple-git` 4.0.2 is unverified.
   If a model download fails for you, that is the first suspect.

## 2. Blocked install scripts

npm 12 changed dependency lifecycle scripts to default-deny (npm RFC 868,
npm/cli commit `5cd5150`). A `pi install npm:@zosmaai/pi-llm-wiki` therefore
warns that 6 packages have install scripts not yet covered by `allowScripts`:

```text
node-llama-cpp@3.20.0        postinstall: node ./dist/cli/cli.js postinstall
tree-sitter-go@0.25.0        install: node-gyp-build
tree-sitter-python@0.25.0    install: node-gyp-build
tree-sitter-rust@0.24.0      install: node-gyp-build
tree-sitter-typescript@0.23.2 install: node-gyp-build
tree-sitter-javascript@0.23.1 install: node-gyp-build
```

All six are inside the optional `@tobilu/qmd` subtree, and all six are ordinary
native builds rather than fetched code, so this warning is a prompt to make a
deliberate choice rather than a signal of trouble.

Preview what is pending, then approve exactly those six and rebuild:

```bash
npm install-scripts ls
npm install-scripts approve node-llama-cpp tree-sitter-go tree-sitter-python tree-sitter-rust tree-sitter-typescript tree-sitter-javascript
npm rebuild
```

`npm install-scripts approve --all` is the blanket form. Prefer the named form so
a future dependency cannot inherit your approval by accident.

### What stays degraded if you leave the scripts blocked

`node-llama-cpp`'s postinstall builds the llama.cpp binary that produces
embeddings, and the tree-sitter grammars provide code-aware chunking. With the
scripts blocked, `@tobilu/qmd` installs but has no embeddings and no tree-sitter
chunking, so llm-wiki silently falls back to lexical-only recall: `wiki_reindex`
keeps its `lexical` component, `vectors` never gets content, and search quality
drops without any error to tell you. See [QMD Compatibility](qmd-compatibility.md)
for what the QMD index does and which parts need a model.

## Upstream constraints

The versions above are not lazily pinned by us. `@tobilu/qmd` declares its
dependencies at exact versions (`@modelcontextprotocol/server` 2.0.0, `zod`
4.2.1, `node-llama-cpp` 3.20.0), and `2.8.3` is the latest release, so a
consumer has nothing newer to move to inside qmd. `@earendil-works/pi-coding-agent`
1.4.0 pins `undici` exactly at `8.10.2`, which is vulnerable through `8.12.1`.
Until those upstream packages widen their ranges or move, an `overrides` block in
the consuming project is the only mechanism that reaches these advisories, which
is why it is documented here and asserted in CI rather than left to a lockfile
update.

## Real exposure, triaged

Not every advisory is equally reachable in the default configuration:

- The `@modelcontextprotocol/server` advisories are HTTP-transport specific
  (cross-client leakage, bearer-token handling). This package's MCP server runs
  as a local stdio process (`dist/mcp/index.js`), so those entries are not
  reachable in the default configuration.
- The `simple-git` and `@simple-git/argv-parser` advisories are command
  execution through unsafe git configuration, reachable only through
  `node-llama-cpp` checking out model files from an untrusted repository URL.
- `undici` is the operational one. The pi host uses it for outbound LLM traffic,
  so the TLS certificate validation bypass (GHSA-2m5v-pch6-74hx) and the cache
  poisoning entries affect real requests. If you only fix one, fix `undici`.
