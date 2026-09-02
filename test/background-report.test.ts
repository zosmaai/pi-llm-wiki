import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { registerWikiLint, registerWikiRebuildMeta } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

type TestTool = {
  execute: (...args: unknown[]) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
  }>;
};

const root = join(import.meta.dirname, "..", "tmp", `background-report-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

function register(fn: (api: ExtensionAPI, runtime?: Runtime) => void, runtime: Runtime): TestTool {
  let tool: TestTool | undefined;
  fn(
    {
      registerTool: (definition: unknown) => {
        tool = definition as TestTool;
      },
    } as unknown as ExtensionAPI,
    runtime,
  );
  if (!tool) throw new Error("tool was not registered");
  return tool;
}

it("acknowledges background work, notifies instantly on completion, reports nextTurn", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Background report" }));
  writeFileSync(join(paths.wiki, "concepts", "valid.md"), "---\ntype: concept\n---\n\nValid.\n");

  const toasts: Array<{ message: string; level: string | undefined }> = [];
  const sent: Array<{ message: unknown; opts: { deliverAs?: string } }> = [];
  const runtime = new Runtime();
  runtime.pi = {
    sendMessage: (message: unknown, opts: { deliverAs?: string }) => sent.push({ message, opts }),
  } as unknown as ExtensionAPI;
  const fakeCtx = {
    cwd: root,
    hasUI: true,
    ui: {
      notify: (message: string, level?: string) => {
        toasts.push({ message, level });
      },
    },
  };

  // wiki_lint: background ack + instant toast + nextTurn report.
  const lint = register(registerWikiLint, runtime);
  const lintResult = await lint.execute("test", { auto_fix: false }, undefined, undefined, fakeCtx);
  expect(lintResult.isError).not.toBe(true);
  expect(lintResult.content[0].text).toContain("started in the background");
  expect(lintResult.content[0].text).toContain("with your next message");

  await runtime.awaitAll();
  expect(toasts).toEqual([{ message: "🧹 LLM Wiki lint complete", level: "info" }]);
  expect(sent).toHaveLength(1);
  expect(sent[0].opts.deliverAs).toBe("nextTurn");

  // wiki_rebuild_meta: same delivery contract.
  const rebuild = register(registerWikiRebuildMeta, runtime);
  const rebuildResult = await rebuild.execute("test", {}, undefined, undefined, fakeCtx);
  expect(rebuildResult.content[0].text).toContain("started in the background");
  expect(rebuildResult.content[0].text).toContain("with your next message");
  await runtime.awaitAll();
  expect(toasts).toHaveLength(2);
  expect(sent).toHaveLength(2);
});

it("skips the toast and nextTurn report when the work has no summary", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Background report" }));
  writeFileSync(join(paths.wiki, "concepts", "valid.md"), "---\ntype: concept\n---\n\nValid.\n");

  const toasts: Array<{ message: string; level: string | undefined }> = [];
  const sent: unknown[] = [];
  const runtime = new Runtime();
  runtime.pi = {
    sendMessage: (message: unknown) => sent.push(message),
  } as unknown as ExtensionAPI;
  runtime.launchReported(
    {
      hasUI: true,
      ui: {
        notify: (message: string, level?: string) => {
          toasts.push({ message, level });
        },
      },
    },
    "test:noop",
    async () => null,
  );
  await runtime.awaitAll();
  expect(toasts).toEqual([]);
  expect(sent).toEqual([]);
});

it("captures ctx before await so a stale ctx proxy cannot break completion (issue #142)", async () => {
  const toasts: Array<{ message: string; level: string | undefined }> = [];
  const sent: Array<{ message: unknown; opts: { deliverAs?: string } }> = [];
  const runtime = new Runtime();
  runtime.pi = {
    sendMessage: (message: unknown, opts: { deliverAs?: string }) => sent.push({ message, opts }),
  } as unknown as ExtensionAPI;

  // Simulate a stale extension ctx: property access throws once the
  // background work is running (as after newSession/fork/switchSession/reload).
  let stale = false;
  const staleCtx = {
    get hasUI() {
      if (stale) throw new Error("stale ctx proxy");
      return true;
    },
    get ui() {
      if (stale) throw new Error("stale ctx proxy");
      return {
        notify: (message: string, level?: string) => {
          toasts.push({ message, level });
        },
      };
    },
  };

  await runtime.launchReported(staleCtx, "test:stale", async () => {
    stale = true; // ctx goes stale while work is in flight
    return "✅ done";
  });
  await runtime.awaitAll();

  // Success toast still fires (captured before await) and no false failure toast.
  expect(toasts).toEqual([{ message: "✅ done", level: "info" }]);
  expect(sent).toHaveLength(1);
  expect(sent[0].opts.deliverAs).toBe("nextTurn");
});
