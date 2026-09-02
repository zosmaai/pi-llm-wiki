// Regression tests for `wiki_watch` (issue #81).
//
// Three classes of bugs to lock down:
//   1. The emitted "schedule_prompt" instructions referred to a tool that
//      doesn't exist anywhere in pi or any pi extension. The tool now MUST
//      emit a real, copy-pasteable POSIX crontab line.
//   2. The generated payload contained the typo `/wiki:run`. The real
//      slash-command is `/wiki-run` — no colon.
//   3. The user-facing text and tool description claimed scheduling happens.
//      It does not — the tool only PRINTS instructions.
//
// Plus a robustness contract (global-cron portability):
//   4. 5-field POSIX schedule (not 6-field quartz/node-cron).
//   5. Executed under a login shell so the user's PATH (npm-global, bun,
//      nvm) is imported — cron's default PATH is only `/usr/bin:/bin`.
//   6. Log directory created defensively so cron doesn't fail-silent.
//   7. All `$HOME` references double-quoted so paths with spaces survive.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerWikiWatch } from "../extensions/llm-wiki/lib/tools.js";

interface CapturedTool {
  description: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

function captureWatchTool(): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool: (def: unknown) => {
      tool = def as CapturedTool;
    },
  } as unknown as ExtensionAPI;
  registerWikiWatch(pi);
  if (!tool) throw new Error("wiki_watch not registered");
  return tool;
}

async function run(interval: string) {
  const tool = captureWatchTool();
  return tool.execute("t1", { interval }, undefined, undefined, {});
}

describe("wiki_watch — issue #81 regressions", () => {
  it("never references the fictional `schedule_prompt` tool", async () => {
    for (const interval of ["daily", "weekly", "hourly", "stop"]) {
      const result = await run(interval);
      const text = result.content.map((c) => c.text).join("\n");
      expect(text, `interval=${interval}`).not.toMatch(/schedule_prompt/);
    }
  });

  it("never emits the `/wiki:run` typo — only `/wiki-run`", async () => {
    for (const interval of ["daily", "weekly", "hourly"]) {
      const result = await run(interval);
      const text = result.content.map((c) => c.text).join("\n");
      const details = JSON.stringify(result.details);
      expect(text, `text@${interval}`).not.toMatch(/\/wiki:run\b/);
      expect(details, `details@${interval}`).not.toMatch(/\/wiki:run\b/);
    }
  });

  it("description and output make it explicit that nothing is scheduled", async () => {
    const tool = captureWatchTool();
    expect(tool.description.toLowerCase()).toMatch(/print|return/);
    expect(tool.description.toLowerCase()).not.toMatch(/^schedule automatic wiki updates/i);

    const result = await run("weekly");
    const text = result.content.map((c) => c.text).join("\n");
    expect(text.toLowerCase()).toMatch(/only prints|does not install|not install/);
    expect(result.details.installed).toBe(false);
  });
});

describe("wiki_watch — crontab line portability (issue #81 follow-up)", () => {
  it("emits a valid 5-field POSIX crontab line invoking pi -p /wiki-run", async () => {
    const cases: Array<{ interval: string; cron: RegExp }> = [
      { interval: "daily", cron: /^0 8 \* \* \*$/ },
      { interval: "weekly", cron: /^0 9 \* \* 1$/ },
      { interval: "hourly", cron: /^0 \* \* \* \*$/ },
    ];
    for (const { interval, cron } of cases) {
      const result = await run(interval);
      const cronLine = result.details.cronLine as string | undefined;
      expect(cronLine, `cronLine for ${interval}`).toBeTypeOf("string");
      const fields = cronLine!.split(/\s+/).slice(0, 5).join(" ");
      expect(fields, `interval=${interval}`).toMatch(cron);
      expect(cronLine!).toMatch(/pi\s+-p\s+"\/wiki-run"/);
      expect(cronLine!).toMatch(/llm-wiki-autoupdate/);
    }
  });

  it("wraps the command in a login shell so PATH (npm-global / bun / nvm) is imported", async () => {
    for (const interval of ["daily", "weekly", "hourly"]) {
      const result = await run(interval);
      const cronLine = result.details.cronLine as string;
      expect(cronLine, `interval=${interval}`).toMatch(/\/bin\/bash\s+-lc\s+'/);
    }
  });

  it("creates the log directory defensively to avoid silent failure", async () => {
    const result = await run("daily");
    const cronLine = result.details.cronLine as string;
    expect(cronLine).toMatch(/mkdir\s+-p\s+"\$HOME\/\.llm-wiki"/);
  });

  it("quotes every $HOME reference so paths with spaces survive", async () => {
    const result = await run("daily");
    const cronLine = result.details.cronLine as string;
    let idx = cronLine.indexOf("$HOME");
    while (idx !== -1) {
      expect(cronLine[idx - 1], `$HOME at ${idx} not preceded by '"'`).toBe('"');
      idx = cronLine.indexOf("$HOME", idx + 1);
    }
  });

  it("rejects unknown intervals with isError=true", async () => {
    const result = await run("yearly");
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("bad_interval");
  });

  it("`stop` returns crontab removal instructions, not schedule_prompt", async () => {
    const result = await run("stop");
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toMatch(/crontab\s+-e/);
    expect(text).toMatch(/llm-wiki-autoupdate/);
    expect(result.details.action).toBe("stop_instructions");
  });
});
