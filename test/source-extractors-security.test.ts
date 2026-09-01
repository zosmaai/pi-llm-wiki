/**
 * TDD for #185 — OS Command Injection via wiki_capture_source
 *
 * Verifies that attacker-controlled url/filePath is NOT interpolated into `sh -c`
 * and that the fixed implementation calls `uvx` directly with shell:false.
 */

import { describe, expect, it } from "vitest";
import { extractUrlContent } from "../extensions/llm-wiki/lib/source-extractors.js";

type ExecCall = { command: string; args: string[] };

function makeRecordingPi(opts: {
  hasUvX?: boolean;
  markitdownOutput?: string;
  curlOutput?: string;
}) {
  const calls: ExecCall[] = [];
  const pi = {
    exec: async (command: string, args: string[], _options?: unknown) => {
      calls.push({ command, args });
      // Simulate `which uvx` / `uvx --version` success probes
      if (command === "uvx" && args[0] === "--version") {
        if (opts.hasUvX === false) throw new Error("uvx not found");
        return { stdout: "uvx 0.5.0\n", stderr: "", code: 0, killed: false };
      }
      if (command === "which" && args[0] === "uvx") {
        if (opts.hasUvX === false) throw new Error("which failed");
        return { stdout: "/usr/local/bin/uvx\n", stderr: "", code: 0, killed: false };
      }
      if (command === "where" && args[0] === "uvx") {
        if (opts.hasUvX === false) throw new Error("where failed");
        return { stdout: "C:\\uvx.exe\n", stderr: "", code: 0, killed: false };
      }
      // Legacy sh -c paths (vulnerable) — used to detect unpatched code
      if (command === "sh") {
        const shellCmd = args[1] ?? "";
        // hasMarkItDown probe
        if (shellCmd.includes("which uvx")) {
          return { stdout: "yes\n", stderr: "", code: 0, killed: false };
        }
        if (shellCmd.includes("markitdown")) {
          // Simulate shell injection: if payload contains `;echo` etc, it would have executed.
          // For the vulnerable test we treat this as still returning markitdownOutput but we
          // record that sh -c was used with user input.
          return { stdout: opts.markitdownOutput ?? "", stderr: "", code: 0, killed: false };
        }
        // fallback
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (command === "uvx") {
        // Direct uvx invocation — args include source as last element; NOT shell-interpreted
        return { stdout: opts.markitdownOutput ?? "", stderr: "", code: 0, killed: false };
      }
      if (command === "curl") {
        return {
          stdout: opts.curlOutput ?? "<html><title>Fallback</title><body>hello</body></html>",
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
    },
  };
  return { pi: pi as never, calls };
}

const INJECTION_PAYLOADS = [
  '";open -a Calculator;# ',
  '";echo INJECTED > /tmp/pwned;# ',
  "$(whoami)",
  "`id`",
  "a; rm -rf / #",
  "x && echo hacked",
  "x || echo hacked",
  "x\n echo hacked",
];

describe("source-extractors security — #185 OS Command Injection", () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`should NOT interpolate url payload ${JSON.stringify(payload)} into sh -c`, async () => {
      const { pi, calls } = makeRecordingPi({
        hasUvX: true,
        markitdownOutput: "# Title\n\nextracted",
      });

      // Should not throw, should safely handle malicious url
      const result = await extractUrlContent(pi, payload);

      // Must NOT have invoked `sh -c` with user-controlled payload inside
      const shCallsWithPayload = calls.filter(
        (c) => c.command === "sh" && c.args[1]?.includes(payload),
      );
      expect(
        shCallsWithPayload,
        `vulnerable sh -c interpolation detected for payload ${JSON.stringify(payload)}: ${JSON.stringify(shCallsWithPayload)}`,
      ).toEqual([]);

      // Must NOT have invoked `sh -c` at all for markitdown path (fixed code uses direct exec)
      const anyShMarkitdown = calls.filter(
        (c) => c.command === "sh" && c.args[1]?.includes("markitdown"),
      );
      expect(
        anyShMarkitdown,
        `fixed code must not use sh -c for markitdown; found ${JSON.stringify(anyShMarkitdown)}`,
      ).toEqual([]);

      // Should have probed uvx without shell
      const uvxProbe = calls.filter(
        (c) => (c.command === "which" || c.command === "uvx") && c.args.includes("uvx"),
      );
      expect(uvxProbe.length, "should probe uvx availability without shell").toBeGreaterThan(0);

      // Should have called uvx directly with payload as a single arg (not interpreted)
      const uvxCalls = calls.filter((c) => c.command === "uvx" && c.args.includes("markitdown"));
      expect(uvxCalls.length, "should invoke uvx directly for markitdown").toBeGreaterThan(0);
      for (const call of uvxCalls) {
        expect(
          call.args,
          "payload must be passed as a discrete argv element, not shell-interpolated",
        ).toContain(payload);
        // Fixed code passes payload as argv, not shell-interpolated — no sh -c in call
        expect(call.command).not.toBe("sh");
      }

      // Extraction should still succeed (mocked markitdown output)
      expect(result.extracted).toContain("extracted");
    });
  }

  it("should safely handle filePath-like payload via same markitdown path", async () => {
    // file extraction also goes through extractWithMarkItDown for pdf/docx;
    // we verify url path covers same function, but explicitly test with a path-like string
    const payload = '";echo PWNED;# .pdf';
    const { pi, calls } = makeRecordingPi({ hasUvX: true, markitdownOutput: "file extracted" });
    const result = await extractUrlContent(pi, payload);
    const shWithPayload = calls.filter((c) => c.command === "sh" && c.args[1]?.includes(payload));
    expect(shWithPayload).toEqual([]);
    expect(result.extracted).toContain("extracted");
  });

  it("should fallback to curl safely when markitdown returns empty, without shell interpolation", async () => {
    const payload = '";echo INJECTED;# ';
    const { pi, calls } = makeRecordingPi({
      hasUvX: true,
      markitdownOutput: "",
      curlOutput: "<html><title>Hi</title><body>ok</body></html>",
    });
    const result = await extractUrlContent(pi, payload);
    // Should have fallen back to curl with payload as separate arg
    const curlCalls = calls.filter((c) => c.command === "curl");
    expect(curlCalls.length).toBeGreaterThan(0);
    for (const c of curlCalls) {
      expect(c.args).toContain(payload);
    }
    // Still no sh -c with payload
    expect(calls.filter((c) => c.command === "sh" && c.args[1]?.includes(payload))).toEqual([]);
    expect(result.extracted).toContain("Hi");
  });

  it("should return empty/fallback when uvx not available, without using sh -c payload", async () => {
    const payload = '";echo INJECTED;# ';
    const { pi, calls } = makeRecordingPi({
      hasUvX: false,
      markitdownOutput: "should not reach",
      curlOutput: "<html><body>fallback</body></html>",
    });
    const result = await extractUrlContent(pi, payload);
    // Should not have called sh -c with payload
    expect(calls.filter((c) => c.command === "sh" && c.args[1]?.includes(payload))).toEqual([]);
    // Should have attempted uvx probe without shell and then used curl fallback
    expect(result.extracted).toBeTruthy();
  });

  it("normal url should still work via direct uvx exec", async () => {
    const { pi, calls } = makeRecordingPi({ hasUvX: true, markitdownOutput: "# Hello\n\nworld" });
    const result = await extractUrlContent(pi, "https://example.com/page.html");
    expect(result.extracted).toContain("Hello");
    const uvxCalls = calls.filter((c) => c.command === "uvx" && c.args.includes("markitdown"));
    expect(uvxCalls.length).toBeGreaterThan(0);
    expect(uvxCalls[0].args).toContain("https://example.com/page.html");
    expect(calls.filter((c) => c.command === "sh" && c.args[1]?.includes("markitdown"))).toEqual(
      [],
    );
  });
});
