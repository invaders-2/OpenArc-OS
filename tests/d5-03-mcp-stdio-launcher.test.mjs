/**
 * D5-03 修复批次 · MCP stdio 传输 launcher（D5-03-D2 回归）。
 *
 * 生产路径的 stdio 传输必须是"有真 stdin 的 Node child"：Electron main 下
 * createMcpStdioLauncher() 给 Electron 运行时追加 ELECTRON_RUN_AS_NODE=1，
 * 纯 Node（本测试）下就是同一个 NodeChildProcessLauncher —— 测试与生产同一条实现。
 * 白名单映射（entry/args）原样透传，launcher 不追加除 run-as-node 之外的任何 env。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { domain, createMcpStdioLauncher, NodeChildProcessLauncher, waitFor, pidAlive } from "./mcp-fixtures.mjs";

/** 只实现 launch() 用到的那部分 ChildProcess 形状（不跑真进程）。 */
function fakeChild() {
  const listeners = new Map();
  return {
    pid: 4242,
    stdin: { write() { return true; }, end() {} },
    stdout: { on() {} },
    stderr: { on() {} },
    on(event, fn) { listeners.set(event, fn); return this; },
    kill() { return true; },
  };
}

test("L1 · 纯 Node（tests）与 Electron main 是同一个 NodeChildProcessLauncher 实现", () => {
  const nodeLauncher = createMcpStdioLauncher({ isElectronMain: false });
  assert.ok(nodeLauncher instanceof NodeChildProcessLauncher);
  assert.deepEqual(nodeLauncher.extraEnv, {}, "纯 Node 不追加 run-as-node");
  const electronLauncher = createMcpStdioLauncher({ isElectronMain: true, execPath: "/fake/Electron", spawnImpl: () => fakeChild() });
  assert.ok(electronLauncher instanceof NodeChildProcessLauncher);
  assert.equal(electronLauncher.nodePath, "/fake/Electron");
  assert.deepEqual(electronLauncher.extraEnv, { ELECTRON_RUN_AS_NODE: "1" });
});

test("L2 · Electron main：白名单 entry/args 原样透传，只追加 ELECTRON_RUN_AS_NODE（调用方覆盖不了）", () => {
  const local = domain.validateLocalEndpoint({ serverKey: "openarc-test-echo" });
  assert.equal(local.ok, true);
  const spawns = [];
  const launcher = createMcpStdioLauncher({
    isElectronMain: true,
    execPath: "/fake/Electron",
    spawnImpl: (cmd, argv, opts) => { spawns.push({ cmd, argv, opts }); return fakeChild(); },
  });
  const handle = launcher.launch({ entry: local.entry, args: local.args, env: { ...domain.localServerEnv(), ELECTRON_RUN_AS_NODE: "0" } });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, "/fake/Electron", "用 Electron 运行时当 Node");
  assert.equal(spawns[0].argv[0], local.entry, "entry 就是白名单固定映射的仓库内文件");
  assert.deepEqual(spawns[0].argv.slice(1), ["--stdio"], "args 原样透传");
  assert.deepEqual(spawns[0].opts.stdio, ["pipe", "pipe", "pipe"], "stdio 必须有管道（stdin 是握手通道）");
  assert.deepEqual(spawns[0].opts.env, { PATH: process.env.PATH || "", ELECTRON_RUN_AS_NODE: "1" }, "env = 白名单 env + launcher 追加项；调用方写的 0 被覆盖");
  assert.equal(typeof handle.stdin.write, "function", "句柄必须有可写 stdin（utilityProcess 句柄没有）");
  assert.equal(domain.validateLocalEndpoint({ serverKey: "../../bin/sh" }).ok, false, "非白名单 key 到不了 launcher");
});

test("L3 · 真实 stdio 传输：写 stdin → 服务端 initialize + tools/list 原样返回（有界回收子进程）", async () => {
  const local = domain.validateLocalEndpoint({ serverKey: "openarc-test-echo" });
  const launcher = createMcpStdioLauncher();
  const handle = launcher.launch({ entry: local.entry, args: local.args, env: domain.localServerEnv() });
  const pid = handle.pid;
  try {
    assert.equal(pid != null, true);
    assert.equal(!!handle.stdin && typeof handle.stdin.write === "function", true, "生产传输的第一个前提：句柄有 stdin");
    const messages = [];
    let buffer = "";
    handle.on("stdout", (chunk) => {
      buffer += String(chunk);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) { try { messages.push(JSON.parse(line)); } catch { /* 非 JSON 行不进协议状态 */ } }
        index = buffer.indexOf("\n");
      }
    });
    handle.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: domain.MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "launcher-test", version: "0" } } }) + "\n");
    const init = await waitFor(() => messages.find((m) => m.id === 1) || null, { timeoutMs: 8000 });
    assert.equal(!!init, true, "initialize 必须有响应（stdin 真的通到服务端）");
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "openarc-test-echo");
    assert.equal(init.result.serverInfo.version, "1.4.0");
    handle.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    const tools = await waitFor(() => messages.find((m) => m.id === 2) || null, { timeoutMs: 8000 });
    assert.deepEqual(tools.result.tools.map((t) => t.name), ["echo_sum", "describe_self"]);
  } finally {
    try { handle.stdin.end(); } catch { /* ignore */ }
    try { handle.kill("SIGKILL"); } catch { /* ignore */ }
  }
  assert.equal(await waitFor(() => !pidAlive(pid), { timeoutMs: 5000 }), true, "回收后子进程必须退出");
});
