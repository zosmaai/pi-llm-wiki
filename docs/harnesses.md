# Harness Support

`pi-llm-wiki` serves the same wiki engine over two registration surfaces:

1. **Native pi extension** (`extensions/llm-wiki/`) — full surface: 14 tools, 3
   opt-in trajectory tools, slash commands, ambient recall injection,
   background ingest lane, raw/meta edit guardrails.
2. **MCP server** (`dist/mcp/index.js`) — 14 tools over stdio MCP; consumed by
   any MCP-capable harness.

## Matrix

| Harness | How to attach | Limits |
|---|---|---|
| pi | Built-in extension (this repo) | none |
| Claude Code | `claude plugin install .` — bundles the MCP server (`.claude-plugin/`) + PreToolUse guard hook | no automatic context injection; model calls tools on demand |
| Codex | `hosts/codex.config.toml.example` → `~/.codex/config.toml` | background ingest, commands, reminders not available (Phase 2) |
| Cursor | `"mcpServers"` in `.cursor/mcp.json`, command `node`, args `["<abs>/dist/mcp/index.js"]` | same as Codex |
| Windsurf / Zed / opencode / cline | same stdio command in their MCP settings | same as Codex |

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
