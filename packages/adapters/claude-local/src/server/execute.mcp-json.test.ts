import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet" }),
      JSON.stringify({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "result", session_id: "s1", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { execute } from "./execute.js";

const baseAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Test Agent",
  adapterType: "claude_local" as const,
  adapterConfig: {},
};

const baseRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};

describe(".mcp.json pre-spawn write (THEA-4800)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("writes .mcp.json with mcpServers config before spawning Claude", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-json-write-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const mcpServers = {
      chrome: {
        type: "sse",
        url: "http://localhost:9223/sse",
      },
    };

    const logs: string[] = [];
    await execute({
      runId: "run-mcp-1",
      agent: baseAgent,
      runtime: baseRuntime,
      config: { command: "claude", mcpServers },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    const mcpJsonPath = path.join(workspaceDir, ".mcp.json");
    const contents = await readFile(mcpJsonPath, "utf-8");
    expect(JSON.parse(contents)).toEqual({ mcpServers });
    expect(logs.some((l) => l.includes("Wrote .mcp.json") && l.includes("chrome"))).toBe(true);
  });

  it("does not write .mcp.json when mcpServers is empty", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-json-empty-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const logs: string[] = [];
    await execute({
      runId: "run-mcp-empty",
      agent: baseAgent,
      runtime: baseRuntime,
      config: { command: "claude", mcpServers: {} },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(workspaceDir, ".mcp.json"))).toBe(false);
    expect(logs.some((l) => l.includes("Wrote .mcp.json"))).toBe(false);
  });

  it("does not overwrite .mcp.json when content is already up-to-date (idempotent)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-json-idem-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const mcpServers = { chrome: { type: "sse", url: "http://localhost:9223/sse" } };
    const desired = JSON.stringify({ mcpServers }, null, 2) + "\n";
    await writeFile(path.join(workspaceDir, ".mcp.json"), desired, "utf-8");

    const logs: string[] = [];
    await execute({
      runId: "run-mcp-idem",
      agent: baseAgent,
      runtime: baseRuntime,
      config: { command: "claude", mcpServers },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });

    expect(logs.some((l) => l.includes("Wrote .mcp.json"))).toBe(false);
  });
});
