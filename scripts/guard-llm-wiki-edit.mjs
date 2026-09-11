#!/usr/bin/env node
// Claude Code PreToolUse guard: deny Write|Edit calls that target
// .llm-wiki/raw/** or .llm-wiki/meta/** (generated/authoritative state).
// Reads the hook input JSON on stdin; allow = exit 0 with no output,
// deny = exit 0 with the documented PreToolUse deny response.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const filePath = input.tool_input?.file_path ?? "";
if (/(^|[/\\])\.llm-wiki[/\\](raw|meta)([/\\]|$)/.test(filePath)) {
  process.stdout.write(
    JSON.stringify({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Blocked direct edit of ${filePath}. This is generated wiki state — use the wiki tools (wiki_ensure_page, wiki_retro, wiki_observe, wiki_log_event, wiki_ingest) so metadata stays consistent.`,
    }),
  );
}
process.exit(0);
