#!/usr/bin/env node
/**
 * Semantic version release script.
 * Usage: node scripts/release.js [patch|minor|major]
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("Usage: node scripts/release.js [patch|minor|major]");
  process.exit(1);
}

// Verify clean tree
const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
if (status) {
  console.error("Error: working tree is not clean");
  process.exit(1);
}

// Verify main branch
const branch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
if (branch !== "main") {
  console.error("Error: not on main branch");
  process.exit(1);
}

// Run checks
execSync("pnpm typecheck", { stdio: "inherit" });
execSync("pnpm lint", { stdio: "inherit" });
execSync("pnpm test", { stdio: "inherit" });

// Read current version
const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const current = pkg.version;
const releaseTags = execSync("git tag --merged HEAD --list 'v*' --sort=-version:refname", {
  encoding: "utf-8",
})
  .split(/\r?\n/)
  .map((tag) => tag.trim())
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
const latestTagVersion = releaseTags[0]?.slice(1) ?? current;
const [major, minor, patch] = latestTagVersion.split(".").map(Number);

let next;
if (bump === "major") next = `${major + 1}.0.0`;
else if (bump === "minor") next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

if (execSync(`git tag --list "v${next}"`, { encoding: "utf-8" }).trim()) {
  console.error(`Error: release tag v${next} already exists`);
  process.exit(1);
}

// Update package.json
pkg.version = next;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
const pluginPath = path.join(__dirname, "..", ".claude-plugin", "plugin.json");
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf-8"));
plugin.version = next;
fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`, "utf-8");

// Update CHANGELOG
const changelogPath = path.join(__dirname, "..", "CHANGELOG.md");
let changelog = "";
try {
  changelog = fs.readFileSync(changelogPath, "utf-8");
} catch {
  // CHANGELOG.md does not exist yet — start fresh.
}
const today = new Date().toISOString().split("T")[0];
const newSection = `## [${next}] - ${today}\n\n### Added\n- Release ${next}\n`;
if (changelog.includes("## [Unreleased]")) {
  changelog = changelog.replace("## [Unreleased]", `## [Unreleased]\n\n${newSection}`);
} else {
  changelog = `# Changelog\n\n## [Unreleased]\n\n${newSection}\n${changelog.replace("# Changelog\n\n", "")}`;
}
fs.writeFileSync(changelogPath, changelog, "utf-8");

execSync("git add package.json CHANGELOG.md .claude-plugin/plugin.json", { stdio: "inherit" });
execSync(`git commit -m "chore(release): v${next}"`, { stdio: "inherit" });
execSync(`git tag v${next}`, { stdio: "inherit" });
console.log(`\n✅ Committed and tagged v${next}`);
console.log("Push main and the tag; the existing release workflow publishes the package:");
console.log(`  git push origin main v${next}`);
