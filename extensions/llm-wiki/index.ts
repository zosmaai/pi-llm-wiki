import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installGuardrails } from "./lib/guardrails.js";
import { formatRecallContext, registerWikiRecall, searchWiki } from "./lib/recall.js";
import { registerWikiRetro } from "./lib/retro.js";
import {
  registerWikiBootstrap,
  registerWikiCaptureSource,
  registerWikiEnsurePage,
  registerWikiIngest,
  registerWikiLint,
  registerWikiLogEvent,
  registerWikiRebuildMeta,
  registerWikiSearch,
  registerWikiStatus,
  registerWikiWatch,
} from "./lib/tools.js";
import {
  ensureVaultStructure,
  fmtDate,
  getVaultPaths,
  resolveVaultPaths,
  writeJson,
} from "./lib/utils.js";

/**
 * @zosmaai/pi-llm-wiki — LLM Wiki extension for Pi
 *
 * Registers 11 custom tools and installs guardrails:
 * All 10 original tools + wiki_recall (auto-recall at session start)
 *
 * Guardrails:
 * - Blocks direct edits to raw/** and meta/**
 * - Auto-rebuilds metadata after wiki/** edits
 *
 * Auto-recall:
 * - before_agent_start hook searches wiki for pages relevant to user prompt
 * - Injects matching knowledge as system context
 * - wiki_recall tool available for explicit deep searches
 */

export default function (pi: ExtensionAPI) {
  registerWikiBootstrap(pi);
  registerWikiCaptureSource(pi);
  registerWikiIngest(pi);
  registerWikiEnsurePage(pi);
  registerWikiSearch(pi);
  registerWikiLint(pi);
  registerWikiStatus(pi);
  registerWikiRebuildMeta(pi);
  registerWikiLogEvent(pi);
  registerWikiWatch(pi);
  registerWikiRecall(pi);
  registerWikiRetro(pi);

  installGuardrails(pi);

  // Track if wiki was just auto-created and needs topic inference
  let needsTopicInference = false;

  pi.on("session_start", async (_event, ctx) => {
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

    ctx.ui.setStatus("llm-wiki", "🧠 LLM Wiki (12 tools, auto-recall active)");
  });

  // ─── Auto-recall + topic inference hook ─────────────
  // Before each agent turn:
  // 1. If wiki was just auto-created, inject a directive to infer topic/mode
  //    from the user's first prompt and update config via wiki_bootstrap.
  // 2. Search wiki for relevant pages and inject as system context.
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

    // Auto-recall: search wiki for relevant pages
    if (prompt.trim()) {
      const results = searchWiki(paths, prompt);
      if (results.length > 0) {
        const recallContext = formatRecallContext(results);
        if (recallContext) {
          injectedContext += `\n\n${recallContext}`;
        }
      }
    }

    if (injectedContext === event.systemPrompt) return;
    return { systemPrompt: injectedContext };
  });
}
