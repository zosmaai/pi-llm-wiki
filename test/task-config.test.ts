import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTaskConfig,
  resolveWikilinkValidation,
  type TaskConfig,
} from "../extensions/llm-wiki/lib/task-config.js";

describe("resolveWikilinkValidation", () => {
  it("defaults to warn when unset/undefined", () => {
    expect(resolveWikilinkValidation(undefined)).toBe("warn");
    expect(resolveWikilinkValidation({})).toBe("warn");
  });

  it("returns an explicit valid mode", () => {
    for (const m of ["off", "warn", "strict", "normalize"] as const) {
      const config: TaskConfig = { wikilinkValidation: m };
      expect(resolveWikilinkValidation(config)).toBe(m);
    }
  });

  it("falls back to warn on an invalid value", () => {
    const config = { wikilinkValidation: "bogus" } as unknown as TaskConfig;
    expect(resolveWikilinkValidation(config)).toBe("warn");
  });

  it("reads wikilinkValidation from the llm-wiki settings namespace", () => {
    const project = mkdtempSync(join(tmpdir(), "wl-"));
    try {
      mkdirSync(join(project, ".omp"), { recursive: true });
      writeFileSync(
        join(project, ".omp", "settings.json"),
        JSON.stringify({ "llm-wiki": { wikilinkValidation: "strict" } }),
      );
      // The settings value must flow through readNamespacedConfig into TaskConfig.
      expect(resolveWikilinkValidation(loadTaskConfig(project))).toBe("strict");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
