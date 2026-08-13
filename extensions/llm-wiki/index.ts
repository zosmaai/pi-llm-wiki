import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bootstrapVault } from "./lib/bootstrap.js";
import { installGuardrails } from "./lib/guardrails.js";
import { buildAgentStartInjection, normalizeSystemPrompt } from "./lib/inject.js";
import { registerWikiModelCommand } from "./lib/model-command.js";
import {
  buildSessionNotice,
  createReminderState,
  registerObservationReminder,
  registerWikiObserve,
} from "./lib/observation.js";
import { recoverQmdIndex } from "./lib/qmd-indexing.js";
import {
  formatRecallContext,
  registerWikiRecall,
  searchWikiHybrid,
  shouldUseLinksFirst,
  vaultPageCount,
} from "./lib/recall.js";
import { registerWikiRetro } from "./lib/retro.js";
import { registerBackgroundRuntime } from "./lib/runtime.js";
import {
  loadTaskConfig,
  noticesEnabled,
  personalVaultIsAmbient,
  trajectoriesEnabled,
} from "./lib/task-config.js";
import {
  registerWikiBootstrap,
  registerWikiCaptureSource,
  registerWikiEnsurePage,
  registerWikiIngest,
  registerWikiLint,
  registerWikiLogEvent,
  registerWikiRebuildMeta,
  registerWikiReindex,
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
  migrateDoubledPersonalVault,
  resolveProjectVaultRoot,
  resolveVaultPaths,
} from "./lib/utils.js";
import { inspectWritableVault } from "./lib/vault-format.js";
import { applySessionStartStatus } from "./lib/visible-status.js";

