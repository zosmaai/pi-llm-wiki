import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rootDir } from "./helpers.js";

const script = join(rootDir, "scripts", "migrate-llm-wiki.js");
const roots: string[] = [];
const migratedPaths: Record<string, string> = {
  ".wiki/config.json": ".llm-wiki/config.json",
  ".wiki/templates/concept.md": ".llm-wiki/templates/concept.md",
  "raw/sources/SRC-OLD/extracted.md": ".llm-wiki/raw/sources/SRC-OLD/extracted.md",
  "raw/sources/SRC-OLD/original/input.txt": ".llm-wiki/raw/sources/SRC-OLD/original/input.txt",
  "wiki/concepts/legacy.md": ".llm-wiki/wiki/concepts/legacy.md",
  "meta/registry.json": ".llm-wiki/meta/registry.json",
  "outputs/report.md": ".llm-wiki/outputs/report.md",
  ".discoveries/state.json": ".llm-wiki/.discoveries/state.json",
  "WIKI_SCHEMA.md": ".llm-wiki/WIKI_SCHEMA.md",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = "pi llm wiki migration "): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runMigration(
  args: string[],
  cwd = rootDir,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function interruptAfterConfig(root: string): Promise<string> {
  const journalPath = join(root, ".wiki", "MIGRATION_TO_LLM_WIKI.json");
  const child = spawn(process.execPath, [script, root, "--force"], {
    cwd: rootDir,
    env: { ...process.env, LLM_WIKI_MIGRATION_PAUSE_AFTER: "config" },
    stdio: "pipe",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(journalPath)) {
      try {
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          completed?: string[];
        };
        if (journal.completed?.includes("config")) break;
      } catch {
        // The initial journal write is fsynced but not atomic; retry while it is incomplete.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(journalPath)).toBe(true);
  child.kill("SIGKILL");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  expect(exit.signal).toBe("SIGKILL");
  return journalPath;
}

function seedLegacy(root: string): void {
  mkdirSync(join(root, ".wiki", "templates"), { recursive: true });
  mkdirSync(join(root, "raw", "sources", "SRC-OLD", "original"), { recursive: true });
  mkdirSync(join(root, "wiki", "concepts"), { recursive: true });
  mkdirSync(join(root, "meta"), { recursive: true });
  mkdirSync(join(root, "outputs"), { recursive: true });
  mkdirSync(join(root, ".discoveries"), { recursive: true });
  writeFileSync(join(root, ".wiki", "config.json"), '{"name":"Legacy"}\n');
  writeFileSync(join(root, ".wiki", "templates", "concept.md"), "template bytes\n");
  writeFileSync(join(root, ".wiki", "extra.txt"), "leave in old marker directory\n");
  writeFileSync(join(root, "raw", "sources", "SRC-OLD", "extracted.md"), "raw bytes\n");
  writeFileSync(
    join(root, "raw", "sources", "SRC-OLD", "original", "input.txt"),
    "original bytes\n",
  );
  writeFileSync(
    join(root, "wiki", "concepts", "legacy.md"),
    "---\ntype: concept\nsources: sources/SRC-OLD\nunknown: keep\n---\n\nLegacy body.\n",
  );
  writeFileSync(join(root, "meta", "registry.json"), '{"pages":{}}\n');
  writeFileSync(join(root, "outputs", "report.md"), "report bytes\n");
  writeFileSync(join(root, ".discoveries", "state.json"), "discovery bytes\n");
  writeFileSync(join(root, "WIKI_SCHEMA.md"), "schema bytes\n");
}

function snapshot(root: string, directory = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(root, path));
    else if (entry.isFile()) {
      files[relative(root, path).replace(/\\/g, "/")] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    }
  }
  return files;
}

function assertMigrated(root: string, before: Record<string, string>): void {
  expect(statSync(join(root, ".llm-wiki", "config.json")).isFile()).toBe(true);
  expect(readFileSync(join(root, ".llm-wiki", "config.json"), "utf8")).toBe('{"name":"Legacy"}\n');
  expect(readFileSync(join(root, ".llm-wiki", "templates", "concept.md"), "utf8")).toBe(
    "template bytes\n",
  );
  expect(
    readFileSync(join(root, ".llm-wiki", "raw", "sources", "SRC-OLD", "extracted.md"), "utf8"),
  ).toBe("raw bytes\n");
  expect(readFileSync(join(root, ".llm-wiki", "wiki", "concepts", "legacy.md"), "utf8")).toContain(
    "unknown: keep",
  );
  expect(readFileSync(join(root, ".llm-wiki", "meta", "registry.json"), "utf8")).toBe(
    '{"pages":{}}\n',
  );
  expect(readFileSync(join(root, ".llm-wiki", "outputs", "report.md"), "utf8")).toBe(
    "report bytes\n",
  );
  expect(readFileSync(join(root, ".llm-wiki", ".discoveries", "state.json"), "utf8")).toBe(
    "discovery bytes\n",
  );
  expect(readFileSync(join(root, ".llm-wiki", "WIKI_SCHEMA.md"), "utf8")).toBe("schema bytes\n");
  expect(readFileSync(join(root, ".wiki", "extra.txt"), "utf8")).toBe(
    "leave in old marker directory\n",
  );
  expect(readFileSync(join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md"), "utf8")).toContain(
    "# Migration Complete",
  );
  const after = snapshot(root);
  for (const [source, destination] of Object.entries(migratedPaths)) {
    expect(after[destination], `${source} → ${destination}`).toBe(before[source]);
    expect(after[source], `${source} should be moved`).toBeUndefined();
  }
  expect(after[".wiki/extra.txt"]).toBe(before[".wiki/extra.txt"]);
  expect(existsSync(join(root, "raw"))).toBe(false);
  expect(existsSync(join(root, "wiki"))).toBe(false);
  expect(existsSync(join(root, "meta"))).toBe(false);
}

describe("migrate-llm-wiki CLI", () => {
  it.each(["absolute", "relative"] as const)(
    "dry-runs and applies a legacy migration through a %s path containing spaces",
    (pathMode) => {
      const root = tempRoot();
      seedLegacy(root);
      const cwd = pathMode === "relative" ? dirname(root) : rootDir;
      const rootArg = pathMode === "relative" ? basename(root) : root;
      const before = snapshot(root);

      const dryRun = runMigration([rootArg, "--dry-run"], cwd);
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(dryRun.stdout).toContain(`Scanning for legacy wiki at: ${root}`);
      expect(snapshot(root)).toEqual(before);

      const apply = runMigration(["--force", rootArg], cwd);
      expect(apply.status, apply.stderr).toBe(0);
      expect(apply.stdout).toContain("Migration complete");
      assertMigrated(root, before);

      const migrated = snapshot(root);
      const rerun = runMigration([rootArg, "--force"], cwd);
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(rerun.stdout).toContain("New-format wiki already exists");
      expect(snapshot(root)).toEqual(migrated);
    },
  );

  it("rejects any destination collision before moving legacy files", () => {
    const root = tempRoot();
    seedLegacy(root);
    mkdirSync(join(root, ".llm-wiki", "wiki"), { recursive: true });
    writeFileSync(join(root, ".llm-wiki", "wiki", "existing.md"), "destination bytes\n");
    const before = snapshot(root);

    const result = runMigration([root, "--force"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Migration blocked by destination conflicts");
    expect(result.stdout).toContain(".llm-wiki/wiki");
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, ".llm-wiki", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md"))).toBe(false);
  });

  it("never overwrites an existing forwarding marker", () => {
    const root = tempRoot();
    seedLegacy(root);
    writeFileSync(join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md"), "user-owned marker bytes\n");
    const before = snapshot(root);

    const result = runMigration([root, "--force"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Migration blocked by destination conflicts");
    expect(snapshot(root)).toEqual(before);
    expect(readFileSync(join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md"), "utf8")).toBe(
      "user-owned marker bytes\n",
    );
    expect(existsSync(join(root, ".llm-wiki", "config.json"))).toBe(false);
  });

  it.each([
    ["config", ".llm-wiki/config.json"],
    ["schema", ".llm-wiki/WIKI_SCHEMA.md"],
    ["forwarding marker", ".wiki/MIGRATED_TO_LLM_WIKI.md"],
  ] as const)("does not overwrite a raced %s destination", async (_label, racedPath) => {
    const root = tempRoot();
    seedLegacy(root);
    const before = snapshot(root);
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [script, root], {
      cwd: rootDir,
      stdio: "pipe",
    });
    let stdout = "";
    const confirmation = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("Proceed with migration?")) resolve();
      });
    });

    await confirmation;
    const racedDestination = join(root, racedPath);
    mkdirSync(dirname(racedDestination), { recursive: true });
    writeFileSync(racedDestination, "race winner\n");
    child.stdin.end("y\n");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(1);
    expect(readFileSync(racedDestination, "utf8")).toBe("race winner\n");
    const after = snapshot(root);
    for (const [source, destination] of Object.entries(migratedPaths)) {
      expect(after[source], `${source} should be restored`).toBe(before[source]);
      if (destination !== racedPath) {
        expect(after[destination], `${destination} should be rolled back`).toBeUndefined();
      }
    }
    if (racedPath !== ".wiki/MIGRATED_TO_LLM_WIKI.md") {
      expect(after[".wiki/MIGRATED_TO_LLM_WIKI.md"]).toBeUndefined();
    }
  });

  it("resumes an interrupted migration after SIGKILL without losing bytes", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot("pi interrupted migration ");
    seedLegacy(root);
    const before = snapshot(root);
    const journalPath = await interruptAfterConfig(root);
    expect(existsSync(join(root, ".wiki", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".llm-wiki", "config.json"))).toBe(true);

    const resumed = runMigration([root, "--force"]);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("Resuming interrupted migration");
    expect(existsSync(journalPath)).toBe(false);
    assertMigrated(root, before);
  });

  it("rolls a changed resumed destination back without discarding the journal early", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot("pi interrupted changed migration ");
    seedLegacy(root);
    const journalPath = await interruptAfterConfig(root);
    writeFileSync(join(root, ".llm-wiki", "config.json"), "concurrent writer bytes\n");

    const resumed = runMigration([root, "--force"]);

    expect(resumed.status).toBe(1);
    expect(readFileSync(join(root, ".llm-wiki", "config.json"), "utf8")).toBe(
      "concurrent writer bytes\n",
    );
    expect(existsSync(join(root, ".wiki", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".llm-wiki"))).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("rejects symlinked migration entries before creating a journal", () => {
    if (process.platform === "win32") return;
    const root = tempRoot("pi symlink migration ");
    seedLegacy(root);
    const link = join(root, "wiki", "concepts", "alias.md");
    symlinkSync("legacy.md", link);

    const result = runMigration([root, "--force"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Symlinked migration entries require manual migration");
    expect(readlinkSync(link)).toBe("legacy.md");
    expect(existsSync(join(root, ".wiki", "MIGRATION_TO_LLM_WIKI.json"))).toBe(false);
    expect(existsSync(join(root, ".llm-wiki"))).toBe(false);
  });

  it("does not replace a doubled-layout directory raced in after the final check", async () => {
    if (process.platform === "win32") return;
    const root = tempRoot("pi doubled directory race ");
    const outer = join(root, ".llm-wiki");
    const inner = join(outer, ".llm-wiki");
    mkdirSync(join(inner, "meta"), { recursive: true });
    writeFileSync(join(inner, "config.json"), '{"inner":true}\n');
    writeFileSync(join(inner, "meta", "registry.json"), "inner registry\n");
    const child = spawn(process.execPath, [script, "--fix-doubled", root, "--force"], {
      cwd: rootDir,
      env: { ...process.env, LLM_WIKI_MIGRATION_PAUSE_BEFORE_DOUBLED: "meta" },
      stdio: "pipe",
    });
    const pauseReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("migration did not reach the paused directory move"));
      }, 5_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("MOVE meta:")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await pauseReady;
    expect(existsSync(join(outer, "config.json"))).toBe(true);
    mkdirSync(join(outer, "meta"));
    child.stdin.end("continue\n");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(1);
    expect(readdirSync(join(outer, "meta"))).toEqual([]);
    expect(readFileSync(join(inner, "meta", "registry.json"), "utf8")).toBe("inner registry\n");
  }, 20_000);

  it("does not overwrite a doubled-layout entry raced in after confirmation", async () => {
    const root = tempRoot("pi doubled race ");
    const inner = join(root, ".llm-wiki", ".llm-wiki");
    mkdirSync(join(inner, "meta"), { recursive: true });
    writeFileSync(join(inner, "config.json"), '{"inner":true}\n');
    writeFileSync(join(inner, "meta", "registry.json"), "inner registry\n");
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [script, "--fix-doubled", root],
      { cwd: rootDir, stdio: "pipe" },
    );
    let stdout = "";
    const confirmation = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("Proceed with flatten?")) resolve();
      });
    });

    await confirmation;
    writeFileSync(join(root, ".llm-wiki", "config.json"), "race winner\n");
    child.stdin.end("y\n");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(0);
    expect(readFileSync(join(root, ".llm-wiki", "config.json"), "utf8")).toBe("race winner\n");
    expect(readFileSync(join(inner, "config.json"), "utf8")).toBe('{"inner":true}\n');
    expect(readFileSync(join(root, ".llm-wiki", "meta", "registry.json"), "utf8")).toBe(
      "inner registry\n",
    );
  });

  it("dry-runs and applies doubled-layout recovery without overwriting collisions", () => {
    const root = tempRoot("pi doubled migration ");
    const inner = join(root, ".llm-wiki", ".llm-wiki");
    mkdirSync(join(inner, "wiki", "sources"), { recursive: true });
    mkdirSync(join(inner, "meta"), { recursive: true });
    writeFileSync(join(inner, "config.json"), '{"inner":true}\n');
    writeFileSync(join(inner, "wiki", "sources", "note.md"), "inner page\n");
    writeFileSync(join(inner, "meta", "registry.json"), "inner registry\n");
    writeFileSync(join(root, ".llm-wiki", "config.json"), '{"outer":true}\n');
    const before = snapshot(root);

    const dryRun = runMigration(["--fix-doubled", root, "--dry-run"]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);

    const apply = runMigration(["--fix-doubled", root, "--force"]);
    expect(apply.status, apply.stderr).toBe(0);
    expect(readFileSync(join(root, ".llm-wiki", "config.json"), "utf8")).toBe('{"outer":true}\n');
    expect(readFileSync(join(inner, "config.json"), "utf8")).toBe('{"inner":true}\n');
    expect(readFileSync(join(root, ".llm-wiki", "wiki", "sources", "note.md"), "utf8")).toBe(
      "inner page\n",
    );
    expect(readFileSync(join(root, ".llm-wiki", "meta", "registry.json"), "utf8")).toBe(
      "inner registry\n",
    );
  });

  it("includes the advertised migration script in the npm package", () => {
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    expect(report[0].files.map((file) => file.path)).toContain("scripts/migrate-llm-wiki.js");
  }, 30_000);
});
