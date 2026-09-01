/**
 * /wiki-dashboard command tests.
 *
 * Read-only: the handler collects stats for cwd, then opens ONE persistent
 * screen through ui.custom(). The fake custom models pi's real contract:
 * the factory runs synchronously inside the promise executor and the
 * promise resolves only when the screen's close() is called.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { registerWikiDashboardCommand } from "../extensions/llm-wiki/lib/dashboard-command.js";

type Handler = (args: string, ctx: Record<string, unknown>) => Promise<void>;

interface Screen {
  handleInput(data: string): void;
  render(width: number): string[];
}

const tmpRoots: string[] = [];
const ESC = "\u001b";

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const fakePi = {
    registerCommand: (n: string, descriptor: { handler: Handler }) => {
      if (n === "wiki-dashboard") handler = descriptor.handler;
    },
  };
  registerWikiDashboardCommand(fakePi as never, { ensureConfig: () => {} } as never);
  expect(handler).toBeDefined();
  return handler!;
}

function makeCtx(cwd: string, hasUI: boolean) {
  const notifications: string[] = [];
  let screen: Screen | undefined;
  let closed = false;
  const ctx: Record<string, unknown> = {
    cwd,
    hasUI,
    ui: {
      notify: (message: string) => {
        notifications.push(String(message));
      },
      custom: (
        factory: (tui: unknown, theme: unknown, kb: unknown, close: () => void) => unknown,
      ) =>
        new Promise<unknown>((resolve) => {
          const done = () => {
            closed = true;
            resolve(screen);
          };
          screen = factory(null, {}, null, done) as Screen;
        }),
    },
  };
  return {
    ctx,
    notifications,
    get screen(): Screen | undefined {
      return screen;
    },
    get closed(): boolean {
      return closed;
    },
  };
}

/** Self-contained fixture vault (same shape as test/dashboard.test.ts). */
async function makeFixtureRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "llm-wiki-dashboard-cmd-"));
  tmpRoots.push(dir);
  const vault = path.join(dir, ".llm-wiki");
  const meta = path.join(vault, "meta");
  const wiki = path.join(vault, "wiki");
  const oldPkt = path.join(vault, "raw", "sources", "p1");
  for (const d of [
    meta,
    path.join(vault, "emb"),
    path.join(vault, "skills"),
    path.join(wiki, "concepts"),
    oldPkt,
  ]) {
    await mkdir(d, { recursive: true });
  }
  const daysAgo = (n: number) => {
    const t = new Date(Date.now() - n * 86400_000).getTime() / 1000;
    return [t, t] as const;
  };
  const a = path.join(wiki, "concepts", "a.md");
  await writeFile(a, "# a\n\nContent of page a.\n");
  await utimes(a, ...daysAgo(40));
  const b = path.join(wiki, "concepts", "b.md");
  await writeFile(b, "# b\n\nContent of page b.\n");
  await utimes(b, ...daysAgo(0));
  await writeFile(path.join(vault, "skills", "s.md"), "# s\n");
  await writeFile(path.join(oldPkt, "extracted.md"), "pkt\n");
  await writeFile(path.join(vault, "emb", "emb-1.bin"), "x");

  await writeFile(
    path.join(meta, "registry.json"),
    JSON.stringify({
      pages: {
        "concepts/a": {
          type: "concept",
          title: "a",
          status: "full",
          created: "2026-07-01",
          updated: "2026-07-01",
        },
        "concepts/b": {
          type: "concept",
          title: "b",
          status: "full",
          created: "2026-08-24",
          updated: "2026-08-25",
        },
        "skills/s": {
          type: "skill",
          title: "s",
          status: "full",
          created: "2026-08-20",
          updated: "2026-08-20",
        },
      },
    }),
  );
  await writeFile(
    path.join(meta, "backlinks.json"),
    JSON.stringify({ "concepts/a": [], "concepts/b": ["concepts/a"], "skills/s": ["skills/s"] }),
  );
  const events = [
    {
      timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
      kind: "observe",
      slug: "e1",
      title: "t1",
    },
  ];
  await writeFile(path.join(meta, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
  return dir;
}

afterAll(async () => {
  for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true });
});

describe("/wiki-dashboard command", () => {
  it("registers the wiki-dashboard command", () => {
    captureHandler();
  });

  it("renders sections with fixture values and closes on Esc", async () => {
    const dir = await makeFixtureRoot();
    const handler = captureHandler();
    const h = makeCtx(dir, true);
    const wait = handler("", h.ctx);
    // let collectDashboardStats (fs) settle so the factory has run
    for (let i = 0; i < 50 && !h.screen; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.screen).toBeDefined();
    const lines = h.screen!.render(120).join("\n");
    expect(lines).toContain("3"); // 3 pages
    expect(lines).toContain("concept 2");
    expect(lines).toContain("skill 1");
    expect(lines).toContain("stale");
    expect(lines).toContain("raw 1");
    expect(lines).toContain("zero-backlink 1");
    // Esc closes the screen, which resolves the handler.
    h.screen!.handleInput(ESC);
    await wait;
    expect(h.closed).toBe(true);
  });

  it("also closes on Escape under the kitty keyboard protocol (CSI-u form)", async () => {
    const dir = await makeFixtureRoot();
    const handler = captureHandler();
    const h = makeCtx(dir, true);
    const wait = handler("", h.ctx);
    for (let i = 0; i < 50 && !h.screen; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.screen).toBeDefined();
    // Ghostty et al. with kitty protocol v2 send bare Esc as CSI-u 27
    h.screen!.handleInput("\u001b[27u");
    await wait;
    expect(h.closed).toBe(true);
  });

  it("warns and opens no screen without a UI", async () => {
    const dir = await makeFixtureRoot();
    const handler = captureHandler();
    const h = makeCtx(dir, false);
    await handler("", h.ctx);
    expect(h.screen).toBeUndefined();
    expect(h.notifications.join("\n")).toContain("interactive");
  });
});
