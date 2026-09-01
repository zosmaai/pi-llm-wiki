/**
 * Unit tests for lib/dashboard.ts (collectDashboardStats, pure fs reads).
 * Fixture vault uses the new layout: <dir>/.llm-wiki/{wiki,meta,raw,emb,skills}.
 * Mixed ages, registry types, zero-backlink pages, an events stream with an
 * out-of-window line and a corrupted line, one raw source packet, one emb file.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectDashboardStats } from "../extensions/llm-wiki/lib/dashboard.js";

const tmpRoots: string[] = [];

function track(dir: string) {
  tmpRoots.push(dir);
  return dir;
}

async function makeRoot(): Promise<string> {
  const dir = track(await mkdtemp(path.join(tmpdir(), "llm-wiki-dashboard-")));
  const vault = path.join(dir, ".llm-wiki");
  const wiki = path.join(vault, "wiki");
  const oldPkt = path.join(vault, "raw", "sources", "p1");
  for (const d of [
    path.join(vault, "meta"),
    path.join(vault, "emb"),
    path.join(vault, "skills"),
    path.join(wiki, "concepts"),
    path.join(wiki, "sources"),
    oldPkt,
  ]) {
    await mkdir(d, { recursive: true });
  }
  const daysAgo = (n: number) => {
    const t = new Date(Date.now() - n * 86400_000).getTime() / 1000;
    return [t, t] as const;
  };
  for (const [rel, ageDays] of [
    ["wiki/concepts/a.md", 40],
    ["wiki/concepts/b.md", 0],
    ["wiki/sources/s1.md", 5],
  ] as const) {
    const p = path.join(vault, rel);
    await writeFile(p, "# page\ncontent here\n");
    await utimes(p, ...daysAgo(ageDays));
  }
  // skill page lives under <root>/.llm-wiki/skills (registered as type:skill)
  const skill = path.join(vault, "skills", "s.md");
  await writeFile(skill, "# skill\n");
  await utimes(skill, ...daysAgo(5));

  await writeFile(path.join(oldPkt, "extracted.md"), "extracted source packet body\n");
  await writeFile(path.join(vault, "emb", "emb-1.bin"), "bin");

  await writeFile(
    path.join(vault, "meta", "registry.json"),
    JSON.stringify({
      version: "1.0",
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
        "sources/s1": {
          type: "source",
          title: "s1",
          status: "stub",
          created: "2026-08-20",
          updated: "2026-08-20",
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
    path.join(vault, "meta", "backlinks.json"),
    JSON.stringify({
      "concepts/a": [],
      "concepts/b": ["concepts/a"],
      "sources/s1": [],
      "skills/s": ["skills/s", "sources/s1"],
    }),
  );
  const events = [
    {
      timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
      kind: "observe",
      slug: "e1",
      title: "t1",
    },
    {
      timestamp: new Date(Date.now() - 3 * 86400_000).toISOString(),
      kind: "retro",
      slug: "e2",
      title: "t2",
    },
    {
      timestamp: new Date(Date.now() - 20 * 86400_000).toISOString(),
      kind: "observe",
      slug: "e3",
      title: "old",
    },
  ];
  const good = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(path.join(vault, "meta", "events.jsonl"), [good, 'broken": true'].join("\n"));
  return dir;
}

afterAll(async () => {
  for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true });
});

describe("collectDashboardStats", () => {
  it("counts pages (wiki + skills dirs) and types from the registry", async () => {
    const dir = await makeRoot();
    const s = await collectDashboardStats(dir);
    expect(s.pageCount).toBe(4);
    expect(s.byType).toEqual({ concept: 2, source: 1, skill: 1 });
    expect(s.sizeKB).toBeGreaterThan(0);
  });

  it("computes freshness: latest touch within 5m, one page stale beyond 30d", async () => {
    const dir = await makeRoot();
    const s = await collectDashboardStats(dir);
    expect(s.lastTouch).toBe("now");
    expect(s.staleCount).toBe(1); // concepts/a.md at 40d
  });

  it("parses events window: recent 2 by kind, total 3, skips a corrupted line", async () => {
    const dir = await makeRoot();
    const s = await collectDashboardStats(dir);
    expect(s.last7dByKind).toEqual({ observe: 1, retro: 1 });
    expect(s.last7dTotal).toBe(2);
    expect(s.totalEvents).toBe(3);
  });

  it("counts raw-source queue, zero-backlink pages, and emb coverage", async () => {
    const dir = await makeRoot();
    const s = await collectDashboardStats(dir);
    expect(s.rawQueue).toBe(1);
    expect(s.zeroBacklinks).toBe(2); // concepts/a + sources/s1
    expect(s.embFiles).toBe(1);
    expect(s.embEnabled).toBe(true);
  });
});

describe("collectDashboardStats on an empty vault", () => {
  it("returns zeros without throwing", async () => {
    const dir = track(await mkdtemp(path.join(tmpdir(), "llm-wiki-dash-empty-")));
    // empty new-layout skeleton: root contains .llm-wiki/ but no content
    await mkdir(path.join(dir, ".llm-wiki"), { recursive: true });
    const s = await collectDashboardStats(dir);
    expect(s.pageCount).toBe(0);
    expect(s.staleCount).toBe(0);
    expect(s.last7dTotal).toBe(0);
    expect(s.rawQueue).toBe(0);
    expect(s.embEnabled).toBe(false);
    expect(s.zeroBacklinks).toBe(0);
  });
});
