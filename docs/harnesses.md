# Harness Support

`pi-llm-wiki` serves the same wiki engine over two registration surfaces:

1. **Native pi extension** (`extensions/llm-wiki/`) — full surface: 14 tools, 3
   opt-in trajectory tools, slash commands, ambient recall injection,
   background ingest lane, raw/meta edit guardrails.
2. **MCP server** (`dist/mcp/index.js`) — 15 tools over stdio MCP; consumed by
   any MCP-capable harness.

## Matrix

| Harness | How to attach | Limits |
|---|---|---|
| pi | Built-in extension (this repo) | none |
| Claude Code | `claude plugin install .` — bundles the MCP server (`.claude-plugin/`) + PreToolUse guard hook | no automatic context injection; model calls tools on demand |
| Codex | `hosts/codex.config.toml.example` → `~/.codex/config.toml` | `wiki_ingest` runs synchronously over the configured `llm-wiki.taskModel*` settings; no background reporting |
| Cursor | `"mcpServers"` in `.cursor/mcp.json`, command `node`, args `["<abs>/dist/mcp/index.js"]` | `wiki_ingest` runs synchronously over the configured `llm-wiki.taskModel*` settings; no background reporting |
| Windsurf / Zed / opencode / cline | same stdio command in their MCP settings | `wiki_ingest` runs synchronously over the configured `llm-wiki.taskModel*` settings; no background reporting |

## Architecture

### Model lane (wiki_ingest)

Non-pi hosts have no pi model registry. The MCP server reads
`llm-wiki.taskModel` plus the optional `taskModelBaseUrl` / `taskModelApiKey`
/ `taskModelApiKeyEnv` settings (same shape as the embedding* fields) and
resolves a model through the SAME precedence as pi
(`lib/runtime.ts::resolveModel`): per-call override → taskModel → none. When
nothing resolves, `wiki_ingest` returns the extracted content so the calling
agent can synthesize the pages itself.

## Guardrails across hosts

- pi: enforced at the tool_call hook.
- Claude Code: PreToolUse hook (`scripts/guard-llm-wiki-edit.mjs`) denies
  Write/Edit on `.llm-wiki/raw/**` and `.llm-wiki/meta/**`.
- Other hosts: rely on the model using wiki tools; direct edits are NOT blocked
  (add their equivalent pre-tool hook if the harness supports one).

## Building

```bash
pnpm build:mcp   # -> dist/mcp/index.js  (also runs on `pnpm prepack`)
```

The server is a single ESM script: `node dist/mcp/index.js`. Set `WIKI_ROOT`
to pin the vault, otherwise it resolves like the pi extension (cwd → parent →
`~/.llm-wiki`).
