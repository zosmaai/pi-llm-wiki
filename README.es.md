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

## Inicio Rápido

```bash
pi install npm:@zosmaai/pi-llm-wiki
```

La extensión sugerirá proactivamente crear un wiki en tu primera sesión. Alternativamente:

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
| 🧪 **562 pruebas, 85.09% de cobertura** | TypeScript, Vitest, Biome, Codecov, CodeQL |

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

## Arquitectura de Vault en Capas

El conocimiento te sigue a todas partes. pi-llm-wiki usa un sistema de vault en capas:

| Capa | Ubicación | Propósito |
|------|-----------|-----------|
| 🏠 **Personal** | `~/.llm-wiki/` | Siempre activo. Configuración cero. El conocimiento se acumula en todas tus sesiones — independientemente del proyecto en el que estés. |
| 📁 **Proyecto** | `{project}/.llm-wiki/` | Opt-in explícito. Wiki dedicado por proyecto, compartiendo conocimiento personal cuando es relevante. |
| 🏢 **Empresa** (futuro) | rastreado por git | Wiki compartido entre un equipo. `wiki_publish` promueve páginas personales/de proyecto al wiki de la empresa. |

**Cómo funciona:**

1. `resolveVaultRoot()` verifica: cwd → subir buscando `.llm-wiki/` → `~/.llm-wiki/`
2. `wiki_recall` (en capas) busca en **ambos** vaults personal y del proyecto, fusionando resultados con etiquetas de vault
3. Los resultados personales se muestran primero en la salida de recall, etiquetados como "📓 personal"
4. `wiki_retro` escribe en el vault que esté activo (el proyecto tiene prioridad)
5. Establece la variable de entorno `WIKI_HOME` para sobrescribir la ubicación del wiki personal

Esto significa: puedes tener un wiki del proyecto para documentación del equipo **y** un wiki personal para tus propias notas, y recall busca ambos simultáneamente.

---

## Inicio Rápido (Detallado)

### 1) Crear un nuevo wiki

```bash
mkdir my-wiki
cd my-wiki
pi
```

Pregunta a pi:

```
Initialize an llm wiki here for AI research.
```

Esto llama a `wiki_bootstrap` y crea:

```
.llm-wiki/
├── config.json
├── templates/
├── raw/
├── wiki/
├── meta/
└── WIKI_SCHEMA.md
```

### 2) Capturar una fuente

```
Capture this article into the wiki: https://example.com/some-article
```

```
Capture this PDF into the wiki: ./papers/context-windows.pdf
```

```
Capture these notes into the wiki: ...pasted text...
```

### 3) Integrar la fuente

1. Captura la fuente
2. Lee `.llm-wiki/wiki/sources/SRC-*.md`
3. Actualiza esa página de fuente
4. Busca páginas canónicas afectadas con `wiki_search`
5. Crea páginas faltantes con `wiki_ensure_page`
6. Actualiza páginas de concepto / entidad / síntesis con citas
7. Marca la integración con `wiki_log_event kind=integrate`

### 4) Consultar el wiki

```
Based on the wiki, what are the main tradeoffs between long-context models and RAG?
```

Por defecto, el modo de consulta es **de solo lectura**. Para archivar una respuesta duradera:

```
Answer the question and file the result as an analysis page.
```

---

## Estructura del Vault

```
my-wiki/
└─ .llm-wiki/
   ├─ config.json               # Configuración del vault
   ├─ templates/                 # Plantillas de páginas
   ├─ raw/
   │  └─ sources/
   │     └─ SRC-2026-05-11-001/
   │        ├─ manifest.json
   │        ├─ original/           # Artefacto original
   │        ├─ extracted.md        # Texto normalizado
   │        └─ attachments/
   ├─ wiki/
   │  ├─ sources/                  # Páginas de fuentes (lo que dice cada fuente)
   │  ├─ concepts/                 # Conceptos e ideas recurrentes
   │  ├─ entities/                 # Personas, organizaciones, productos, papers, sistemas
   │  ├─ syntheses/                # Teses y tensiones entre fuentes
   │  └─ analyses/                 # Respuestas archivadas duraderas de consultas
   ├─ meta/
   │  ├─ registry.json             # Índice de búsqueda auto-generado
   │  ├─ backlinks.json
   │  ├─ index.md
   │  ├─ events.jsonl              # Registro de eventos de solo adjunción
   │  ├─ log.md
   │  └─ lint-report.md
   └─ WIKI_SCHEMA.md               # Manual de operaciones
```

