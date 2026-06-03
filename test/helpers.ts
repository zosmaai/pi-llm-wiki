import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __fname = typeof __filename !== "undefined" ? __filename : "";
const __dname =
  typeof __dirname !== "undefined"
    ? __dirname
    : typeof import.meta !== "undefined" && import.meta.dirname
      ? import.meta.dirname
      : dirname(fileURLToPath(__fname || `file://${process.cwd()}/test/dummy.ts`));

export const rootDir = resolve(__dname, "..");

export function readFile(path: string): string {
  return readFileSync(path, { encoding: "utf-8" });
}

export function createWikiRoot(baseDir: string): string {
  const dir = join(baseDir, `wiki-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  const llmWiki = join(dir, ".llm-wiki");
  const dirs = [
    "raw/articles",
    "raw/papers",
    "raw/notes",
    "raw/assets",
    "wiki/entities",
    "wiki/concepts",
    "wiki/sources",
    "wiki/syntheses",
    "wiki/changes",
    "meta",
    "outputs",
    ".discoveries",
  ];
  for (const d of dirs) mkdirSync(join(llmWiki, d), { recursive: true });

  return dir;
}

export function createConfig(dir: string, overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    wiki: { mode: "personal", topic: "Test Topic" },
    change_detection: false,
  };
  const config = { ...defaults, ...overrides } as Record<string, Record<string, unknown>>;
  const mode = config.wiki?.mode || "personal";
  const topic = config.wiki?.topic || "Test Topic";
  writeFileSync(
    join(dir, ".llm-wiki", "config.yaml"),
    `# LLM Wiki Configuration\nwiki:\n  mode: ${mode}\n  topic: "${topic}"\n`,
  );
}

export function createSourceFile(dir: string, name: string, content: string) {
  writeFileSync(join(dir, ".llm-wiki", "raw", "articles", name), content);
}

export function createWikiPage(dir: string, subdir: string | "", name: string, content: string) {
  const target = subdir
    ? join(dir, ".llm-wiki", "wiki", subdir, name)
    : join(dir, ".llm-wiki", "wiki", name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function mockPiWithMarkItDown(markdownOutput: string) {
  return {
    exec: async (command: string, args: string[]) => {
      if (command === "sh") {
        const cmd = args[1] ?? "";
        if (cmd.includes("which uvx")) return { stdout: "yes\n", stderr: "", code: 0 };
        if (cmd.includes("markitdown")) return { stdout: markdownOutput, stderr: "", code: 0 };
      }
      if (command === "cp") return { stdout: "", stderr: "", code: 0 };
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

export function mockPi(stdout?: string, writeOriginal = true) {
  const html = "<html><head><title>Example Page</title></head><body>Hello</body></html>";
  return {
    exec: async (command: string, args: string[]) => {
      if (command === "sh") return { stdout: "no\n", stderr: "", code: 0 };
      if (command === "curl" && args.includes("-o")) {
        if (writeOriginal) {
          const outputPath = args[args.indexOf("-o") + 1];
          writeFileSync(outputPath, stdout ?? html, "utf-8");
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "curl") return { stdout: stdout ?? html, stderr: "", code: 0 };
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}
