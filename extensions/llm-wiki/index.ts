import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installGuardrails } from "./lib/guardrails.js";
import {
  MODEL_STATUS_KEY,
  formatActiveModelLabel,
  registerWikiModelCommand,
} from "./lib/model-command.js";
import {
  buildSessionNotice,
  createReminderState,
  registerObservationReminder,
  registerWikiObserve,
} from "./lib/observation.js";
import {
  formatRecallContext,
  registerWikiRecall,
  searchWikiHybrid,
  shouldUseLinksFirst,
  vaultPageCount,
} from "./lib/recall.js";
import { registerWikiRetro } from "./lib/retro.js";
import { registerBackgroundRuntime } from "./lib/runtime.js";
import { loadTaskConfig, noticesEnabled, trajectoriesEnabled } from "./lib/task-config.js";
import {
  registerWikiBootstrap,
  registerWikiCaptureSource,
  registerWikiEnsurePage,
  registerWikiIngest,
  registerWikiLint,
  registerWikiLogEvent,
  registerWikiRebuildMeta,
  registerWikiReindexEmbeddings,
  registerWikiSearch,
  registerWikiStatus,
  registerWikiWatch,
} from "./lib/tools.js";
import { registerWikiTrajectoriesCommand } from "./lib/trajectories-command.js";
import {
  registerWikiCaptureTrajectory,
  registerWikiDistillSkills,
  registerWikiRecallSkill,
} from "./lib/trajectory.js";
import {
  ensureVaultStructure,
  fmtDate,
  getVaultPaths,
  migrateDoubledPersonalVault,
  resolveVaultPaths,
  writeJson,
} from "./lib/utils.js";

/**
 * @zosmaai/pi-llm-wiki — LLM Wiki extension for Pi
 *
 * Registers 13 custom tools and installs guardrails (+3 agent-trajectory tools
 * when `llm-wiki.trajectories` is enabled — opt-in, off by default, issue #80):
 * - wiki_recall (layered: personal + project vaults)
 * - wiki_retro (lightweight: single markdown file)
 * - wiki_capture_source (full 4-layer pipeline)
 *
 * Guardrails:
 * - Blocks direct edits to raw/** and meta/**
 * - Auto-rebuilds metadata after wiki/** edits
 *
 * Layered recall:
 * - before_agent_start hook searches personal + project vaults
 * - Injects matching knowledge as system context with vault labels
 * - wiki_recall tool available for explicit task-specific searches
 */