### Modelo de Propiedad

| Ruta | Propietario | Regla |
|------|-------------|-------|
| `.llm-wiki/raw/**` | Herramientas de extensión | Inmutable tras la captura |
| `.llm-wiki/wiki/**` | Modelo + usuario | Páginas de conocimiento editables |
| `.llm-wiki/meta/registry.json` | Extensión | Generado |
| `.llm-wiki/meta/backlinks.json` | Extensión | Generado |
| `.llm-wiki/meta/index.md` | Extensión | Generado |
| `.llm-wiki/meta/events.jsonl` | Extensión / herramienta | Solo adjunción |
| `.llm-wiki/meta/log.md` | Extensión | Generado desde eventos |
| `.llm-wiki/meta/lint-report.md` | Extensión | Generado |
| `.llm-wiki/WIKI_SCHEMA.md` | Humano + solicitud explícita | Manual de operaciones |

---

## Estilo de Enlaces y Citas

### Navegación Interna

```markdown
[[concepts/retrieval-augmented-generation]]
[[entities/openai|OpenAI]]
[[syntheses/long-context-vs-rag]]
```

### Citas Factuales

```markdown
[[sources/SRC-2026-04-04-001|SRC-2026-04-04-001]]
```

Los IDs estables de páginas de fuente mantienen la procedencia estable incluso si los títulos cambian.

---

## Barreras de Seguridad

La extensión **bloquea** ediciones directas por llamada de herramienta a:

- `.llm-wiki/raw/**` — artefactos de fuente inmutables
- `.llm-wiki/meta/registry.json`
- `.llm-wiki/meta/backlinks.json`
- `.llm-wiki/meta/events.jsonl`
- `.llm-wiki/meta/index.md`
- `.llm-wiki/meta/log.md`
- `.llm-wiki/meta/lint-report.md`

Si el modelo edita directamente `.llm-wiki/wiki/**` usando las herramientas integradas `write` o `edit` de Pi, la extensión **reconstruye automáticamente** los metadatos generados al final del turno del agente.

---

## Formato de Paquete de Fuente

Cada fuente capturada se almacena como un paquete estructurado:

```
.llm-wiki/raw/sources/SRC-YYYY-MM-DD-NNN/
├─ manifest.json     # Metadatos de captura (título, URL, formato, marca de tiempo)
├─ original/         # Artefacto original (preservado tal cual)
├─ extracted.md      # Texto normalizado (PDF→md, XML→md, JSON→md, etc.)
└─ attachments/      # Descargas futuras de adjuntos
```

Esto preserva tanto el **artefacto original** como una **vista extraída normalizada** para lectura.

---

## Servidor MCP

Usa el wiki desde **cualquier herramienta compatible con MCP** — Claude Code, Cursor, Windsurf y otras.

El paquete incluye un servidor MCP independiente que expone 6 herramientas de wiki por stdio:

| Herramienta | Descripción |
|-------------|-------------|
| `wiki_bootstrap` | Inicializa un nuevo vault de wiki con configuración, plantillas, esquema y metadatos |
| `wiki_recall` | Busca en el wiki páginas relevantes para la tarea |
| `wiki_search` | Búsqueda completa del registro |
| `wiki_status` | Estadísticas del wiki (conteos de páginas, desglose por tipo) |
| `wiki_retro` | Guarda ideas atómicas |
| `wiki_capture_source` | Captura texto como paquete de fuente |

