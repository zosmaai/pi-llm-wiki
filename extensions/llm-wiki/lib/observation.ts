import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { scheduleReindex } from "./indexing.js";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import type { Runtime } from "./runtime.js";
import { type VaultPaths, fmtDate, resolveVaultPaths } from "./utils.js";

// ─── Types ─────────────────────────────────────────────

export interface ObservationInput {
  /** Short descriptive title (≤80 chars) */
  title: string;
  /** The observation content — what happened, was decided, or was learned */
  content: string;
  /** Relevance level for retention priority */
  relevance: "low" | "medium" | "high" | "critical";
  /** Optional space-separated tags for categorization */
  tags?: string;
  /** Context: what was being worked on when this was observed */
  source_context?: string;
}

export interface ObservationResult {
  slug: string;
  pagePath: string;
}

// ─── Save Observation ──────────────────────────────────

const RELEVANCE_EMOJIS: Record<string, string> = {
  low: "📝",
  medium: "🔍",
  high: "⭐",
  critical: "🔴",
};

/**
 * Save an observation as a wiki source page.
 *
 * Unlike wiki_retro (which saves atomic insights at task end),
 * wiki_observe records timestamped observations during a session
 * that can later be distilled into durable wiki pages.
 *
 * Observations are stored in wiki/sources/ with type: source and
 * status: observation. They are searchable via wiki_recail.
 */
