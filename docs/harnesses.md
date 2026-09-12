# Harness support

`pi-llm-wiki` has two ways to connect a harness to the same vault:

- **Native extension:** pi and oh-my-pi load the extension, skills, slash commands,
  ambient recall, background tasks, and host-specific guardrails.
- **MCP server:** any MCP-capable client starts `dist/mcp/index.js` over stdio and
  receives the 15 model-free/request-driven wiki tools, including `wiki_ingest`.

## Choose your harness

| Harness | Install / attach | Configuration |
|---|---|---|
| **pi** | `pi install npm:@zosmaai/pi-llm-wiki@latest` | Native extension; `/wiki-init`, `/wiki-ingest`, `/wiki-query`, and all native wiki features. |
| **oh-my-pi** | `omp install @zosmaai/pi-llm-wiki@latest` | Native extension; same `/wiki-*` commands. |
| **Claude Code** | Use the marketplace commands below | Published plugin bundles MCP, raw/meta guardrails, and the project-vault SessionStart notice. |
| **Codex CLI** | `codex mcp add ...` or `~/.codex/config.toml` | `[mcp_servers.llm-wiki]` stdio entry. |
| **Cursor** | `.cursor/mcp.json` or global `~/.cursor/mcp.json` | `mcpServers.llm-wiki` stdio entry. |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.llm-wiki` stdio entry. |
| **Zed** | Settings → AI → MCP Servers, or `settings.json` | `context_servers.llm-wiki` stdio entry. |
| **Cline** | MCP Servers → Configure, or its MCP settings JSON | `mcpServers.llm-wiki` stdio entry. |
| **Other MCP clients** | Add a local stdio server | Use the generic JSON shape below. |

The MCP examples use an installed package. Replace `MCP_SERVER` with the
absolute path to the package entry point:

```text
MCP_SERVER=/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js
WIKI_ROOT=/absolute/path/to/your/wiki
```

Install it locally in the project that owns the MCP configuration:

```bash
npm install --save-dev @zosmaai/pi-llm-wiki@latest
```

Use absolute paths in client configuration. MCP clients spawn commands directly;
`~` is not expanded inside JSON/TOML argument values.

## Native pi and oh-my-pi

```bash
# pi
pi install npm:@zosmaai/pi-llm-wiki@latest

# oh-my-pi
omp install @zosmaai/pi-llm-wiki@latest
```

Then start the host and use:

```text
/wiki-init "AI Engineering"
/wiki-ingest
/wiki-query What are the key patterns?
```

Native hosts also expose the opt-in trajectory tools and slash commands. MCP
clients expose the 15-tool MCP surface instead; trajectory tools remain
intentionally native-only.

## Claude Code

### Marketplace installation

```text
/plugin marketplace add https://github.com/zosmaai/pi-llm-wiki
/plugin install llm-wiki@zosmaai
/reload-plugins
```

The plugin includes:

- the packaged MCP server;
- a PreToolUse guard that blocks direct edits to `.llm-wiki/raw/**` and
  `.llm-wiki/meta/**`;
- a project-vault-only SessionStart notice with page and pending-source counts.

The notice never falls back to the personal vault. Disable it with
`llm-wiki.notices: false` in `.pi/settings.json` or `.omp/settings.json`, or
with `LLM_WIKI_NOTICES=0`.

### Local checkout installation

For development from this repository:

```text
claude plugin install .
```

## OpenAI Codex CLI

The CLI form writes the server to Codex's MCP configuration:

```bash
codex mcp add llm-wiki \
  --env WIKI_ROOT=/absolute/path/to/your/wiki \
  -- node /absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js
```

Or add this to `~/.codex/config.toml` (a trusted repository may use
`.codex/config.toml`):

```toml
[mcp_servers.llm-wiki]
command = "node"
args = ["/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"]
env = { WIKI_ROOT = "/absolute/path/to/your/wiki" }
startup_timeout_sec = 20
tool_timeout_sec = 120
```

A ready-to-copy version is also in
[`hosts/codex.config.toml.example`](../hosts/codex.config.toml.example).

## Cursor

Create `.cursor/mcp.json` in the project, or add the same entry to
`~/.cursor/mcp.json` for a global server:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": {
        "WIKI_ROOT": "/absolute/path/to/your/wiki"
      }
    }
  }
}
```

Restart or reload Cursor after saving the file.

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`, or use the MCP settings UI:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": {
        "WIKI_ROOT": "/absolute/path/to/your/wiki"
      }
    }
  }
}
```

Windsurf supports `${env:NAME}` interpolation if the vault path should come
from the environment rather than the file.

## Zed

Open Settings → AI → MCP Servers → Add Local Server, or add this to Zed's
settings JSON:

```json
{
  "context_servers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": {
        "WIKI_ROOT": "/absolute/path/to/your/wiki"
      }
    }
  }
}
```

## Cline

Open the Cline MCP Servers panel, choose Configure, and add this entry to the
MCP settings JSON:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": {
        "WIKI_ROOT": "/absolute/path/to/your/wiki"
      },
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

Leave `alwaysAllow` empty until the client’s approval policy is understood.

## Generic MCP stdio configuration

Clients that support the standard local-server shape can use:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": {
        "WIKI_ROOT": "/absolute/path/to/your/wiki"
      }
    }
  }
}
```

Some clients call the top-level map `context_servers` instead of `mcpServers`;
use the client-specific example above.

## MCP model and embedding settings

Non-pi clients do not have pi's model registry. For `wiki_ingest`, configure
these settings in the project `.pi/settings.json` or `.omp/settings.json`:

```json
{
  "llm-wiki": {
    "taskModel": { "provider": "openai-compatible", "id": "your-model" },
    "taskModelBaseUrl": "https://api.example.com/v1",
    "taskModelApiKeyEnv": "TASK_MODEL_API_KEY",
    "embeddingProvider": "openai-compatible",
    "embeddingModel": "text-embedding-3-small",
    "embeddingApiKeyEnv": "OPENAI_API_KEY"
  }
}
```

The model lane resolves a per-call `model` override first, then
`taskModel`, then returns self-synthesis instructions if no model is available.
After a successful synthesis commit, only the source/entity/concept pages touched
by that commit are embedded. Embedding failures never roll back page writes;
run `wiki_reindex_embeddings` to repair them.

## Vault location and guardrails

Set `WIKI_ROOT` in the MCP server environment to pin a vault. If omitted, the
server resolves from the client working directory and its ancestors. Do not put
secrets in committed MCP config; use the client’s environment interpolation or
an environment variable.

- pi: raw/meta edits are blocked by the extension hook.
- Claude Code: raw/meta edits are blocked by the packaged PreToolUse hook.
- Other MCP clients: use wiki tools for raw/meta changes; direct-file guardrails
  depend on whether that client supports an equivalent pre-tool hook.

## Build from source

```bash
pnpm install
pnpm build:mcp
node dist/mcp/index.js
```

The server communicates only over stdio. Do not print logs or banners to stdout;
MCP protocol traffic owns that stream.