### Uso

```bash
# Auto-descubierto por pi:
pi install npm:@zosmaai/pi-llm-wiki

# Independiente con cualquier cliente MCP:
WIKI_ROOT=~/my-wiki node node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js
```

Establece `WIKI_ROOT` en el directorio de tu vault de wiki. Si no está establecido, el servidor lo detecta automáticamente desde el directorio de trabajo actual.

### Configuración del cliente

El mismo servidor como entrada en `.mcp.json` (Claude Code) o `claude_desktop_config.json`:

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

> Los clientes MCP lanzan el comando **sin shell**, por lo que `~` nunca se expande. Un `~/my-wiki` en `args` o `env` se pasa literalmente y el servidor no arranca, algo que el cliente solo informa como un error de conexión genérico: usa rutas absolutas aquí. El fragmento de shell anterior sí funciona, porque tu shell expande `~` antes de que `node` lo reciba.

---

## Comportamiento de la Habilidad

La habilidad `llm-wiki` incluida enseña al modelo a:

- ❌ Nunca editar fuentes crudas directamente
- ❌ Nunca editar archivos de metadatos generados
- ✅ Capturar primero, integrar después
- ✅ Buscar antes de crear nuevas páginas canónicas
- ✅ Citar hechos usando IDs de páginas de fuente
- ✅ Mantener el modo de consulta de solo lectura por defecto
- ✅ Usar "Tensiones / advertencias" y "Preguntas abiertas" cuando la evidencia es mixta

---

## Arquitectura

### Capas del Vault

Consulta la sección [Arquitectura de Vault en Capas](#arquitectura-de-vault-en-capas) anterior para el apilamiento personal/proyecto/empresa.

### Modelo de Páginas de Cuatro Capas

Cada vault de wiki tiene cuatro capas con propiedad clara:

```
.llm-wiki/raw/sources/SRC-*/     # Paquetes de fuente inmutables (propiedad de la extensión)
.llm-wiki/wiki/                   # Páginas de conocimiento editables (tú + LLM)
.llm-wiki/meta/                   # Registro, backlinks, índice, registro auto-generados
.llm-wiki/                        # Configuración y plantillas
```

Lee [docs/architecture.md](docs/architecture.md) para el documento de diseño completo.

---

## Documentación

| Documento | Qué cubre |
|-----------|-----------|
| [Arquitectura](docs/architecture.md) | Cómo funcionan las cuatro capas, modelo de propiedad |
| [Comandos](docs/commands.md) | Todos los comandos de barra y referencia de herramientas |
| [Integración con Obsidian](docs/obsidian.md) | Configuración del vault y plugins recomendados |
| [Configuración](docs/configuration.md) | Modos de wiki, temas, variables de entorno |
| [API](docs/api.md) | Referencia de parámetros de herramientas de extensión |

---

## Contribuir

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para la configuración de desarrollo, patrones de prueba y flujo de trabajo de PR.

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

## Contribuyentes

¡Gracias a todos los que han contribuido! Esta lista se regenera automáticamente por [`.github/workflows/contributors.yml`](.github/workflows/contributors.yml) — consulta [#60](https://github.com/zosmaai/pi-llm-wiki/issues/60) para la justificación.

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
                <a href="https://github.com/CelestialCreator">
                    <img src="https://avatars.githubusercontent.com/u/177931942?v=4" width="64;" alt="CelestialCreator"/>
                    <br />
                    <sub><b>Akshay</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/xcsf">
                    <img src="https://avatars.githubusercontent.com/u/43439835?v=4" width="64;" alt="xcsf"/>
                    <br />
                    <sub><b>xcsf</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/danielnaab">
                    <img src="https://avatars.githubusercontent.com/u/136512?v=4" width="64;" alt="danielnaab"/>
                    <br />
                    <sub><b>Daniel Naab</b></sub>
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
