<div align="center">

# @zosmaai/pi-llm-wiki

<a href="./README.md">English</a> | **中文** | <a href="./README.es.md">Español</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.de.md">Deutsch</a> | <a href="./README.fr.md">Français</a> | <a href="./README.pt.md">Português</a> | <a href="./README.ru.md">Русский</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.hi.md">हिंदी</a>

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

**基于 [pi](https://pi.dev) 的自维护、兼容 Obsidian 的知识库。**
遵循 Andrej Karpathy 的 [LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。

将原始来源（网址、PDF、Markdown、JSON、XML）转化为持久、互联、由 LLM 维护的 Wiki，并随时间不断积累。

### 原生 Open Knowledge Format (OKF) v0.2 支持

构建可随身携带的知识库——不再是另一个封闭的应用专属导出：

- **创建可移植的 OKF v0.2 文档**，具有标准 frontmatter、标准 Markdown 链接和稳定的来源引用。
- **同时读取旧版和 OKF 页面**，现有 vault 无需自动迁移或重写即可继续工作。
- **从权威页面生成确定性索引和日志**，保持导航和元数据可重现。
- **从 Pi 或 MCP 使用相同的知识模型**，支持 Claude Code、Cursor、Windsurf 和其他 MCP 客户端。
- **保持 Obsidian 兼容性**，同时让知识准备好供支持 Open Knowledge Format 的工具使用。

从新的 OKF vault 开始，或将 pi-llm-wiki 指向现有 vault，按您的节奏采用该格式。查看 [OKF Foundation 规范](docs/superpowers/specs/2026-08-02-okf-foundation-design.md) 了解实现细节。

---

## 演示

<div align="center">
  <img src="./assets/demo.gif" alt="pi-llm-wiki demo" width="1920" />
</div>

---

## 快速开始

```bash
pi install npm:@zosmaai/pi-llm-wiki
```

扩展将在首次会话时主动建议创建 wiki。或者：

```
/wiki-init "AI Engineering"
/wiki-ingest
/wiki-query What are the key patterns?
```

---

## 为什么选择这个包？

大多数基于文件的 LLM 工作流如同一键式 RAG：每次提问时模型都会搜索原始文档。综合结果转瞬即逝。

**pi-llm-wiki** 创建了一个中间层：

- **原始来源包** 保留真实来源输入
- **来源页面** 总结每个来源的内容
- **规范 wiki 页面** 追踪 wiki 当前认定的内容
- **生成的元数据** 保持所有内容可搜索和可导航

结果是：随着您捕获来源、提出问题并归档持久分析，wiki 会不断 **积累**。

---

## 特性

| 功能 | 描述 |
|------|------|
| 🏠 **个人回退** | 始终开启的 `~/.llm-wiki/` vault——即使没有项目 wiki，知识也能跨项目积累 |
| 🔗 **不可变的来源捕获** | URL、本地文件（PDF/md/txt/html/XML/JSON）或粘贴文本 → 结构化来源包 |
| 🧠 **自动化摄取** | `wiki_ingest` 批量处理来源到概念、实体、综合和分析页面 |
| 🔍 **全文搜索** | 生成的注册表，跨所有页面和来源的关键字查找 |
| 🩺 **机械式 linting** | 孤儿页面、断链、重复别名、覆盖缺口、过时捕获 |
| 📊 **仪表板** | `wiki_status`——计数、来源状态、最近活动 |
| 🤖 **自动更新监控** | `wiki_watch`——打印按计划运行完整周期的 `crontab` 行 |
| 🧠 **分层召回** | 同时搜索个人（`~/.llm-wiki/`）和项目（`.llm-wiki/`）vault——个人知识随您到处 |
| 📝 **自动引导** | 当前目录不存在 wiki 时扩展建议创建 |
| 💾 **轻量级捕获** | `wiki_retro`——将原子洞察保存为单个 markdown 文件；通过 `wiki_capture_source` 也可用完整 4 层管道 |
| 🧭 **代理工作记忆** _（可选）_ | `wiki_capture_trajectory` 记录任务如何解决的（工具调用轨迹）→ 提炼为可重用的 `skill`/`case` 页面 → `wiki_recall_skill` 下次展示。默认关闭；用 `/wiki-trajectories on` 启用 |
| 🌐 **OKF v0.2 原生** | 可移植 Open Knowledge Format 文档、双读旧版兼容、确定性投影 |
| 🌐 **MCP 服务器** | 通过 stdio MCP 传输从 Claude Code、Cursor、Windsurf 使用相同的 OKF 感知 wiki |
| 📝 **Obsidian 友好** | 文件夹限定 wikilinks、稳定来源 ID 引用、兼容 vault |
| 🛡️ **护栏** | 阻止直接编辑原始来源和生成的元数据 |
| 🔧 **可配置的 PDF 提取** | 通过 `WIKI_MARKITDOWN_TIMEOUT_MS` 环境变量设置 MarkItDown 超时 |
| 🧪 **562 测试、85.09% 覆盖率** | TypeScript、Vitest、Biome、Codecov、CodeQL |

---

## 工具

| 工具 | 描述 |
|------|------|
| `wiki_bootstrap` | 用配置、模板、模式和元数据初始化新的 wiki vault |
| `wiki_capture_source` | 将 URL、本地文件或粘贴文本捕获到不可变的来源包中 |
| `wiki_recall` | 搜索 wiki 中与任务相关的页面——搜索个人和项目 vault，去重 |
| `wiki_retro` | 将已完成任务的原子洞察保存到 wiki |
| `wiki_ingest` | 处理未摄取的来源包到 wiki 页面（批量） |
| `wiki_ensure_page` | 解析或安全创建实体/概念/综合/分析页面 |
| `wiki_search` | 搜索生成的 wiki 注册表 |
| `wiki_lint` | 确定性健康检查（孤儿、缺口、矛盾、自动修复） |
| `wiki_status` | 显示计数、来源状态和最近活动 |
| `wiki_observe` | 记录当前会话的带时间戳、可搜索观察 |
| `wiki_rebuild_meta` | 强制完整元数据重建（注册表、反向链接、索引、日志） |
| `wiki_reindex_embeddings` | 为新增或过期的页面刷新语义嵌入（未配置 embedding 提供方时为空操作） |
| `wiki_log_event` | 将结构化事件追加到 wiki 活动日志 |
| `wiki_watch` | 打印自动 wiki 更新的 `crontab` 行（每日/每周/每小时）——不安装它 |
| `wiki_capture_trajectory` _（可选）_ | 捕获已完成任务的工具调用轨迹（代理工作记忆） |
| `wiki_distill_skills` _（可选）_ | 批量未提炼的轨迹以合成为可重用的技能页面 |
| `wiki_recall_skill` _（可选）_ | 召回提炼的技能+类似过去案例——"我以前做过这个吗？" |

> 三个代理轨迹工具 **默认关闭**（issue #80）。用 `/wiki-trajectories on` 启用（设置 `llm-wiki.trajectories`）；关闭时完全不注册。

### 斜杠命令

| 命令 | 描述 |
|------|------|
| `/wiki-init <topic>` | 初始化新的 LLM Wiki vault |
| `/wiki-ingest [path]` | 处理新来源文件并更新 wiki |
| `/wiki-query <question>` | 带引用向 wiki 提问 |
| `/wiki-discover [--topic <topic>]` | 从网络自动发现新来源 |
| `/wiki-run [--schedule daily\|weekly]` | 完整周期：发现 → 摄取 → lint |
| `/wiki-lint [--fix]` | 健康检查（孤儿、矛盾、缺口） |
| `/wiki-status` | 显示简洁的操作摘要 |
| `/wiki-digest [--period daily\|weekly]` | 生成最近活动的摘要 |
| `/wiki-retro` | 保存已完成任务的原子洞察 |
| `/wiki-model [provider/id | session]` | 设置后台任务模型（无参数时为交互式选择器） |
| `/wiki-req <concept>` | 将概念分解为原子、可追踪的需求页面 |
| `/wiki-trajectories <on\|off>` | 启用/禁用代理工作记忆（可选，默认关闭） |
| `/wiki-record <title>` | 捕获已完成任务的轨迹（需要启用轨迹） |
| `/wiki-skills [query]` | 搜索提炼的技能+过去案例（需要启用轨迹） |
| `/wiki-settings` | 交互式设置屏幕 — 在 project/global 作用域下查看/修改全部 `llm-wiki` 设置 |
| `/wiki-dashboard` | 只读知识库仪表盘 — 页面数量/类型、新鲜度、7 日活动、入库队列、零反链页面、embedding 覆盖率 |

<img src="./assets/wiki-dashboard.png" alt="wiki-dashboard: 知识库仪表盘" width="100%" />


---

## 分层 Vault 架构

知识随您到处。pi-llm-wiki 使用分层 vault 系统：

| 层 | 位置 | 用途 |
|----|------|------|
| 🏠 **个人** | `~/.llm-wiki/` | 始终激活。零设置。知识跨所有会话积累——无论您在哪个项目中。 |
| 📁 **项目** | `{project}/.llm-wiki/` | 明确选择加入。每个项目专用 wiki，相关时共享个人知识。 |
| 🏢 **公司**（未来） | git 跟踪 | 团队共享 wiki。`wiki_publish` 将个人/项目页面提升到公司 wiki。 |

**工作原理：**

1. `resolveVaultRoot()` 检查：cwd → 向上查找 `.llm-wiki/` → `~/.llm-wiki/`
2. `wiki_recall`（分层）搜索 **两个** 个人和项目 vault，合并结果带 vault 标签
3. 个人结果在召回输出中首先显示，标记为 "📓 personal"
4. `wiki_retro` 写入当前激活的 vault（项目优先）
5. 设置 `WIKI_HOME` 环境变量覆盖个人 wiki 位置

这意味着：您可以有用于团队文档的项目 wiki **和** 用于个人笔记的个人 wiki，recall 同时搜索两者。

---

## 快速开始（详细）

### 1) 创建新的 wiki

```bash
mkdir my-wiki
cd my-wiki
pi
```

询问 pi：

```
Initialize an llm wiki here for AI research.
```

这将调用 `wiki_bootstrap` 并创建：

```
.llm-wiki/
├── config.json
├── templates/
├── raw/
├── wiki/
├── meta/
└── WIKI_SCHEMA.md
```

### 2) 捕获来源

```
Capture this article into the wiki: https://example.com/some-article
```

```
Capture this PDF into the wiki: ./papers/context-windows.pdf
```

```
Capture these notes into the wiki: ...pasted text...
```

### 3) 集成来源

1. 捕获来源
2. 读取 `.llm-wiki/wiki/sources/SRC-*.md`
3. 更新该来源页面
4. 用 `wiki_search` 搜索受影响的规范页面
5. 用 `wiki_ensure_page` 创建缺失页面
6. 更新概念/实体/综合页面带引用
7. 用 `wiki_log_event kind=integrate` 标记集成

### 4) 查询 wiki

```
Based on the wiki, what are the main tradeoffs between long-context models and RAG?
```

默认情况下，查询模式是 **只读**。要归档持久答案：

```
Answer the question and file the result as an analysis page.
```

---

## Vault 布局

```
my-wiki/
└─ .llm-wiki/
   ├─ config.json               # Vault 配置
   ├─ templates/                 # 页面模板
   ├─ raw/
   │  └─ sources/
   │     └─ SRC-2026-05-11-001/
   │        ├─ manifest.json
   │        ├─ original/           # 原始工件
   │        ├─ extracted.md        # 规范化文本
   │        └─ attachments/
   ├─ wiki/
   │  ├─ sources/                  # 来源页面（每个来源说什么）
   │  ├─ concepts/                 # 概念和重复出现的想法
   │  ├─ entities/                 # 人物、组织、产品、论文、系统
   │  ├─ syntheses/                # 跨来源论点和张力
   │  └─ analyses/                 # 来自查询的持久归档答案
   ├─ meta/
   │  ├─ registry.json             # 自动生成搜索索引
   │  ├─ backlinks.json
   │  ├─ index.md
   │  ├─ events.jsonl              # 仅追加事件日志
   │  ├─ log.md
   │  └─ lint-report.md
   └─ WIKI_SCHEMA.md               # 操作手册
```

### 所有权模型

| 路径 | 所有者 | 规则 |
|------|--------|------|
| `.llm-wiki/raw/**` | 扩展工具 | 捕获后不可变 |
| `.llm-wiki/wiki/**` | 模型 + 用户 | 可编辑知识页面 |
| `.llm-wiki/meta/registry.json` | 扩展 | 生成 |
| `.llm-wiki/meta/backlinks.json` | 扩展 | 生成 |
| `.llm-wiki/meta/index.md` | 扩展 | 生成 |
| `.llm-wiki/meta/events.jsonl` | 扩展/工具 | 仅追加 |
| `.llm-wiki/meta/log.md` | 扩展 | 从事件生成 |
| `.llm-wiki/meta/lint-report.md` | 扩展 | 生成 |
| `.llm-wiki/WIKI_SCHEMA.md` | 人工 + 明确请求 | 操作手册 |

---

## 链接和引用风格

### 内部导航

```markdown
[[concepts/retrieval-augmented-generation]]
[[entities/openai|OpenAI]]
[[syntheses/long-context-vs-rag]]
```

### 事实引用

```markdown
[[sources/SRC-2026-04-04-001|SRC-2026-04-04-001]]
```

稳定的来源页面 ID 即使标题更改也保持溯源稳定。

---

## 护栏

扩展 **阻止** 直接工具调用编辑：

- `.llm-wiki/raw/**`——不可变的来源工件
- `.llm-wiki/meta/registry.json`
- `.llm-wiki/meta/backlinks.json`
- `.llm-wiki/meta/events.jsonl`
- `.llm-wiki/meta/index.md`
- `.llm-wiki/meta/log.md`
- `.llm-wiki/meta/lint-report.md`

如果模型直接使用 Pi 内置的 `write` 或 `edit` 工具编辑 `.llm-wiki/wiki/**`，扩展 **自动重建** 生成的元数据在代理回合结束时。

---

## 来源包格式

每个捕获的来源存储为结构化包：

```
.llm-wiki/raw/sources/SRC-YYYY-MM-DD-NNN/
├─ manifest.json     # 捕获元数据（标题、URL、格式、时间戳）
├─ original/         # 原始工件（原样保留）
├─ extracted.md      # 规范化文本（PDF→md、XML→md、JSON→md 等）
└─ attachments/      # 未来附件下载
```

这同时保留 **原始工件** 和 **规范化提取视图** 供阅读。

---

## MCP 服务器

从 **任何 MCP 兼容工具** 使用 wiki——Claude Code、Cursor、Windsurf 等。

包附带独立 MCP 服务器，通过 stdio 暴露 6 个 wiki 工具：

| 工具 | 描述 |
|------|------|
| `wiki_bootstrap` | 用配置、模板、模式和元数据初始化新的 wiki vault |
| `wiki_recall` | 搜索 wiki 中与任务相关的页面 |
| `wiki_search` | 完整注册表搜索 |
| `wiki_status` | Wiki 统计（页面计数、类型分解） |
| `wiki_retro` | 保存原子洞察 |
| `wiki_capture_source` | 捕获文本为来源包 |

### 用法

```bash
# pi 自动发现：
pi install npm:@zosmaai/pi-llm-wiki

# 独立使用任何 MCP 客户端：
WIKI_ROOT=~/my-wiki node node_modules/@zosmaai/pi-llm-wiki/dist/mcp/index.js
```

设置 `WIKI_ROOT` 为您的 wiki vault 目录。如果未设置，服务器从当前工作目录自动检测。

### 客户端配置

在 `.mcp.json`（Claude Code）或 `claude_desktop_config.json` 中配置同一个服务器：

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

> MCP 客户端在**不经过 shell** 的情况下启动该命令，因此 `~` 不会被展开。`args` 或 `env` 中的 `~/my-wiki` 会被原样传递，服务器随即启动失败，而客户端只会报告一个笼统的连接错误——这里请使用绝对路径。上面的 shell 命令没有问题：`~` 由你的 shell 在 `node` 收到之前展开。

---

## 技能行为

捆绑的 `llm-wiki` 技能教导模型：

- ❌ 从不直接编辑原始来源
- ❌ 从不编辑生成的元数据文件
- ✅ 先捕获，后集成
- ✅ 创建新规范页面前先搜索
- ✅ 使用来源页面 ID 引用事实
- ✅ 默认保持查询模式只读
- ✅ 证据混合时使用 "张力/注意事项" 和 "开放问题"

---

## 架构

### Vault 层

参见上方 [分层 Vault 架构](#分层-vault-架构) 部分了解个人/项目/公司分层。

### 四层页面模型

每个 wiki vault 有四个层，所有权清晰：

```
.llm-wiki/raw/sources/SRC-*/     # 不可变来源包（扩展所有）
.llm-wiki/wiki/                   # 可编辑知识页面（您 + LLM）
.llm-wiki/meta/                   # 自动生成注册表、反向链接、索引、日志
.llm-wiki/                        # 配置和模板
```

阅读 [docs/architecture.md](docs/architecture.md) 获取完整设计文档。

---

## 文档

| 文档 | 涵盖内容 |
|------|----------|
| [架构](docs/architecture.md) | 四层如何工作、所有权模型 |
| [命令](docs/commands.md) | 所有斜杠命令和工具参考 |
| [Obsidian 集成](docs/obsidian.md) | Vault 设置和推荐插件 |
| [配置](docs/configuration.md) | Wiki 模式、主题、环境变量 |
| [API](docs/api.md) | 扩展工具参数参考 |

---

## 贡献

查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发设置、测试模式和 PR 工作流。

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

## 贡献者

感谢所有贡献者！此列表由 [`.github/workflows/contributors.yml`](.github/workflows/contributors.yml) 自动生成——查看 [#60](https://github.com/zosmaai/pi-llm-wiki/issues/60) 了解原因。

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