/**
 * @zosmaai/pi-llm-wiki — LLM Wiki extension for Pi
 *
 * Registers 14 custom tools and installs guardrails (+3 agent-trajectory tools
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

  /**
   * Does a wiki apply to the directory this session is working in?
   *
   * Gates every AMBIENT surface — the ones that speak without being asked:
   * session bootstrap/notice, the periodic observe/retro reminder, and
   * `before_agent_start` recall injection. Tools and commands are registered
   * regardless, so `/wiki-init` remains the way in.
   *
   * `resolveVaultRoot` falls back to the personal vault when a project has
   * none, which is why the ambient surfaces used to fire in EVERY directory
   * once a personal vault existed — reminders and unrelated cross-project
   * recall hits leaking into repositories that never initialized a wiki.
   * Under omp that fallback is off by default (`llm-wiki.ambientPersonalVault`);
   * under pi it stays on, preserving the historical behavior.
   *
   * Resolved per call, not once at load: `cwd` changes within a session.
   */
  const wikiAppliesTo = (cwd: string): boolean =>
    resolveProjectVaultRoot(cwd) !== null || personalVaultIsAmbient(runtime.config);

  registerWikiBootstrap(pi);
  registerWikiCaptureSource(pi, runtime);
  registerWikiIngest(pi, runtime);
  registerWikiEnsurePage(pi, runtime);
  registerWikiSearch(pi);
  registerWikiLint(pi, runtime);
  registerWikiStatus(pi);
  registerWikiRebuildMeta(pi, runtime);
  registerWikiReindex(pi);
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
  // setting takes effect without a restart. `display: false` still injects the
  // reminder into model context, so the "no wiki here" case needs its own gate.
  registerObservationReminder(pi, reminderState, {
    display: () => noticesEnabled(runtime.config),
    enabled: () => wikiAppliesTo(process.cwd()),
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
        // INTENTIONALLY NOT gated by `noticesEnabled` (issues #77, #84): this is
        // a one-shot data-integrity recovery signal, not chat-noise. If the
        // user has a broken doubled-dotdir layout we want them to see that it
        // was fixed, even in quiet mode.
        ctx.ui.setStatus(
          "llm-wiki",
          `🧠 Personal wiki layout fixed: flattened ${migration.moved.length} entries out of ${migration.from} (see CHANGELOG)`,
        );
      }
    } catch (err) {
      // Never let migration crash session start.
      console.warn(`[llm-wiki] doubled-dotdir migration skipped: ${(err as Error).message}`);
    }

    // Ambient gate. `ensureConfig` first so an explicit
    // `llm-wiki.ambientPersonalVault` is honored on the very first session —
    // `runtime.config` is otherwise empty until the first `turn_start`.
    runtime.ensureConfig(process.cwd());
    if (!wikiAppliesTo(process.cwd())) return;

    const paths = resolveVaultPaths(process.cwd());
    if (!existsSync(join(paths.dotWiki, "config.json"))) {
      // Silently create the wiki vault — no UI prompts. Topic/mode will be
      // inferred from the user's first prompt via before_agent_start.
      const result = bootstrapVault(paths, { topic: "pending", mode: "personal" });
      if (!result.ok || !result.projection.ok) {
        ctx.ui.setStatus(
          "llm-wiki",
          `🧠 Wiki setup blocked: ${
            result.ok ? result.projection.diagnostics[0].message : result.diagnostics[0].message
          }`,
        );
        return;
      }

      needsTopicInference = true;
      // INTENTIONALLY NOT gated by `noticesEnabled` (issues #77, #84): one-shot
      // first-run setup signal. The user needs to know the wiki was just
      // auto-created, regardless of quiet mode.
      ctx.ui.setStatus("llm-wiki", "🧠 Wiki created (inferring topic from first prompt…)");
      return;
    }

    const writable = inspectWritableVault(paths);
    if (!writable.ok) {
      ctx.ui.setStatus("llm-wiki", `🧠 Wiki setup blocked: ${writable.diagnostics[0].message}`);
      return;
    }

    // Surface the "wiki active" badge and the active background task model
    // (issue #69), both gated by `llm-wiki.notices` (issue #77, regression
    // fixed in #83, helper extracted in #84). The `ensureConfig` above the
    // ambient gate already loaded the project settings this reads.
    applySessionStartStatus({
      ui: ctx.ui,
      runtime,
      trajectoriesOn,
      sessionModelId: (ctx.model as { id?: string })?.id,
    });

    // Fire-and-forget QMD index recovery. Generated-state repair only — it must
    // never block heuristic recall or the first-turn injection path.
    runtime.launchTask(ctx, `qmd-recovery:${paths.root}`, async () => {
      try {
        await recoverQmdIndex(paths);
      } catch (err) {
        console.warn(`[llm-wiki] QMD index recovery failed: ${(err as Error).message}`);
      }
    });

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
    if (!wikiAppliesTo(process.cwd())) return;

    const paths = resolveVaultPaths(process.cwd());
    if (!existsSync(join(paths.dotWiki, "config.json"))) {
      return;
    }

    const prompt = event.prompt || "";
    // Volatile, per-turn content (recall results + one-time topic-inference
    // directive) MUST NOT go into the system prompt (issue #92). The system
    // prompt is the provider's primary cache prefix; rewriting it every turn
    // (recall is keyed on event.prompt, so it differs each turn) invalidates
    // the whole prompt cache, forcing a full re-prompt-fill every turn. Collect
    // it here and deliver it as a tail conversation message instead, which
    // leaves the cached system-prompt prefix stable.
    let dynamicContext = "";

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

      dynamicContext += `

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
        const recallContext = formatRecallContext(results, {
          linksOnly,
          skillInlineMax: runtime.config?.recallSkillInlineMax,
        });
        if (recallContext) {
          dynamicContext += `\n\n${recallContext}`;
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

    // Split into a cache-stable system prompt (static footer only) and a
    // volatile tail message (issue #92). See lib/inject.ts for the contract.
    const priorSystemPrompt = normalizeSystemPrompt(event.systemPrompt);
    const { systemPrompt, message } = buildAgentStartInjection(priorSystemPrompt, [dynamicContext]);

    // Only claim a systemPrompt change when the footer actually altered the
    // string (a carry-forward turn already carries it, so this no-ops).
    const systemPromptChanged = systemPrompt !== priorSystemPrompt;
    if (!systemPromptChanged && !message) return;
    return {
      ...(systemPromptChanged ? { systemPrompt } : {}),
      ...(message ? { message } : {}),
    };
  });
}
