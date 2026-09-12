#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readStdin() {
  return new Promise((done) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => done(input));
  });
}

function projectVaultRoot(cwd) {
  const configured = process.env.WIKI_ROOT?.trim();
  if (configured) {
    const root = resolve(configured);
    return existsSync(join(root, ".llm-wiki", "config.json")) ? root : undefined;
  }

  const personalBase = process.env.WIKI_HOME || homedir();
  const personalRoots = new Set([
    resolve(join(personalBase, ".llm-wiki")),
    resolve(join(homedir(), ".llm-wiki")),
  ]);
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".llm-wiki");
    if (!personalRoots.has(resolve(candidate)) && existsSync(join(candidate, "config.json"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}

function noticesDisabled(root) {
  if (process.env.LLM_WIKI_NOTICES === "0") return true;
  for (const directory of [".pi", ".omp"]) {
    const settings = readJson(join(root, directory, "settings.json"));
    if (settings?.["llm-wiki"]?.notices === false) return true;
  }
  return false;
}

function vaultStats(root) {
  const vault = join(root, ".llm-wiki");
  const registry = readJson(join(vault, "meta", "registry.json")) ?? { pages: {} };
  const pages =
    registry.pages && typeof registry.pages === "object" && !Array.isArray(registry.pages)
      ? registry.pages
      : {};
  const sourceDir = join(vault, "raw", "sources");
  const packets = existsSync(sourceDir)
    ? readdirSync(sourceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("SRC-"))
        .map((entry) => entry.name)
    : [];
  const ingested = new Set(
    Object.entries(pages)
      .filter(([id, page]) => {
        const value = page && typeof page === "object" && !Array.isArray(page) ? page : {};
        return id.startsWith("sources/") && value.type === "source" && value.status !== "skeleton";
      })
      .map(([id]) => id.slice("sources/".length)),
  );
  return {
    indexedPages: Object.keys(pages).length,
    pendingSources: packets.filter((id) => !ingested.has(id)).length,
  };
}

const rawInput = await readStdin();
let event;
try {
  event = JSON.parse(rawInput || "{}");
} catch {
  process.exit(0);
}
if (!event || typeof event !== "object" || Array.isArray(event)) process.exit(0);
if (typeof event.cwd !== "string" || !event.cwd.trim()) process.exit(0);

const root = projectVaultRoot(event.cwd);
if (!root || noticesDisabled(root)) process.exit(0);

const stats = vaultStats(root);
const pending =
  stats.pendingSources === 0
    ? "No source packets are waiting for ingestion."
    : `Pending source packets: ${stats.pendingSources}.`;
const additionalContext = [
  `🧠 LLM Wiki active at ${root}.`,
  `Indexed pages: ${stats.indexedPages}.`,
  pending,
  "Use wiki_recall for relevant context, wiki_capture_source to preserve new material, and wiki_ingest to synthesize captured sources.",
  "Use wiki tools for .llm-wiki/raw and .llm-wiki/meta; those paths are immutable/generated.",
].join(" ");
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  }),
);
