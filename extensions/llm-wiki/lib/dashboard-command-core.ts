import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { collectDashboardStats, type DashboardStats } from "./dashboard.js";
import type { Runtime } from "./runtime.js";

const TYPE_ORDER = [
  "concept",
  "entity",
  "source",
  "skill",
  "analysis",
  "synthesis",
  "requirement",
  "short",
  "shared",
];
const KIND_ORDER = ["observe", "retro", "synth", "intake"];

function orderedPairs(counts: Record<string, number>): string {
  const keys = Object.keys(counts);
  const known = TYPE_ORDER.filter((k) => counts[k] !== undefined);
  const rest = keys
    .filter((k) => !TYPE_ORDER.includes(k))
    .sort()
    .slice(0, 3); // cap the tail: the dashboard is a glance, not a census
  const all = [...known, ...rest];
  if (all.length === 0) return "—";
  return all.map((k) => `${k} ${counts[k]}`).join(" · ");
}

function orderedKinds(counts: Record<string, number>): string {
  const keys = Object.keys(counts);
  const known = KIND_ORDER.filter((k) => counts[k] !== undefined);
  const rest = keys
    .filter((k) => !KIND_ORDER.includes(k))
    .sort()
    .slice(0, 3);
  return [...known, ...rest].map((k) => `${k} ${counts[k]}`).join(" · ");
}

function renderStatsLines(s: DashboardStats): string[] {
  const emb = s.embEnabled ? `${s.embFiles}/${s.pageCount}` : "—";
  return [
    `Wiki Dashboard · ${s.root}`,
    "",
    `Pages   ${s.pageCount} · ${s.sizeKB}KB · ${orderedPairs(s.byType)}`,
    `Fresh   last touch ${s.lastTouch || "never"} · stale(>30d) ${s.staleCount}`,
    `Acts 7d ${s.last7dTotal > 0 ? orderedKinds(s.last7dByKind) : "none"} · total ${s.last7dTotal}/${s.totalEvents}`,
    `Queue   raw ${s.rawQueue} · emb ${emb}`,
    `Links   zero-backlink ${s.zeroBacklinks} · full scan: /wiki-lint`,
    "",
    "Esc to close",
  ];
}

export function registerDashboardCommand(
  pi: ExtensionAPI,
  runtime: Runtime,
  show: (ui: ExtensionCommandContext["ui"], lines: string[]) => Promise<void>,
): void {
  pi.registerCommand("wiki-dashboard", {
    description:
      "Show a read-only LLM Wiki dashboard (pages, freshness, activity, queue, links, emb)",
    handler: async (_args, ctx) => {
      runtime.ensureConfig(ctx.cwd);
      if (!ctx.hasUI) {
        ctx.ui.notify("LLM Wiki: /wiki-dashboard requires an interactive UI.", "warning");
        return;
      }
      await show(ctx.ui, renderStatsLines(await collectDashboardStats(ctx.cwd)));
    },
  });
}
