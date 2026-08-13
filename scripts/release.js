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
const [major, minor, patch] = current.split(".").map(Number);

let next;
if (bump === "major") next = `${major + 1}.0.0`;
else if (bump === "minor") next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

// Update package.json
pkg.version = next;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");

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

// Tag the current commit (no commit — tags are the release source of truth)
execSync(`git tag v${next}`, { stdio: "inherit" });

console.log(`\n✅ Tagged v${next} at current HEAD`);
console.log("Run the following to publish:");
console.log(`  git push origin v${next}`);
