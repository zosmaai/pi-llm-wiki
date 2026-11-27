import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTaskConfig, loadTaskConfigSources } from "../extensions/llm-wiki/lib/task-config.js";
import extension from "../extensions/llm-wiki/omp.js";

vi.mock("@earendil-works/pi-tui", () => {
  throw new Error("omp 19 rejects runtime imports of upstream pi-tui");
});

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

describe("omp native wiki commands", () => {
  let cwd: string;
  let commands: Map<string, Handler>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "wiki-omp-"));
    vi.stubEnv("LLM_WIKI_HOST", "omp");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
    commands = new Map();
    extension({
      on: () => {},
      registerTool: () => {},
      registerCommand: (name: string, command: { handler: Handler }) => {
        commands.set(name, command.handler);
      },
    } as unknown as ExtensionAPI);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it("persists a native picker selection and clears it through the session-model row", async () => {
    const model = { provider: "openai", id: "gpt-5" };
    const select = vi.fn(async (_title: string, items: string[]) => items[1]);
    const ctx = {
      cwd,
      hasUI: true,
      modelRegistry: { getAvailable: () => [model] },
      ui: { select, setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionCommandContext;

    const run = commands.get("wiki-model")!;
    await run("", ctx);
    expect(loadTaskConfig(cwd).taskModel).toEqual(model);

    select.mockImplementationOnce(async (_title, items) => items[0]);
    await run("", ctx);
    expect(loadTaskConfig(cwd).taskModel).toBeUndefined();
  });

  it("rejects an invalid setting and persists the corrected value to the selected scope", async () => {
    const weightRow = (_title: string, items: string[]) =>
      Promise.resolve(items.find((item) => item.startsWith("Semantic Weight:")));
    const select = vi
      .fn<(_title: string, items: string[]) => Promise<string | undefined>>()
      .mockImplementationOnce(async (_title, items) => items[0])
      .mockImplementationOnce(weightRow)
      .mockImplementationOnce(weightRow)
      .mockResolvedValueOnce(undefined);
    const input = vi.fn().mockResolvedValueOnce("2").mockResolvedValueOnce("0.25");
    const notify = vi.fn();
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, input, notify },
    } as unknown as ExtensionCommandContext;

    await commands.get("wiki-settings")!("", ctx);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('invalid value "2"'), "error");
    expect(loadTaskConfigSources(cwd).semanticWeight).toEqual({ source: "project", value: 0.25 });
  });
});
