<div align="center">

# @zosmaai/pi-llm-wiki

<a href="./README.md">English</a> | <a href="./README.zh.md">中文</a> | **Español** | <a href="./README.ja.md">日本語</a> | <a href="./README.de.md">Deutsch</a> | <a href="./README.fr.md">Français</a> | <a href="./README.pt.md">Português</a> | <a href="./README.ru.md">Русский</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.hi.md">हिंदी</a>

[![CI](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zosmaai/pi-llm-wiki)](https://www.npmjs.com/package/@zosmaai/pi-llm-wiki)
[![npm downloads](https://img.shields.io/npm/dm/@zosmaai/pi-llm-wiki)](https://www.npmjs.com/package/@zosmaai/pi-llm-wiki)
[![Coverage](https://img.shields.io/badge/coverage-85.09%25-brightgreen.svg)](https://codecov.io/gh/zosmaai/pi-llm-wiki)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-online-blue.svg)](https://zosmaai.github.io/pi-llm-wiki/)
[![CodeQL](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/codeql.yml/badge.svg)](https://github.com/zosmaai/pi-llm-wiki/actions/workflows/codeql.yml)
[![GitHub Repo Stars](https://img.shields.io/github/stars/zosmaai/pi-llm-wiki?style=social)](https://github.com/zosmaai/pi-llm-wiki/stargazers)

</div>

<br/>

**Base de conocimiento autogestionable, compatible con Obsidian, para [pi](https://pi.dev).**
Sigue el patrón LLM Wiki de Andrej Karpathy: [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Convierte fuentes sin procesar (URLs, PDFs, Markdown, JSON, XML) en un wiki duradero, interconectado y mantenido por LLM que se acumula con el tiempo.

### Soporte nativo para Open Knowledge Format (OKF) v0.2

Construye una base de conocimiento que puedes llevar contigo — no otra exportación cerrada y específica de una aplicación:

- **Crea documentos portátiles OKF v0.2** con frontmatter canónico, enlaces Markdown estándar y citas de fuentes estables.
- **Lee tanto páginas legacy como OKF** para que los vaults existentes sigan funcionando sin migración automática ni reescritura.
- **Genera índices y registros deterministas** desde páginas autoritativas, manteniendo la navegación y los metadatos reproducibles.
- **Usa el mismo modelo de conocimiento desde Pi o MCP** con Claude Code, Cursor, Windsurf y otros clientes MCP.
- **Mantente compatible con Obsidian** mientras mantienes tu conocimiento listo para herramientas que soporten Open Knowledge Format.

Comienza con un nuevo vault OKF, o apunta pi-llm-wiki a un vault existente y adopta el formato a tu ritmo. Consulta la [especificación OKF Foundation](docs/superpowers/specs/2026-08-02-okf-foundation-design.md) para detalles de implementación.

---

## Demo

<div align="center">
  <img src="./assets/demo.gif" alt="pi-llm-wiki demo" width="1920" />
</div>

---

## Quick Start

**pi** ([`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono)):

```bash
pi install npm:@zosmaai/pi-llm-wiki
```

**oh-my-pi** ([`omp`](https://github.com/can1357/oh-my-pi)):

```bash
omp install @zosmaai/pi-llm-wiki
```

Both hosts load the same extension, skill, and `/wiki-*` slash commands — see
[Dual-host support](#dual-host-support-pi--oh-my-pi) for what differs.

### Other harnesses via MCP

Claude Code, Codex, Cursor, Windsurf, Zed, Cline, and other MCP-capable
harnesses use the packaged stdio server. Start with the Claude marketplace:

```text
/plugin marketplace add https://github.com/zosmaai/pi-llm-wiki
/plugin install llm-wiki@zosmaai
/reload-plugins
```

For every other MCP client, install the package and register
`dist/mcp/index.js` as a local stdio server:

```bash
npm install --save-dev @zosmaai/pi-llm-wiki@latest
```

Use the client-specific JSON/TOML examples in
[`docs/harnesses.md`](docs/harnesses.md). They cover Codex CLI, Cursor,
Windsurf, Zed, Cline, and a generic MCP configuration. Set `WIKI_ROOT` to pin
the vault; use an absolute server path because MCP clients do not expand `~`.

The extension will proactively suggest creating a wiki on your first session. Alternatively:

```
/wiki-init "AI Engineering"
/wiki-ingest
/wiki-query What are the key patterns?
```

---

## ¿Por qué este paquete?

La mayoría de los flujos de trabajo basados en archivos con LLM se comportan como RAG de un solo tiro: el modelo busca documentos sin procesar cada vez que haces una pregunta. La síntesis es efímera.

**pi-llm-wiki** crea una capa intermedia:

- **Paquetes de fuentes crudas** preservan las entradas de origen de verdad
- **Páginas de fuentes** resumen lo que cada fuente dice
- **Páginas canónicas del wiki** rastrean lo que el wiki actualmente cree
- **Metadatos generados** mantienen todo buscable y navegable

El resultado es un wiki que **se acumula** mientras capturas fuentes, haces preguntas y archivas análisis duraderos.

---

## Características

| Capacidad | Descripción |
|-----------|-------------|
| 🏠 **Fallback personal** | Vault siempre activo en `~/.llm-wiki/` — el conocimiento se acumula entre proyectos incluso cuando no existe un wiki del proyecto |
| 🔗 **Captura de fuentes inmutable** | URLs, archivos locales (PDF/md/txt/html/XML/JSON) o texto pegado → paquetes de fuentes estructurados |
| 🧠 **Ingesta automatizada** | `wiki_ingest` procesa por lotes fuentes en páginas de conceptos, entidades, síntesis y análisis |
| 🔍 **Búsqueda de texto completo** | Registro generado con búsqueda por palabras clave en todas las páginas y fuentes |
| 🩺 **Linting mecánico** | Huérfanos, enlaces rotos, alias duplicados, lagunas de cobertura, capturas obsoletas |
| 📊 **Panel de control** | `wiki_status` — conteos, estados de fuentes, actividad reciente |
| 🤖 **Vigilancia de auto-actualización** | `wiki_watch` — imprime una línea `crontab` que ejecuta el ciclo completo según un horario |
| 🧠 **Recuerdo en capas** | Busca tanto en vaults personales (`~/.llm-wiki/`) como del proyecto (`.llm-wiki/`) — el conocimiento personal te sigue a todas partes |
| 📝 **Auto-inicialización** | La extensión sugiere crear un wiki cuando no existe ninguno en el directorio actual |
| 💾 **Captura ligera** | `wiki_retro` — guarda ideas atómicas como un solo archivo Markdown; también disponible el pipeline completo de 4 capas vía `wiki_capture_source` |
| 🧭 **Memoria de trabajo del agente** _(opcional)_ | `wiki_capture_trajectory` registra *cómo* se resolvió una tarea (trayectoria de llamadas de herramientas) → destila en páginas reutilizables de `skill`/`case` → `wiki_recall_skill` las muestra la próxima vez. Desactivado por defecto; activa con `/wiki-trajectories on` |
| 🌐 **OKF v0.2 nativo** | Documentos portátiles Open Knowledge Format, compatibilidad dual de lectura legacy, proyecciones deterministas |
| 🌐 **Servidor MCP** | Usa el mismo wiki consciente de OKF desde Claude Code, Cursor, Windsurf vía transporte MCP por stdio |
| 📝 **Amigable con Obsidian** | Wikilinks calificados por carpeta, citas estables de ID de fuente, vault compatible |
| 🛡️ **Barreras de seguridad** | Bloquea ediciones directas a fuentes crudas y metadatos generados |
| 🔧 **Extracción de PDF configurable** | Timeout de MarkItDown vía variable de entorno `WIKI_MARKITDOWN_TIMEOUT_MS` |
| 🧪 **Quality checks** | TypeScript, Vitest, Biome, Codecov, CodeQL |

---

## Herramientas

| Herramienta | Descripción |
|-------------|-------------|
| `wiki_bootstrap` | Inicializa un nuevo vault de wiki con configuración, plantillas, esquema y metadatos |
| `wiki_capture_source` | Captura una URL, archivo local o texto pegado en un paquete de fuente inmutable |
| `wiki_recall` | Busca en el wiki páginas relevantes para la tarea — busca en vaults personales y del proyecto, deduplicadas |
| `wiki_retro` | Guarda ideas atómicas de tareas completadas en el wiki |
| `wiki_ingest` | Procesa paquetes de fuentes no ingeridos en páginas del wiki (por lotes) |
| `wiki_ensure_page` | Resuelve o crea de forma segura páginas de entidad / concepto / síntesis / análisis |
| `wiki_search` | Busca en el registro generado del wiki |
| `wiki_lint` | Comprobaciones de salud deterministas (huérfanos, lagunas, contradicciones, auto-reparación) |
| `wiki_status` | Muestra conteos, estados de fuentes y actividad reciente |
| `wiki_observe` | Registra observaciones de la sesión actual con marca de tiempo y buscables |
| `wiki_rebuild_meta` | Fuerza una reconstrucción completa de metadatos (registro, backlinks, índice, registro) |
| `wiki_reindex_embeddings` | Refresca los embeddings semánticos de páginas nuevas o desactualizadas (no hace nada sin proveedor de embeddings) |
| `wiki_log_event` | Adjunta un evento estructurado al registro de actividad del wiki |
| `wiki_watch` | Imprime una línea `crontab` para actualizaciones automáticas del wiki (diaria / semanal / horaria) — no la instala |
| `wiki_capture_trajectory` _(opcional)_ | Captura la trayectoria de llamadas de herramientas de la tarea completada (memoria de trabajo del agente) |
| `wiki_distill_skills` _(opcional)_ | Procesa por lotes trayectorias no destiladas para síntesis en páginas de habilidades reutilizables |
| `wiki_recall_skill` _(opcional)_ | Recuerda habilidades destiladas + casos similares pasados — "¿he hecho esto antes?" |

> Las tres herramientas de trayectoria del agente están **desactivadas por defecto** (issue #80). Actívalas con `/wiki-trajectories on` (establece `llm-wiki.trajectories`); cuando están apagadas no se registran en absoluto.

### Comandos de Barra

| Comando | Descripción |
|---------|-------------|
| `/wiki-init <topic>` | Inicializa un nuevo vault LLM Wiki |
| `/wiki-ingest [path]` | Procesa nuevos archivos de fuente y actualiza el wiki |
| `/wiki-query <question>` | Haz preguntas al wiki con citas |
| `/wiki-discover [--topic <topic>]` | Descubre automáticamente nuevas fuentes de la web |
| `/wiki-run [--schedule daily\|weekly]` | Ciclo completo: descubrir → ingerir → lint |
| `/wiki-lint [--fix]` | Comprobación de salud (huérfanos, contradicciones, lagunas) |
| `/wiki-status` | Muestra un resumen operativo conciso |
| `/wiki-digest [--period daily\|weekly]` | Genera un resumen de actividad reciente |
| `/wiki-retro` | Guarda ideas atómicas de tareas completadas |
| `/wiki-model [provider/id | session]` | Fija el modelo de las tareas en segundo plano (sin argumento: selector interactivo) |
| `/wiki-req <concept>` | Descompone un concepto en páginas de requisitos atómicas y rastreables |
| `/wiki-trajectories <on\|off>` | Activa/desactiva la memoria de trabajo del agente (opcional, desactivada por defecto) |
| `/wiki-record <title>` | Captura la trayectoria de la tarea completada (requiere trayectorias activadas) |
| `/wiki-skills [query]` | Busca habilidades destiladas + casos pasados (requiere trayectorias activadas) |
| `/wiki-settings` | Pantalla interactiva de ajustes — ver/cambiar todos los ajustes `llm-wiki` en alcance de proyecto o global |
| `/wiki-dashboard` | Panel de solo lectura del vault — páginas por tipo, frescura, actividad de 7 días, cola de ingestión, páginas sin backlinks, cobertura de embeddings |

<img src="./assets/wiki-dashboard.png" alt="wiki-dashboard: panel del vault" width="100%" />


---

## Layered Vault Architecture

Knowledge follows you everywhere. pi-llm-wiki uses a layered vault system:

| Layer | Location | Purpose |
|-------|----------|---------|
| 🏠 **Personal** | `~/.llm-wiki/` | Always active. Zero setup. Knowledge compounds across all your sessions — regardless of which project you're in. |
| 📁 **Project** | `{project}/.llm-wiki/` | Explicit opt-in. Dedicated wiki per project, sharing personal knowledge when relevant. |
| 🏢 **Company** (future) | git-tracked | Shared wiki across a team. `wiki_publish` promotes personal/project pages to the company wiki. |

**How it works:**

1. `resolveVaultRoot()` checks: cwd → walk up for `.llm-wiki/` → `~/.llm-wiki/`
2. `wiki_recall` (layered) searches **both** personal and project vaults, merging results with vault labels
3. Personal results are shown first in recall output, tagged as "📓 personal"
4. `wiki_retro` writes to whichever vault is active (project takes priority)
5. Set `WIKI_HOME` env var to override the personal wiki location

This means: you can have a project wiki for team documentation **and** a personal wiki for your own notes, and recall searches both simultaneously.

---

## Quick Start (Detailed)

### 1) Create a new wiki

```bash
mkdir my-wiki
cd my-wiki
pi
```

Ask pi:

```
Initialize an llm wiki here for AI research.
```

This calls `wiki_bootstrap` and creates:

```
.llm-wiki/
├── config.json
├── templates/
├── raw/
├── wiki/
├── meta/
└── WIKI_SCHEMA.md
```

### 2) Capture a source

```
Capture this article into the wiki: https://example.com/some-article
```

```
Capture this PDF into the wiki: ./papers/context-windows.pdf
```

```
Capture these notes into the wiki: ...pasted text...
```

### 3) Integrate the source

1. Capture the source
2. Read `.llm-wiki/wiki/sources/SRC-*.md`
3. Update that source page
4. Search for impacted canonical pages with `wiki_search`
5. Create missing pages with `wiki_ensure_page`
6. Update concept / entity / synthesis pages with citations
7. Mark the integration with `wiki_log_event kind=integrate`

### 4) Query the wiki

```
Based on the wiki, what are the main tradeoffs between long-context models and RAG?
```

By default, query mode is **read-only**. To file a durable answer:

```
Answer the question and file the result as an analysis page.
```

---

## Vault Layout

```
my-wiki/
└─ .llm-wiki/
   ├─ config.json               # Vault config
   ├─ templates/                 # Page templates
   ├─ raw/
   │  └─ sources/
   │     └─ SRC-2026-05-11-001/
   │        ├─ manifest.json
   │        ├─ original/           # Original artifact
   │        ├─ extracted.md        # Normalized text
   │        └─ attachments/
   ├─ wiki/
   │  ├─ sources/                  # Source pages (what each source says)
   │  ├─ concepts/                 # Concepts and recurring ideas
   │  ├─ entities/                 # People, orgs, products, papers, systems
   │  ├─ syntheses/                # Cross-source theses and tensions
   │  └─ analyses/                 # Durable filed answers from queries
   ├─ meta/
   │  ├─ registry.json             # Auto-generated search index
   │  ├─ backlinks.json
   │  ├─ index.md
   │  ├─ events.jsonl              # Append-only event log
   │  ├─ log.md
   │  └─ lint-report.md
   └─ WIKI_SCHEMA.md               # Operating manual
```

### Ownership Model

| Path | Owner | Rule |
|------|-------|------|
| Path | Owner | Rule |
|------|-------|------|
| `.llm-wiki/raw/**` | Extension tools | Immutable after capture |
| `.llm-wiki/wiki/**` | Model + user | Editable knowledge pages |
| `.llm-wiki/meta/registry.json` | Extension | Generated |
| `.llm-wiki/meta/backlinks.json` | Extension | Generated |
| `.llm-wiki/meta/index.md` | Extension | Generated |
| `.llm-wiki/meta/events.jsonl` | Extension / tool | Authoritative append-only state; back up for activity continuity |
| `.llm-wiki/meta/log.md` | Extension | Generated from events |
| `.llm-wiki/meta/lint-report.md` | Extension | Generated |
| `.llm-wiki/WIKI_SCHEMA.md` | Human + explicit request | Operating manual |

### Activity history, backup, and portability

`meta/events.jsonl` is the authoritative source for recorded extension activity. Unlike registry, backlinks, indexes, logs, and embeddings, it cannot be rebuilt from wiki pages or raw packets. Preserve it when backing up or Git-synchronizing a complete pi-llm-wiki vault.

`meta/log.md` and OKF-mode `wiki/log.md` are generated views. `wiki/log.md` can travel with the OKF bundle as a readable snapshot, but it cannot reconstruct or resume the originating JSONL stream. Manual page edits are intentionally absent, so this is selected extension activity rather than a complete revision audit.

File-capture events omit machine-local paths from the public log projection. Callers of `wiki_log_event` still control arbitrary detail fields and must not record secrets or private host paths.

---

## Linking & Citation Style

### Internal Navigation

```markdown
[[concepts/retrieval-augmented-generation]]
[[entities/openai|OpenAI]]
[[syntheses/long-context-vs-rag]]
```

### Factual Citations

```markdown
[[sources/SRC-2026-04-04-001|SRC-2026-04-04-001]]
```

Stable source-page IDs keep provenance stable even if titles change.

---

## Guardrails

The extension **blocks** direct tool-call edits to:

- `.llm-wiki/raw/**` — immutable source artifacts
- `.llm-wiki/meta/registry.json`
- `.llm-wiki/meta/backlinks.json`
- `.llm-wiki/meta/events.jsonl`
- `.llm-wiki/meta/index.md`
- `.llm-wiki/meta/log.md`
- `.llm-wiki/meta/lint-report.md`

If the model directly edits `.llm-wiki/wiki/**` using Pi's built-in `write` or `edit` tools, the extension **automatically rebuilds** generated metadata at the end of the agent turn.

---

## Source Packet Format

Each captured source is stored as a structured packet:

```
.llm-wiki/raw/sources/SRC-YYYY-MM-DD-NNN/
├─ manifest.json     # Capture metadata (title, URL, format, timestamp)
├─ original/         # Original artifact (preserved as-is)
├─ extracted.md      # Normalized text (PDF→md, XML→md, JSON→md, etc.)
└─ attachments/      # Future attachment downloads
```

This preserves both the **original artifact** and a **normalized extracted view** for reading.

---

## MCP Server

Use the wiki from **any MCP-compatible tool** — Claude Code, Cursor, Windsurf, and others.

The package ships a standalone MCP server exposing 15 wiki tools over stdio:

| Tool | Description |
|------|-------------|
| `wiki_bootstrap` | Initialize a vault |
| `wiki_recall` | Search relevant wiki pages |
| `wiki_search` | Search the registry |
| `wiki_status` | Show wiki health and counts |
| `wiki_retro` | Save an atomic insight |
| `wiki_capture_source` | Capture a source packet |
| `wiki_ingest` | Synthesize captured sources synchronously over the configured task model |
| `wiki_reindex` | Rebuild/repair QMD indexes |
| `wiki_ensure_page` | Safely create a canonical page |
| `wiki_lint` | Run deterministic health checks |
| `wiki_log_event` | Append an activity event |
| `wiki_observe` | Save a timestamped observation |
| `wiki_rebuild_meta` | Rebuild metadata projections |
| `wiki_reindex_embeddings` | Refresh semantic embeddings |
| `wiki_watch` | Print an update cron line |

### Usage

```bash
# Auto-discovered by pi:
pi install npm:@zosmaai/pi-llm-wiki

# Standalone with any MCP client:
WIKI_ROOT=~/my-wiki node node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js
```

Set `WIKI_ROOT` to your wiki vault directory. If unset, the server auto-detects from the current working directory.

### Claude marketplace installation

```text
/plugin marketplace add https://github.com/zosmaai/pi-llm-wiki
/plugin install llm-wiki@zosmaai
/reload-plugins
```

### Client configuration

The same server as an entry in `.mcp.json` (Claude Code) or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": { "WIKI_ROOT": "/absolute/path/to/my-wiki" }
    }
  }
}
```

> MCP clients spawn the command **without a shell**, so `~` is never expanded. A `~/my-wiki` in `args` or `env` is passed through literally and the server fails to start, which the client reports only as a generic connection error — use absolute paths here. The shell snippet above is fine: your shell expands `~` before `node` sees it.

---

## Dual-host support (pi + oh-my-pi)

The package targets two hosts from a single codebase:

| | **pi** (`@mariozechner/pi-coding-agent`) | **oh-my-pi** (`omp`) |
|---|---|---|
| Extension entry | `package.json#pi.extensions` | `package.json#omp.extensions` (falls back to `#pi`) |
| Skill | `skills/llm-wiki/SKILL.md` via `pi.skills` | same file, found by directory convention |
| Slash commands | `prompts/*.md` via `pi.prompts` | `commands/*.md` (generated mirror of `prompts/`) |
| Project config | `<cwd>/.pi/settings.json` | `<cwd>/.omp/settings.json`, then `.omp/config.yml` |
| User config | `~/.pi/agent/settings.json` | `~/.omp/agent/settings.json`, then `config.yml` |
| MCP server | auto-registered via `pi.mcpservers` | register manually (see below) |
| Ambient surfaces without a project wiki | on (personal vault) | off — see below |

No source changes are needed for the imports: oh-my-pi rewrites
`@mariozechner/pi-*` and bare `typebox` specifiers onto its own bundled
packages when it loads a legacy extension.

**Settings are read from both layouts.** `llm-wiki` config is merged from every
file above, host-native directory last. A vault configured under pi keeps
working after `omp` takes over the same repository, and writes land in whichever
config directory already exists (so a `.pi`-only repo does not sprout a second
settings file). Writes are always JSON — a hand-authored `config.yml` is read
but never rewritten.

Set `LLM_WIKI_HOST=pi|omp` to override host detection; by default it is derived
from the resolved agent directory.

**Ambient surfaces are gated under oh-my-pi.** The session notice, the periodic
observe/retro reminder, and `before_agent_start` recall all fire unprompted, and
vault resolution falls back to the personal vault — so once `~/.llm-wiki/`
exists they would speak up in *every* directory. Under pi that is the historical
behaviour and it is kept; under omp the plugin is installed once and loads in
every project, so a repository that never ran `/wiki-init` stays quiet. Override
either default with `llm-wiki.ambientPersonalVault`. The wiki tools and slash
commands are registered regardless, so `/wiki-init` always works — and a project
with its own `.llm-wiki/` gets every surface back.

**MCP under oh-my-pi.** `pi.mcpservers` is a pi-only manifest key, and the
server's vault auto-detection depends on the client's working directory, so it
cannot be declared with a relative path. Register it explicitly instead:

```jsonc
// <cwd>/.omp/.mcp.json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/abs/path/to/node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js"],
      "env": { "WIKI_ROOT": "/abs/path/to/your/wiki" }
    }
  }
}
```

You rarely need it: under either host the extension already registers the same
capabilities as native tools.

---

## Skill Behavior

The bundled `llm-wiki` skill teaches the model to:

- ❌ Never edit raw sources directly
- ❌ Never edit generated metadata files
- ✅ Capture first, integrate second
- ✅ Search before creating new canonical pages
- ✅ Cite facts using source-page IDs
- ✅ Keep query mode read-only by default
- ✅ Use "Tensions / caveats" and "Open questions" when evidence is mixed

---

## Architecture

### Vault Layers

See the [Layered Vault Architecture](#layered-vault-architecture) section above for the personal/project/company layering.

### Four-Layer Page Model

Each wiki vault has four layers with clear ownership:

```
.llm-wiki/raw/sources/SRC-*/     # Immutable source packets (extension-owned)
.llm-wiki/wiki/                   # Editable knowledge pages (you + LLM)
.llm-wiki/meta/                   # Durable event source + generated internal projections
.llm-wiki/                        # Config and templates
```

Read [docs/architecture.md](docs/architecture.md) for the full design document.

---

## Documentation

| Document | What it covers |
|----------|---------------|
| [Architecture](docs/architecture.md) | How the four layers work, ownership model |
| [Commands](docs/commands.md) | All slash commands and tool reference |
| [Obsidian Integration](docs/obsidian.md) | Vault setup and recommended plugins |
| [Configuration](docs/configuration.md) | Wiki modes, topics, environment variables |
| [API](docs/api.md) | Extension tool parameter reference |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, test patterns, and PR workflow.

---

<div align="center">
  <a href="https://github.com/zosmaai/pi-llm-wiki/stargazers">
    <img src="./assets/thank-you-for-the-star.png" alt="Thank you for starring pi-llm-wiki!" width="100%" />
  </a>
  <br/>
  <sub>
    If you find pi-llm-wiki useful,
    <a href="https://github.com/zosmaai/pi-llm-wiki">⭐ star the repo</a> —
    it lets us know we're building something that matters.
  </sub>
</div>

<br/>

## Contributors

Thanks to everyone who has contributed! This list is regenerated automatically by [`.github/workflows/contributors.yml`](.github/workflows/contributors.yml) — see [#60](https://github.com/zosmaai/pi-llm-wiki/issues/60) for the rationale.

<!-- readme: contributors -start -->
<table>
	<tbody>
		<tr>
            <td align="center">
                <a href="https://github.com/arjun-zosma">
                    <img src="https://avatars.githubusercontent.com/u/25246034?v=4" width="64;" alt="arjun-zosma"/>
                    <br />
                    <sub><b>Arjun Nayak</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/Shanvit7">
                    <img src="https://avatars.githubusercontent.com/u/64424817?v=4" width="64;" alt="Shanvit7"/>
                    <br />
                    <sub><b>Shanvit S Shetty</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/jfraser">
                    <img src="https://avatars.githubusercontent.com/u/165964?v=4" width="64;" alt="jfraser"/>
                    <br />
                    <sub><b>James Fraser</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/mkuhl">
                    <img src="https://avatars.githubusercontent.com/u/61073?v=4" width="64;" alt="mkuhl"/>
                    <br />
                    <sub><b>Mike P. Kuhl</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/CelestialCreator">
                    <img src="https://avatars.githubusercontent.com/u/177931942?v=4" width="64;" alt="CelestialCreator"/>
                    <br />
                    <sub><b>Akshay</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/prestalab">
                    <img src="https://avatars.githubusercontent.com/u/2825421?v=4" width="64;" alt="prestalab"/>
                    <br />
                    <sub><b>PrestaLab</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/wooksong">
                    <img src="https://avatars.githubusercontent.com/u/2772376?v=4" width="64;" alt="wooksong"/>
                    <br />
                    <sub><b>wooksong</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/xcsf">
                    <img src="https://avatars.githubusercontent.com/u/43439835?v=4" width="64;" alt="xcsf"/>
                    <br />
                    <sub><b>xcsf</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/danielnaab">
                    <img src="https://avatars.githubusercontent.com/u/136512?v=4" width="64;" alt="danielnaab"/>
                    <br />
                    <sub><b>Daniel Naab</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/mdmayfield">
                    <img src="https://avatars.githubusercontent.com/u/26154258?v=4" width="64;" alt="mdmayfield"/>
                    <br />
                    <sub><b>Matt Mayfield</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/deestax">
                    <img src="https://avatars.githubusercontent.com/u/152369481?v=4" width="64;" alt="deestax"/>
                    <br />
                    <sub><b>Superdao</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/mystery4f">
                    <img src="https://avatars.githubusercontent.com/u/40482524?v=4" width="64;" alt="mystery4f"/>
                    <br />
                    <sub><b>标准萌新</b></sub>
                </a>
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

<sub>Full history: [contributors graph](https://github.com/zosmaai/pi-llm-wiki/graphs/contributors).</sub>

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://github.com/zosmaai">zosmaai</a> · </sub>
  <a href="https://pi.dev">pi.dev</a> · <a href="https://github.com/zosmaai/pi-llm-wiki/issues">Issues</a>
</div>

## License

MIT

## Harness support

Runs natively in pi, and as an MCP server in Claude Code (plugin), Codex,
Cursor, Windsurf, Zed and opencode. See [docs/harnesses.md](docs/harnesses.md).
