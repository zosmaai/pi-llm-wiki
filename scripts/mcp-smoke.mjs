#!/usr/bin/env node

/**
 * Standalone stdio smoke test for the published MCP server.
 *
 * Usage: node scripts/mcp-smoke.mjs <path-to-dist/mcp/index.js>
 *
 * Speaks the MCP handshake over line-delimited JSON-RPC — initialize,
 * notifications/initialized, tools/list — against the given entry point and
 * fails if the server cannot start or does not expose the documented tools.
 *
 * CI runs this against a tarball installed into a directory with no lockfile,
 * so the server is exercised with the dependency versions a consumer actually
 * resolves rather than the ones this repo pins.
 */

import { spawn } from "node:child_process";

const REQUIRED_TOOLS = [
  "wiki_capture_source",
  "wiki_recall",
  "wiki_retro",
  "wiki_search",
  "wiki_status",
];

const TIMEOUT_MS = 30_000;

const serverPath = process.argv[2];
if (!serverPath) {
  console.error("usage: node scripts/mcp-smoke.mjs <path-to-dist/mcp/index.js>");
  process.exit(2);
}

const child = spawn(process.execPath, [serverPath], { stdio: "pipe" });

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

function fail(message) {
  console.error(`✗ ${message}`);
  if (stderr.trim()) console.error(`--- server stderr ---\n${stderr.trim()}`);
  if (!child.killed) child.kill();
  process.exit(1);
}

const pending = new Map();
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`server wrote a non-JSON line on stdout: ${line.slice(0, 200)}`);
      return;
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

child.once("error", (error) => fail(`could not spawn ${serverPath}: ${error.message}`));
child.once("exit", (code) => {
  if (pending.size > 0) fail(`server exited early with code ${code}`);
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(message) {
  return new Promise((resolve) => {
    pending.set(message.id, resolve);
    send(message);
  });
}

const timer = setTimeout(() => fail(`no response within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

const initialized = await request({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "1.0.0" },
  },
});
if (!initialized.result) fail(`initialize failed: ${JSON.stringify(initialized)}`);

send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
if (!listed.result) fail(`tools/list failed: ${JSON.stringify(listed)}`);

const names = listed.result.tools.map((tool) => tool.name);
const missing = REQUIRED_TOOLS.filter((tool) => !names.includes(tool));
if (missing.length > 0)
  fail(`tools/list is missing: ${missing.join(", ")} (got: ${names.join(", ")})`);

clearTimeout(timer);
console.log(
  `✓ ${serverPath} started and exposed ${names.length} tools: ${names.sort().join(", ")}`,
);
child.stdin.end();
child.kill();