export default function (pi: ExtensionAPI) {
  // Background-task lane (issues #64, #65): shared runtime for off-thread LLM
  // work. Created first so tools (e.g. wiki_ingest) can dispatch to it.
  const runtime = registerBackgroundRuntime(pi);

  registerWikiBootstrap(pi);
  registerWikiCaptureSource(pi, runtime);
  registerWikiIngest(pi, runtime);
  registerWikiEnsurePage(pi, runtime);
  registerWikiSearch(pi);
  registerWikiLint(pi, runtime);
  registerWikiStatus(pi);
  registerWikiRebuildMeta(pi, runtime);
  registerWikiReindexEmbeddings(pi, runtime);
  registerWikiLogEvent(pi);
  registerWikiWatch(pi);
  registerWikiRecall(pi, runtime);
  registerWikiRetro(pi, runtime);
  // Agent working-memory (issue #80): capture what the agent *did* (its
  // tool-call trajectory), distill it into reusable skills, and recall past
  // skills/cases. OPT-IN, default OFF — registered ONLY when enabled so the 3
  // tools cost nothing in the system prompt for users who don't opt in.
  //
  // Gate on loadTaskConfig(process.cwd()) at factory time, NOT runtime.config:
  // runtime.config is empty ({}) until ensureConfig runs in a later hook, so a
  // runtime.config gate here would read as permanently off. Toggling the flag
  // via /wiki-trajectories reloads the extension, re-running this gate.
  const trajectoriesOn = trajectoriesEnabled(loadTaskConfig(process.cwd()));
  if (trajectoriesOn) {
    registerWikiCaptureTrajectory(pi);
    registerWikiDistillSkills(pi);
    registerWikiRecallSkill(pi);
  }
  // Activation surface for the above (always available so users can turn it on).
  registerWikiTrajectoriesCommand(pi);
  // Model selection surface (issue #69): /wiki-model command to view/set the
  // background task model. The taskModel config field + resolveModel already
  // exist; this exposes them to the user (default stays the session model).
  registerWikiModelCommand(pi, runtime);
  const reminderState = createReminderState();
  registerWikiObserve(pi, runtime, reminderState);
  // Visible observe/retro reminder by default (issue #77); silenced when the
  // user sets `llm-wiki.notices: false`. Resolver reads the live config so the
  // setting takes effect without a restart.
  registerObservationReminder(pi, reminderState, {
    display: () => noticesEnabled(runtime.config),
  });

  installGuardrails(pi, runtime);

  // Track if wiki was just auto-created and needs topic inference
  let needsTopicInference = false;

  pi.on("session_start", async (_event, ctx) => {
    // One-shot recovery for vaults created with the broken personal-root
    // (~/.llm-wiki/.llm-wiki/… doubled layout). Runs on every session start
    // because it is a cheap existence-check no-op when the layout is correct.
    try {
      const migration = migrateDoubledPersonalVault();
      if (migration && migration.moved.length > 0) {
        ctx.ui.setStatus(
          "llm-wiki",
          `🧠 Personal wiki layout fixed: flattened ${migration.moved.length} entries out of ${migration.from} (see CHANGELOG)`,
        );
      }
    } catch (err) {
      // Never let migration crash session start.
      console.warn(`[llm-wiki] doubled-dotdir migration skipped: ${(err as Error).message}`);
    }

    const paths = resolveVaultPaths(process.cwd());
    if (!existsSync(join(paths.dotWiki, "config.json"))) {
      // Silently create the wiki vault — no UI prompts
      // Topic/mode will be inferred from user's first prompt via before_agent_start
      const root = paths.root;
      const vaultPaths = getVaultPaths(root);
      ensureVaultStructure(vaultPaths);

      writeJson(join(vaultPaths.dotWiki, "config.json"), {
        name: "pending",
        mode: "personal",
        topic: "pending",
        created: fmtDate(),
        version: "1.0",
      });

      const schema = [
        "# LLM Wiki Schema",
        "",
        "## Ownership Rules",
        "",
        "| Path | Owner | Rule |",
        "|------|-------|------|",
        "| raw/** | extension | immutable after capture |",
        "| wiki/** | model + user | editable knowledge pages |",
        "| meta/* | extension | auto-generated |",
        "| . | human + explicit request | operating rules |",
      ].join("\n");
      writeFileSync(join(vaultPaths.dotWiki, "WIKI_SCHEMA.md"), schema, "utf-8");

      needsTopicInference = true;
      ctx.ui.setStatus("llm-wiki", "🧠 Wiki created (inferring topic from first prompt…)");
      return;
    }

    // Surface the active background task model (issue #69). Defaults to the
    // session model when no taskModel is configured.
    runtime.ensureConfig(process.cwd());

    if (noticesEnabled(runtime.config)) {
      ctx.ui.setStatus(
        "llm-wiki",
        trajectoriesOn
          ? "🧠 LLM Wiki (16 tools, trajectory + observe + recall active)"
          : "🧠 LLM Wiki (13 tools, observe + recall active)",
      );
    }

    const modelLabel = formatActiveModelLabel(runtime.config, (ctx.model as { id?: string })?.id);
    if (noticesEnabled(runtime.config)) {
      ctx.ui.setStatus(MODEL_STATUS_KEY, `🧠 wiki model: ${modelLabel}`);
    }

    // One-time, user-visible session notice announcing the full wiki loop
    // (issue #77). Without this, recall/observe/retro are invisible — they
    // live only in the system prompt. Queued for the first prompt so it never
    // interrupts; silenced when `llm-wiki.notices: false`.
    if (noticesEnabled(runtime.config)) {
      pi.sendMessage(
        { customType: "wiki-session-notice", content: buildSessionNotice(), display: true },
        { deliverAs: "nextTurn" },
      );
    }
  });

  // ─── Layered recall + topic inference hook ──────────
  // Before each agent turn:
  // 1. If wiki was just auto-created, inject a directive to infer topic/mode
  //    from the user's first prompt and update config via wiki_bootstrap.
  // 2. Search both personal + project vaults for relevant pages.
  pi.on("before_agent_start", async (event, ctx) => {
    const paths = resolveVaultPaths(process.cwd());
    if (!existsSync(join(paths.dotWiki, "config.json"))) {
      return;
    }

    const prompt = event.prompt || "";
    let injectedContext = event.systemPrompt || "";

    // Topic inference on first turn after auto-creation
    if (needsTopicInference && prompt.trim()) {
      needsTopicInference = false;

      // Gather project context clues for topic inference
      const cwd = process.cwd();
      const dirName = basename(cwd);
      let projectHints = `Project directory: "${dirName}" (path: ${cwd})`;

      try {
        const pkgPath = join(cwd, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          projectHints += `\nPackage: ${pkg.name || "unknown"} v${pkg.version || "?"}`;
          if (pkg.description) projectHints += `\nDescription: ${pkg.description}`;
        }
      } catch {
        // ignore
      }

      injectedContext += `

## Wiki Setup Required
The LLM Wiki was just auto-created but needs its topic and mode configured. Before responding to the user, analyze their prompt and this project's context to infer:
- **topic**: What is this wiki about? (e.g. "React app", "personal notes", "startup finances")
- **mode**: "personal" or "company" based on whether this looks like work or personal use

Project context hints:
${projectHints}

Then call wiki_bootstrap with the inferred topic and mode to finalize the setup. This is a one-time step.`;
    }

    // Auto-injection recall: search ONLY the project vault with a relevance
    // threshold. Low-confidence matches are discarded to avoid context pollution.
    // Personal vault is excluded — it contains cross-project pages that
    // produce noise in unrelated sessions. Users can call wiki_recall
    // explicitly for personal-vault searches.
    if (prompt.trim()) {
      // minScore=5: requires at least a title/heading/alias/trigger match,
      // or multiple body matches. This eliminates accidental body-only
      // substring matches (e.g. a Tally page matching on common words).
      // includePersonal=false: personal vault is excluded from auto-injection.
      // Hybrid: blends semantic cosine when embeddings exist (single cached
      // query embedding); degrades to pure lexical otherwise. minScore=5 still
      // gates noise — a semantic-only match must be strongly relevant to pass.
      runtime.ensureConfig(process.cwd());
      const results = await searchWikiHybrid(paths, prompt, 3, 5, false, {
        config: runtime.config,
      });
      if (results.length > 0) {
        // Two-stage gate (issue #68): above the vault-size threshold, inject
        // ranked LINKS only (the agent expands them on demand via `read`) so a
        // large vault never floods the system prompt with inline previews.
        // includePersonal=false here mirrors the auto-injection search scope.
        const linksOnly = shouldUseLinksFirst(vaultPageCount(paths, false), runtime.config);
        const recallContext = formatRecallContext(results, { linksOnly });
        if (recallContext) {
          injectedContext += `\n\n${recallContext}`;
        }
        // Recall-aware status line (issue #77): make it visible that recall
        // actually fired and how many pages matched. Purely a UI signal — no
        // added model context. Honors the `notices` opt-out.
        if (ctx?.hasUI && noticesEnabled(runtime.config)) {
          const n = results.length;
          ctx.ui.setStatus(
            "llm-wiki",
            `\u{1F9E0} LLM Wiki — recalled ${n} page${n === 1 ? "" : "s"} for this task`,
          );
        }
      }
    }

    // Always inject a visible wiki status footer, even when empty
    // This ensures the model knows the wiki is active and can use it
    injectedContext +=
      "\n\n<wiki_status>LLM Wiki active — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.</wiki_status>";

    if (injectedContext === event.systemPrompt) return;
    return { systemPrompt: injectedContext };
  });
}
