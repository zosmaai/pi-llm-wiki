import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installGuardrails } from "./lib/guardrails.js";
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

/**
 * @zosmaai/pi-llm-wiki — LLM Wiki extension for Pi
 *
 * Registers 10 custom tools and installs guardrails:
 * - wiki_bootstrap      Initialize a new vault
 * - wiki_capture_source Capture URL/file/text into source packet
 * - wiki_ingest         Get batch of sources needing synthesis
 * - wiki_ensure_page    Create canonical page from template
 * - wiki_search         Search generated registry
 * - wiki_lint           Health check with auto-fix
 * - wiki_status         Instant stats from registry
 * - wiki_rebuild_meta   Force metadata rebuild
 * - wiki_log_event      Append event and regenerate log
 * - wiki_watch          Schedule auto-updates
 *
 * Guardrails:
 * - Blocks direct edits to raw/** and meta/**
 * - Auto-rebuilds metadata after wiki/** edits
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

  installGuardrails(pi);

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("llm-wiki", "🧠 LLM Wiki (10 tools, guardrails active)");
  });
}
