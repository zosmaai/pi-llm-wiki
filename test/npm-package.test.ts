import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { rootDir } from "./helpers.js";

describe("npm package boundary", () => {
  it("packs the runnable MCP server and Claude assets", () => {
    execFileSync("pnpm", ["build:mcp"], { cwd: rootDir, stdio: "ignore" });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    const report = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const packed = new Set(report[0].files.map(({ path }) => path.replaceAll("\\", "/")));
    for (const required of [
      "dist/mcp/index.js",
      "dist/package.json",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".claude-plugin/.mcp.json",
      ".claude-plugin/hooks/hooks.json",
      "scripts/claude-session-start.mjs",
      "scripts/guard-llm-wiki-edit.mjs",
      "hosts/codex.config.toml.example",
    ]) {
      expect(packed, required).toContain(required);
    }
  }, 60_000);
});
