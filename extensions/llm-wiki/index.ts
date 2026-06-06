import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installGuardrails } from "./lib/guardrails.js";
import {
  createReminderState,
  registerObservationReminder,
  registerWikiObserve,
} from "./lib/observation.js";
import { formatRecallContext, registerWikiRecall, searchWikiHybrid } from "./lib/recall.js";
import { registerWikiRetro } from "./lib/retro.js";
import { registerBackgroundRuntime } from "./lib/runtime.js";
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
 * Registers 12 custom tools and installs guardrails:
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
  registerWikiCaptureSource(pi);
  registerWikiIngest(pi, runtime);
  registerWikiEnsurePage(pi, runtime);
  registerWikiSearch(pi);
  registerWikiLint(pi);
  registerWikiStatus(pi);
  registerWikiRebuildMeta(pi);
  registerWikiReindexEmbeddings(pi, runtime);
  registerWikiLogEvent(pi);
  registerWikiWatch(pi);
  registerWikiRecall(pi, runtime);
  registerWikiRetro(pi);
  const reminderState = createReminderState();
  registerWikiObserve(pi, reminderState);
  registerObservationReminder(pi, reminderState);

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

    ctx.ui.setStatus("llm-wiki", "🧠 LLM Wiki (13 tools, observe + recall active)");
  });

  // ─── Layered recall + topic inference hook ──────────
  // Before each agent turn:
  // 1. If wiki was just auto-created, inject a directive to infer topic/mode
  //    from the user's first prompt and update config via wiki_bootstrap.
  // 2. Search both personal + project vaults for relevant pages.
  pi.on("before_agent_start", async (event, _ctx) => {
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
        const recallContext = formatRecallContext(results);
        if (recallContext) {
          injectedContext += `\n\n${recallContext}`;
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
