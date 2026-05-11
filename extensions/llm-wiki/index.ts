import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { getVaultPaths, resolveVaultRoot } from "./lib/utils.js";

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

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("llm-wiki", "🧠 LLM Wiki (11 tools, auto-recall active)");
  });

  // ─── Auto-recall hook ──────────────────────────────
  // Before each agent turn, search the wiki for pages relevant
  // to the user's prompt and inject them as system context.
  pi.on("before_agent_start", async (event, _ctx) => {
    const root = resolveVaultRoot(process.cwd());
    if (!existsSync(join(root, ".wiki", "config.json"))) {
      return; // No wiki vault — nothing to recall
    }

    const paths = getVaultPaths(root);
    const prompt = event.prompt || "";
    if (!prompt.trim()) return;

    const results = searchWiki(paths, prompt);
    if (results.length === 0) return;

    const context = formatRecallContext(results);
    if (!context) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${context}`,
    };
  });
}