export function saveObservation(
  paths: VaultPaths,
  input: ObservationInput,
  opts?: { rebuild?: boolean },
): ObservationResult {
  const today = fmtDate();
  const timestamp = new Date().toISOString();

  // Generate a slug from title
  const slugBase = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const slug = `obs-${today}-${slugBase}`;

  // Write to wiki/sources/{slug}.md
  const sourcePageDir = join(paths.wiki, "sources");
  mkdirSync(sourcePageDir, { recursive: true });
  const pagePath = join(sourcePageDir, `${slug}.md`);

  const relevanceEmoji = RELEVANCE_EMOJIS[input.relevance] ?? "📝";
  const tags = input.tags ?? "";
  const sourceContext = input.source_context ?? "";

  const pageContent = [
    "---",
    "type: source",
    `title: "Observation: ${input.title}"`,
    `slug: ${slug}`,
    "status: observation",
    `created: ${today}`,
    `updated: ${today}`,
    `relevance: ${input.relevance}`,
    `observed_at: ${timestamp}`,
    tags
      ? `tags: [${tags
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => `"${t}"`)
          .join(", ")}]`
      : "",
    sourceContext ? `source_context: "${sourceContext}"` : "",
    "---",
    "",
    `# ${relevanceEmoji} Observation: ${input.title}`,
    "",
    input.content,
    "",
    `*Relevance: ${input.relevance}*`,
    sourceContext ? `\n*Context: ${sourceContext}*` : "",
    tags ? `\n*Tags: ${tags}*` : "",
    "",
    "---",
    `*Observed: ${timestamp}*`,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  writeFileSync(pagePath, pageContent, "utf-8");

  // Log event
  appendEvent(paths, {
    kind: "observe",
    slug,
    title: input.title,
    relevance: input.relevance,
  });

  // Rebuild metadata so the observation is immediately searchable. Callers that
  // background this (the wiki_observe tool) pass { rebuild: false } and schedule
  // a non-blocking reindex instead.
  if (opts?.rebuild !== false) rebuildMetadataLight(paths);

  return { slug, pagePath };
}

// ─── Shared Reminder State ────────────────────────────

/**
 * Mutable state shared between wiki_observe tool and the turn-end reminder.
 * When the model calls wiki_observe, the tool sets observeDoneThisSession
 * so the reminder stops nagging.
 */
export interface ReminderState {
  observeDoneThisSession: boolean;
}

export function createReminderState(): ReminderState {
  return { observeDoneThisSession: false };
}

// ─── Tool Registration ─────────────────────────────────

/**
 * Register the `wiki_observe` tool.
 * The model calls this to record observations during a session.
 * Observations are saved to the wiki and become searchable.
 */
export function registerWikiObserve(
  pi: ExtensionAPI,
  runtime?: Runtime,
  reminderState?: ReminderState,
): void {
  pi.registerTool({
    name: "wiki_observe",
    label: "Wiki Observe",
    description:
      "Record an atomic observation from the current session into the wiki. " +
      "Observations are timestamped, relevance-rated facts about decisions made, " +
      "findings discovered, constraints established, or work completed. " +
      "Saved observations are searchable via wiki_recall and can later be " +
      "distilled into durable wiki pages via wiki_ensure_page. " +
      "Call this proactively after non-trivial work — every observation " +
      "compounds the wiki's knowledge across sessions.",
    promptSnippet: "Record an observation about the current work",
    promptGuidelines: [
      "Call wiki_observe after non-trivial decisions, discoveries, or completions.",
      "One observation per call. Use multiple calls for multiple observations.",
      "Rate relevance honestly — most observations are medium or low, not critical.",
      "Observations compound across sessions via wiki_recail.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description:
          "Short descriptive title (≤80 chars). Noun phrase, not a sentence. " +
          "Example: 'JWT auth middleware added' or 'Postgres migration constraint discovered'",
      }),
      content: Type.String({
        description:
          "The observation in plain prose. What happened, was decided, or was learned. " +
          "Preserve specific details: file paths, function names, error messages, " +
          "quantitative results. Example: 'User decided to use JWT with refresh tokens. " +
          "Implementation at src/auth/jwt.ts. Tests passing.'",
      }),
      relevance: Type.Union(
        [
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("critical"),
        ],
        {
          description:
            "Relevance level: low (routine), medium (task context), " +
            "high (non-trivial decisions/constraints), critical (user identity, " +
            "persistent preferences, completed work that must not be redone). " +
            "Default: medium. Be honest — most observations are medium or low.",
        },
      ),
      tags: Type.Optional(
        Type.String({
          description:
            "Optional space-separated tags for categorization. " +
            "Example: 'auth backend migration'",
        }),
      ),
      source_context: Type.Optional(
        Type.String({
          description:
            "What was being worked on. Example: 'Adding authentication module' or 'Debugging login timeout'",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = resolveVaultPaths(ctx.cwd ?? process.cwd());

      if (!existsSync(join(paths.dotWiki, "config.json"))) {
        return {
          content: [
            {
              type: "text",
              text: "No wiki vault found at this location. Initialize one with wiki_bootstrap first.",
            },
          ],
          details: { error: "no_vault" } as Record<string, unknown>,
          isError: true,
        };
      }

      const result = saveObservation(
        paths,
        {
          title: params.title,
          content: params.content,
          relevance: params.relevance,
          tags: params.tags,
          source_context: params.source_context,
        },
        // When a background runtime is available, write the page synchronously
        // but defer the O(pages) metadata rebuild + embeddings off the tool's
        // critical path. Without a runtime, fall back to the inline rebuild.
        { rebuild: !runtime },
      );
      if (runtime) {
        const launchCtx = { hasUI: ctx.hasUI, ui: ctx.ui };
        scheduleReindex(runtime, launchCtx, paths);
      }

      // Signal the reminder to stop nagging this session
      if (reminderState) {
        reminderState.observeDoneThisSession = true;
      }

      const relevanceEmoji = RELEVANCE_EMOJIS[params.relevance] ?? "📝";

      return {
        content: [
          {
            type: "text",
            text: [
              `${relevanceEmoji} **Observation saved**: ${params.title}`,
              "",
              `- Page: \`${result.pagePath}\``,
              `- Relevance: ${params.relevance}`,
              params.tags ? `- Tags: ${params.tags}` : "",
              "",
              "This observation is now searchable via wiki_recall. " +
                "It will compound with future observations across sessions.",
            ]
              .filter((l) => l !== "")
              .join("\n"),
          },
        ],
        details: {
          slug: result.slug,
          title: params.title,
          relevance: params.relevance,
          tags: params.tags || null,
        } as Record<string, unknown>,
      };
    },
  });
}

// ─── Turn-End Reminder ─────────────────────────────────

/**
 * Build the one-time, user-visible session notice (issue #77) that announces
 * the full wiki loop so the user can SEE the wiki is active and what it offers:
 *
 *   retrieval (sync, on the LLM's critical path): recall → search → read
 *   capture  (background + reported):              observe → retro
 *
 * Shown once per session when `notices` are enabled; silenced otherwise.
 */
export function buildSessionNotice(): string {
  return [
    "\u{1F9E0} **LLM Wiki active.**",
    "Retrieval (inline): recall runs automatically each turn — use `wiki_search` to query",
    "and `read` to open pages.",
    "Capture (background + reported): `wiki_observe` for timestamped notes,",
    "`wiki_retro` for durable insights. All other wiki actions run in the background and",
    "report when done. Silence these notices with `llm-wiki.notices: false`.",
  ].join(" ");
}

/**
 * Build the periodic observe/retro reminder text. Mentions BOTH capture tools
 * (issue #77): `wiki_observe` for timestamped session observations and
 * `wiki_retro` for distilled, durable insights at task end.
 */
export function buildReminderText(): string {
  return [
    "**Wiki capture reminder:** If the work in this session produced non-trivial",
    "decisions, findings, constraints, or completions worth preserving across sessions,",
    "record them now: call `wiki_observe` for timestamped observations, or `wiki_retro`",
    "to save a distilled insight. Both are searchable via `wiki_recall` and compound",
    "your wiki's knowledge over time.",
    "",
    "One item per call. Separate distinct findings into multiple calls.",
  ].join(" ");
}

/**
 * Track observation cadence and send turn-end reminders.
 * After every N significant turns, reminds the model to call wiki_observe
 * for non-trivial findings (same pattern as memex-retro reminders).
 *
 * `options.display` (issue #77) controls whether the reminder is shown to the
 * user (`true`, the default) or injected silently into model context only
 * (`false`). Pass a resolver so the live `notices` config is read at send time.
 */
export function registerObservationReminder(
  pi: ExtensionAPI,
  reminderState: ReminderState,
  options?: { turnsBetweenReminders?: number; display?: boolean | (() => boolean) },
): void {
  const REMINDER_INTERVAL = options?.turnsBetweenReminders ?? 5;
  const resolveDisplay = (): boolean => {
    const d = options?.display;
    if (typeof d === "function") return d();
    if (typeof d === "boolean") return d;
    return true;
  };
  let turnsSinceLastReminder = 0;

  pi.on("session_start", async () => {
    turnsSinceLastReminder = 0;
    reminderState.observeDoneThisSession = false;
  });

  // After compaction, reset the reminder state so reminders resume
  pi.on("session_compact", async () => {
    turnsSinceLastReminder = 0;
    reminderState.observeDoneThisSession = false;
  });

  pi.on("agent_end", async (_event, _ctx) => {
    turnsSinceLastReminder++;
    if (turnsSinceLastReminder < REMINDER_INTERVAL) return;
    if (reminderState.observeDoneThisSession) return;

    pi.sendMessage(
      {
        customType: "wiki-observe-reminder",
        content: buildReminderText(),
        display: resolveDisplay(),
      },
      {
        deliverAs: "nextTurn",
      },
    );
  });
}
