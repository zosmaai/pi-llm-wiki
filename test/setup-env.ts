import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll } from "vitest";

/**
 * Hermeticity guard for the global settings layer.
 *
 * `loadTaskConfig` (and friends) resolve the user-level layer through
 * `getAgentDir()`, which honours `PI_CODING_AGENT_DIR`. Test files that
 * manage their own agent directory (host-compat, runtime, model-selection,
 * settings-command, synthesis-max-tokens) overwrite this per-test; running
 * their save/afterAll before this hook keeps that cycle intact. Files that
 * do not manage it (e.g. visible-activity, ambient-gate) would otherwise
 * read the DEVELOPER'S real `~/.pi/agent` or `~/.omp/agent` settings, whose
 * `llm-wiki` section (written legitimately by /wiki-settings) leaks plain
 * values into assertions. CI never trips this because runner HOME is empty;
 * this makes local runs behave the same.
 */
beforeAll(() => {
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "llm-wiki-test-agent-home");
});
