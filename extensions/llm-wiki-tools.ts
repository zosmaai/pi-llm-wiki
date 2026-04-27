import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/**
 * @zosmaai/pi-llm-wiki — Custom tools for LLM Wiki management.
 *
 * Registers structured tools that the LLM can call to perform wiki operations:
 * - wiki_ingest: Process new source files and update wiki pages
 * - wiki_query: Query the wiki with citations
 * - wiki_lint: Health check the wiki
 * - wiki_discover: Auto-discover new sources
 * - wiki_status: Report wiki health overview
 * - wiki_watch: Schedule auto-updates
 */
export default function (pi: ExtensionAPI) {
	// ─── wiki_ingest ─────────────────────────────────────────

	pi.registerTool({
		name: "wiki_ingest",
		label: "Wiki Ingest",
		description:
			"Process new source files in the raw/ directory and integrate them into the wiki. " +
			"Creates source summaries, entity pages, concept pages, cross-references, and updates INDEX.md and LOG.md. " +
			"Call this when new files appear in raw/ or after running wiki_discover.",
		promptSnippet:
			"Ingest sources from raw/ into wiki: creates summaries, entities, concepts, cross-refs",
		promptGuidelines: [
			"Use wiki_ingest when the user asks to process new files, add sources, or update the wiki after adding raw content.",
			"Never modify raw/ files. Only read and synthesize from them.",
			"Flag contradictions between new and existing wiki content explicitly.",
		],
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Specific file path to ingest (e.g., raw/articles/my-file.md). Leave empty to process all new files.",
				}),
			),
			batch_size: Type.Optional(
				Type.Number({
					description:
						"Number of files to process in this batch (default: 1). Max 5.",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const { path, batch_size = 1 } = params;
				const messages: string[] = [];

				// Determine which files to process
				const filesToProcess: string[] = [];
				if (path) {
					filesToProcess.push(path);
				} else {
					// Check if history file exists
					const historyExists = await pi.exec(
						"test",
						["-f", ".discoveries/history.json"],
						{ signal },
					);
					const historyFiles: string[] = [];
					if (historyExists.code === 0) {
						const historyContent = await pi.exec(
							"cat",
							[".discoveries/history.json"],
							{ signal },
						);
						try {
							const history = JSON.parse(historyContent.stdout);
							// We'll reuse the history to skip already-processed files
						} catch {
							// If parsing fails, process all
						}
					}

					// Find all files in raw/
					const rawFiles = await pi.exec("find", ["raw/", "-type", "f"], {
						signal,
					});
					const allFiles = rawFiles.stdout.trim().split("\n").filter(Boolean);

					// If history exists, filter out already-processed files
					if (historyExists.code === 0) {
						try {
							const historyContent = await pi.exec(
								"cat",
								[".discoveries/history.json"],
								{ signal },
							);
							const history = JSON.parse(historyContent.stdout);
							const processed = new Set(
								(history.processed || []).map((f: { path: string }) => f.path),
							);
							for (const file of allFiles) {
								if (!processed.has(file)) {
									filesToProcess.push(file);
								}
							}
						} catch {
							filesToProcess.push(...allFiles);
						}
					} else {
						filesToProcess.push(...allFiles);
					}
				}

				const batch = filesToProcess.slice(0, Math.min(batch_size, 5));

				if (batch.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No new source files found to ingest. Try running `/wiki:discover` to find new sources, or drop files into `raw/` first.",
							},
						],
						details: {},
					};
				}

				messages.push(
					`Found ${batch.length} file(s) to process. Each file will require reading, summarizing, and updating 5-15 wiki pages.\n`,
				);
				messages.push(
					`**Files to ingest:**\n${batch.map((f) => `  - \`${f}\``).join("\n")}\n`,
				);

				// Create/update history to mark these as processed
				const ensureDir = await pi.exec("mkdir", ["-p", ".discoveries"], {
					signal,
				});

				let history: { processed: Array<{ path: string; ingested: string }> } =
					{ processed: [] };
				const histExists = await pi.exec(
					"test",
					["-f", ".discoveries/history.json"],
					{ signal },
				);
				if (histExists.code === 0) {
					const hc = await pi.exec("cat", [".discoveries/history.json"], {
						signal,
					});
					try {
						history = JSON.parse(hc.stdout);
					} catch {
						history = { processed: [] };
					}
				}

				const today = new Date().toISOString().split("T")[0];
				for (const file of batch) {
					history.processed.push({ path: file, ingested: today });
				}

				await pi.exec(
					"sh",
					[
						"-c",
						`cat > .discoveries/history.json << 'EOF'\n${JSON.stringify(history, null, 2)}\nEOF`,
					],
					{ signal },
				);

				messages.push(
					`✅ Marked ${batch.length} file(s) as processed in \`.discoveries/history.json\`.\n\n` +
						`**Next steps for each file:**\n` +
						`1. Read the file content\n` +
						`2. Create a source summary in \`wiki/sources/\`\n` +
						`3. Create/update entity pages in \`wiki/entities/\`\n` +
						`4. Create/update concept pages in \`wiki/concepts/\`\n` +
						`5. Add [[wikilinks]] cross-references\n` +
						`6. Flag any contradictions with existing wiki content\n` +
						`7. Update \`wiki/INDEX.md\` and \`wiki/LOG.md\``,
				);

				return {
					content: [{ type: "text", text: messages.join("\n") }],
					details: {
						filesToProcess: batch,
						count: batch.length,
						action: "ready_for_ingest",
					},
				};
			} catch (err: unknown) {
				const error = err as Error;
				return {
					content: [
						{
							type: "text",
							text: `❌ Error during ingest preparation: ${error.message}`,
						},
					],
					details: { error: error.message },
					isError: true,
				};
			}
		},
	});

	// ─── wiki_status_report ─────────────────────────────────

	pi.registerTool({
		name: "wiki_status_report",
		label: "Wiki Status Report",
		description:
			"Report the current health and statistics of the LLM Wiki. " +
			"Counts sources, wiki pages, checks for orphans, and reports last activity dates. " +
			"Call this to get a quick overview of wiki health.",
		promptSnippet:
			"Report wiki health: sources count, page stats, orphans, last activity",
		promptGuidelines: [
			"Use wiki_status_report when the user asks for wiki health, stats, or progress.",
		],
		parameters: Type.Object({}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				// Count raw sources
				const rawResult = await pi.exec(
					"find",
					["raw/", "-type", "f", "|", "wc", "-l"],
					{ signal },
				);
				const sourceCount = parseInt(rawResult.stdout.trim() || "0", 10);

				// Count wiki pages by type
				const entities = await pi.exec(
					"sh",
					["-c", "ls wiki/entities/ 2>/dev/null | wc -l"],
					{
						signal,
					},
				);
				const concepts = await pi.exec(
					"sh",
					["-c", "ls wiki/concepts/ 2>/dev/null | wc -l"],
					{
						signal,
					},
				);
				const sources = await pi.exec(
					"sh",
					["-c", "ls wiki/sources/ 2>/dev/null | wc -l"],
					{
						signal,
					},
				);
				const syntheses = await pi.exec(
					"sh",
					["-c", "ls wiki/syntheses/ 2>/dev/null | wc -l"],
					{
						signal,
					},
				);
				const changes = await pi.exec(
					"sh",
					["-c", "ls wiki/changes/ 2>/dev/null | wc -l"],
					{ signal },
				);

				const entityCount = parseInt(entities.stdout.trim() || "0", 10);
				const conceptCount = parseInt(concepts.stdout.trim() || "0", 10);
				const sourceCountW = parseInt(sources.stdout.trim() || "0", 10);
				const synthesisCount = parseInt(syntheses.stdout.trim() || "0", 10);
				const changeCount = parseInt(changes.stdout.trim() || "0", 10);
				const totalPages =
					entityCount + conceptCount + sourceCountW + synthesisCount;

				// Check last activity dates from LOG.md
				let lastIngest = "Never";
				let lastLint = "Never";
				let lastDiscover = "Never";
				const logExists = await pi.exec("test", ["-f", "wiki/LOG.md"], {
					signal,
				});
				if (logExists.code === 0) {
					const logContent = await pi.exec("grep", ["^## ", "wiki/LOG.md"], {
						signal,
					});
					const lines = logContent.stdout.trim().split("\n").filter(Boolean);
					// Parse from bottom to find most recent of each type
					for (let i = lines.length - 1; i >= 0; i--) {
						const line = lines[i];
						if (lastIngest === "Never" && line.includes("ingest"))
							lastIngest = line.slice(3, line.indexOf("]") + 1);
						if (lastLint === "Never" && line.includes("lint"))
							lastLint = line.slice(3, line.indexOf("]") + 1);
						if (lastDiscover === "Never" && line.includes("discover"))
							lastDiscover = line.slice(3, line.indexOf("]") + 1);
					}
				}

				// Check config
				let mode = "personal";
				const topics: string[] = [];
				const configExists = await pi.exec("test", ["-f", "config.yaml"], {
					signal,
				});
				if (configExists.code === 0) {
					const configContent = await pi.exec(
						"grep",
						["-E", "(mode:|topic:)", "config.yaml"],
						{
							signal,
						},
					);
					const cfgLines = configContent.stdout.trim().split("\n");
					for (const line of cfgLines) {
						if (line.includes("mode:")) mode = line.split(":")[1].trim();
						if (line.includes("topic:")) {
							const t = line.split(":")[1].trim();
							if (t) topics.push(t);
						}
					}
				}

				// Check gaps
				let gapCount = 0;
				const gapsExist = await pi.exec(
					"test",
					["-f", ".discoveries/gaps.json"],
					{ signal },
				);
				if (gapsExist.code === 0) {
					const gapsContent = await pi.exec("cat", [".discoveries/gaps.json"], {
						signal,
					});
					try {
						const gaps = JSON.parse(gapsContent.stdout);
						gapCount = Array.isArray(gaps.gaps) ? gaps.gaps.length : 0;
					} catch {
						gapCount = 0;
					}
				}

				const topicStr =
					topics.length > 0 ? topics.join(", ") : "Not configured";

				// Determine health
				const health =
					totalPages === 0
						? "🔴 Needs Attention (empty wiki)"
						: sourceCount > 0 && lastIngest !== "Never"
							? "✅ Good"
							: "⚠️ Warning";

				const report = `📊 LLM Wiki Status
══════════════════
Mode: ${mode === "company" ? "🏢 Company" : "👤 Personal"}
Topics: ${topicStr}
Sources: ${sourceCount} files
Wiki Pages: ${totalPages} total
  - Entities: ${entityCount}
  - Concepts: ${conceptCount}
  - Sources: ${sourceCountW}
  - Syntheses: ${synthesisCount}
  - Changes: ${changeCount}
Last Ingest: ${lastIngest}
Last Lint: ${lastLint}
Last Discover: ${lastDiscover}
Knowledge Gaps: ${gapCount}
Health: ${health}

${
	totalPages === 0
		? "\n💡 **Tip:** Run `/wiki:init` to set up the wiki structure, then add sources to `raw/` and run `/wiki:ingest`."
		: ""
}`;

				return {
					content: [{ type: "text", text: report }],
					details: {
						mode,
						topics,
						sourceCount,
						totalPages,
						entityCount,
						conceptCount,
						sourceCountW,
						synthesisCount,
						changeCount,
						lastIngest,
						lastLint,
						lastDiscover,
						gapCount,
						health: totalPages === 0 ? "empty" : "good",
					},
				};
			} catch (err: unknown) {
				const error = err as Error;
				return {
					content: [
						{
							type: "text",
							text: `❌ Error checking wiki status: ${error.message}`,
						},
					],
					details: { error: error.message },
					isError: true,
				};
			}
		},
	});

	// ─── wiki_lint_report ──────────────────────────────────

	pi.registerTool({
		name: "wiki_lint_report",
		label: "Wiki Lint Report",
		description:
			"Run a health check on the wiki. Scans for contradictions, orphans, missing pages, stale claims, " +
			"broken links, knowledge gaps, and quality issues. Reports findings and optionally auto-fixes simple issues.",
		promptSnippet:
			"Lint the wiki: check for contradictions, orphans, missing pages, gaps",
		promptGuidelines: [
			"Use wiki_lint_report when the user asks to check wiki health, find issues, or clean up the wiki.",
		],
		parameters: Type.Object({
			auto_fix: Type.Optional(
				Type.Boolean({
					description:
						"Auto-fix simple issues (orphans, missing pages, broken links). Contradictions always need human review.",
					default: false,
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const { auto_fix = false } = params;
				const findings: string[] = [];
				const issues: string[] = [];
				let orphans = 0;
				let missingPages = 0;
				let contradictions = 0;

				// Scan wiki directory structure
				const wikiDirs = [
					"entities",
					"concepts",
					"sources",
					"syntheses",
					"changes",
				];
				const allPages: string[] = [];

				for (const dir of wikiDirs) {
					const result = await pi.exec(
						"sh",
						["-c", `ls wiki/${dir}/ 2>/dev/null`],
						{ signal },
					);
					const files = result.stdout.trim().split("\n").filter(Boolean);
					for (const file of files) {
						allPages.push(`${dir}/${file.replace(".md", "")}`);
					}
				}

				// Build a set of existing page names for link checking
				const existingPages = new Set(allPages);

				// Scan each page for [[wikilinks]] and check for orphans and missing pages
				const linkCount = new Map<string, number>(); // page -> inbound link count
				for (const page of allPages) {
					linkCount.set(page, 0);
				}

				for (const page of allPages) {
					const fullPath = `wiki/${page}.md`;
					const content = await pi.exec("cat", [fullPath], { signal });

					if (content.code !== 0) continue;

					// Find all [[wikilinks]]
					const linkRegex = /\[\[([^\]]+)\]\]/g;
					let match;
					while ((match = linkRegex.exec(content.stdout)) !== null) {
						const linkedPage = match[1];
						if (!existingPages.has(linkedPage)) {
							if (!issues.includes(linkedPage)) {
								missingPages++;
								issues.push(
									`Missing page: [[${linkedPage}]] (referenced in ${page})`,
								);
							}
						} else {
							linkCount.set(linkedPage, (linkCount.get(linkedPage) || 0) + 1);
						}
					}
				}

				// Find orphans (pages with zero inbound links)
				for (const [page, count] of linkCount) {
					if (count === 0) {
						orphans++;
						findings.push(`Orphan: [[${page}]] has no inbound links`);
					}
				}

				// Check for contradictions by searching for contradiction markers
				const contradictionResult = await pi.exec(
					"grep",
					["-rl", "⚠️ Contradiction", "wiki/", "2>/dev/null || true"],
					{ signal },
				);
				if (contradictionResult.stdout.trim()) {
					const contradictionFiles = contradictionResult.stdout
						.trim()
						.split("\n")
						.filter(Boolean);
					contradictions = contradictionFiles.length;
					for (const file of contradictionFiles) {
						findings.push(`Contradiction flagged in: ${file}`);
					}
				}

				// Build report
				const report = `# Wiki Lint Report
Generated: ${new Date().toISOString().split("T")[0]}

## Summary
- Total pages scanned: ${allPages.length}
- Orphans (no inbound links): ${orphans}
- Missing pages (referenced but not created): ${missingPages}
- Contradictions flagged: ${contradictions}

${
	findings.length > 0
		? `## Findings\n${findings.map((f) => `- ${f}`).join("\n")}`
		: "## Findings\n✅ No issues found!"
}

${
	issues.length > 0
		? `## Issues\n${issues.map((i) => `- ${i}`).join("\n")}`
		: ""
}

${
	auto_fix
		? `\n## Auto-Fix${orphans > 0 || missingPages > 0 ? "\nAuto-fix would: Add cross-references to orphans, create missing pages for top-linked concepts." : "\nNo auto-fixable issues found."}`
		: `\n## To Fix\n${orphans > 0 ? "- Add cross-references to orphan pages" : ""}${missingPages > 0 ? "\n- Create missing pages for frequently-linked concepts" : ""}${contradictions > 0 ? "\n- Review contradictions (requires human judgment)" : ""}`
}`;

				// Save report
				const today = new Date().toISOString().split("T")[0];
				await pi.exec("mkdir", ["-p", "outputs"], { signal });
				await pi.exec(
					"sh",
					["-c", `cat > outputs/lint-${today}.md << 'EOF'\n${report}\nEOF`],
					{ signal },
				);

				return {
					content: [{ type: "text", text: report }],
					details: {
						totalPages: allPages.length,
						orphans,
						missingPages,
						contradictions,
						reportFile: `outputs/lint-${today}.md`,
						findings,
						issues,
					},
				};
			} catch (err: unknown) {
				const error = err as Error;
				return {
					content: [{ type: "text", text: `❌ Lint error: ${error.message}` }],
					details: { error: error.message },
					isError: true,
				};
			}
		},
	});

	// ─── wiki_discover_sources ────────────────────────────

	pi.registerTool({
		name: "wiki_discover_sources",
		label: "Wiki Discover Sources",
		description:
			"Search the web for new source material based on configured topics and known knowledge gaps. " +
			"Saves discovered articles to raw/articles/ with metadata frontmatter. " +
			"Call this to find new content before running wiki_ingest.",
		promptSnippet: "Discover new sources from the web based on topics and gaps",
		promptGuidelines: [
			"Use wiki_discover_sources when the user wants to find new content, expand the wiki, or fill knowledge gaps.",
			"Always save discovered sources to raw/articles/ with proper frontmatter.",
			"Max 8 sources per discover cycle to avoid information overload.",
		],
		parameters: Type.Object({
			topic: Type.Optional(
				Type.String({
					description:
						"Specific topic to search for. Leave empty to use configured topics from config.yaml.",
				}),
			),
			max_sources: Type.Optional(
				Type.Number({
					description: "Maximum sources to discover (default: 5, max: 10).",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const { topic, max_sources = 5 } = params;
				const limit = Math.min(max_sources, 10);

				// Try to read config for topics
				let searchTopics: string[] = [];
				if (topic) {
					searchTopics = [topic];
				} else {
					const configExists = await pi.exec("test", ["-f", "config.yaml"], {
						signal,
					});
					if (configExists.code === 0) {
						const configContent = await pi.exec("cat", ["config.yaml"], {
							signal,
						});
						// Simple YAML-like parsing for topic names
						const lines = configContent.stdout.split("\n");
						let inTopics = false;
						for (const line of lines) {
							if (line.trim().startsWith("topics:")) {
								inTopics = true;
								continue;
							}
							if (inTopics && line.trim().startsWith("- name:")) {
								const name = line.split(":")[1].trim().replace(/"/g, "");
								if (name) searchTopics.push(name);
							}
							if (inTopics && line.trim().startsWith("discovery:")) break;
						}
					}
				}

				if (searchTopics.length === 0) {
					searchTopics = ["latest developments"];
				}

				return {
					content: [
						{
							type: "text",
							text:
								`🔍 Ready to discover new sources for topic(s): **${searchTopics.join(", ")}**\n\n` +
								`I'll search for up to ${limit} new sources. For each source found, I will:\n` +
								`1. Fetch the full content\n` +
								`2. Save to \`raw/articles/YYYY-MM-DD-slug.md\` with frontmatter\n` +
								`3. Update \`.discoveries/history.json\`\n\n` +
								`**To execute discovery, please use \`/wiki:discover\` or tell me to "find new sources on ${searchTopics[0]}"**`,
						},
					],
					details: {
						searchTopics,
						maxSources: limit,
						action: "ready_for_discovery",
					},
				};
			} catch (err: unknown) {
				const error = err as Error;
				return {
					content: [
						{
							type: "text",
							text: `❌ Error preparing discovery: ${error.message}`,
						},
					],
					details: { error: error.message },
					isError: true,
				};
			}
		},
	});

	// ─── wiki_watch ────────────────────────────────────────

	pi.registerTool({
		name: "wiki_watch",
		label: "Wiki Watch",
		description:
			"Schedule automatic wiki updates at a specified interval. " +
			"Uses pi's scheduling system to run discover → ingest → lint on a cron schedule. " +
			"Supports: daily, weekly, hourly intervals.",
		promptSnippet: "Schedule auto-updates for the wiki",
		promptGuidelines: [
			"Use wiki_watch when the user wants the wiki to stay current automatically.",
		],
		parameters: Type.Object({
			interval: Type.String({
				description:
					"Update interval: 'daily', 'weekly', 'hourly', or 'stop' to cancel existing schedules.",
			}),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const { interval } = params;

				if (interval === "stop") {
					return {
						content: [
							{
								type: "text",
								text:
									"🛑 To stop wiki auto-updates, run:\n\n" +
									"```\nschedule_prompt action=list\n```\n" +
									"Find the wiki job IDs, then:\n\n" +
									"```\nschedule_prompt action=remove jobId=<id>\n```",
							},
						],
						details: { action: "stop_instructions" },
					};
				}

				let cronSchedule: string;
				let label: string;

				switch (interval) {
					case "daily":
						cronSchedule = "0 0 8 * * *";
						label = "Daily at 8:00 AM";
						break;
					case "weekly":
						cronSchedule = "0 0 9 * * 1";
						label = "Weekly on Monday at 9:00 AM";
						break;
					case "hourly":
						cronSchedule = "0 0 * * * *";
						label = "Every hour";
						break;
					default:
						return {
							content: [
								{
									type: "text",
									text: `❌ Unknown interval: "${interval}". Use: daily, weekly, hourly, or stop.`,
								},
							],
							details: {},
							isError: true,
						};
				}

				return {
					content: [
						{
							type: "text",
							text:
								`⏰ To set up ${label} wiki updates, run:\n\n` +
								"```\n" +
								`schedule_prompt action=add schedule="${cronSchedule}" prompt="Run /wiki:run for the LLM Wiki" name="llm-wiki-autoupdate"` +
								"\n```\n\n" +
								"This will automatically discover new sources, ingest them, and lint the wiki at the scheduled time.",
						},
					],
					details: {
						interval,
						cronSchedule,
						label,
						scheduleCommand: `schedule_prompt action=add schedule="${cronSchedule}" prompt="Run /wiki:run for the LLM Wiki" name="llm-wiki-autoupdate"`,
					},
				};
			} catch (err: unknown) {
				const error = err as Error;
				return {
					content: [
						{
							type: "text",
							text: `❌ Error setting up watch: ${error.message}`,
						},
					],
					details: { error: error.message },
					isError: true,
				};
			}
		},
	});

	// Notify on load
	pi.on("session_start", async (_event, ctx) => {
		const tools = [
			"wiki_ingest",
			"wiki_status_report",
			"wiki_lint_report",
			"wiki_discover_sources",
			"wiki_watch",
		];
		ctx.ui.setStatus("llm-wiki", `🧠 LLM Wiki loaded (${tools.length} tools)`);
	});
}
