// D1-02 Harness 最小控制面探针（无副作用）
//
// 目的：验证 OpenArc 能否从外部进程控制 DeepSeek Harness，而不是证明"能聊天"。
// 只走控制面：initialize / session/new / session/list / session/cancel / session/close。
// 不发真实 prompt，因此不需要可用的模型 API Key。
//
// 用法：
//   DSH_BIN=/path/to/dsh node experiments/harness/acp-probe.mjs
//   DSH_BIN=/path/to/dsh DSH_MCP_TOOL=1 node experiments/harness/acp-probe.mjs   # 附带挂一个假 MCP 工具
//
// 依赖：已 npm install @deepseek-ai/dsh（任一目录），把 bin 路径传进来即可。

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_BIN = process.env.DSH_BIN;
if (!DSH_BIN) {
  console.error("缺少 DSH_BIN。例：DSH_BIN=/tmp/dsh-probe/node_modules/.bin/dsh node " + process.argv[1]);
  process.exit(2);
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ---------- 启动 ACP 服务端 ----------
const home = mkdtempSync(join(tmpdir(), "openarc-dsh-home-"));
const child = spawn(DSH_BIN, ["--profile", "acp"], {
  env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "sk-probe-dummy" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrBuf = "";
child.stderr.on("data", (d) => (stderrBuf += d.toString()));

// ---------- 极简 JSON-RPC（换行分隔）----------
let nextId = 1;
const pending = new Map();
let buf = "";

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith("{")) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  }
});

function request(method, params, timeoutMs = 20000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时 ${timeoutMs}ms`)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 探针 ----------
try {
  // 1) initialize
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "openarc-os", version: "0.1.0" },
  });
  record(
    "ACP initialize 握手",
    init?.protocolVersion === 1,
    `agent=${init?.agentInfo?.name}@${init?.agentInfo?.version} protocol=${init?.protocolVersion}`
  );
  record(
    "session 能力（list/resume/close）",
    !!init?.agentCapabilities?.sessionCapabilities &&
      ["list", "resume", "close"].every((k) => k in init.agentCapabilities.sessionCapabilities),
    JSON.stringify(init?.agentCapabilities?.sessionCapabilities ?? {})
  );
  record(
    "ACP 认证方式",
    Array.isArray(init?.authMethods),
    init?.authMethods?.length === 0 ? "authMethods=[] —— 无鉴权（安全发现）" : JSON.stringify(init.authMethods)
  );
  record("MCP 挂载能力", !!init?.agentCapabilities?.mcpCapabilities, JSON.stringify(init?.agentCapabilities?.mcpCapabilities ?? {}));

  // 2) session/new —— 挂一个无副作用的假 MCP 工具，验证 OpenArc 能否控制工具集
  //    ACP 的 session/new 强制要求 mcpServers 字段（缺失会 -32602）。
  const mcpServers = [];
  if (process.env.DSH_MCP_TOOL === "1") {
    mcpServers.push({
      name: "openarc-fake",
      command: process.execPath,
      args: [join(HERE, "fake-mcp-server.mjs")],
      env: [{ name: "DSH_FAKE_MCP_LOG", value: join(home, "fake-mcp.log") }],
    });
  }
  let sessionId = null;
  try {
    const s = await request("session/new", { cwd: home, mcpServers });
    sessionId = s?.sessionId ?? null;
    record(
      "session/new",
      !!sessionId,
      `sessionId=${sessionId} mcpServers=${mcpServers.length}${mcpServers.length ? "（假工具 openarc_echo）" : ""}`
    );
  } catch (e) {
    record("session/new", false, e.message);
  }

  // 3) session/list —— 注意：实测新建会话不在 list 中，说明 list 只反映"已持久化"的会话。
  //    这是行为事实，不是通过/失败判定；对 OpenArc 的含义：不能靠 list 枚举活动会话，必须自己持有 id 映射。
  try {
    const l = await request("session/list", {});
    const ids = (l?.sessions ?? []).map((x) => x.sessionId ?? x.id);
    record("session/list 可用（返回数组）", Array.isArray(l?.sessions), `共 ${ids.length} 个会话`);
    console.log(
      `OBSERVE  session/list 是否包含刚建的会话：${ids.includes(sessionId) ? "是" : "否"} —— ` +
        "list 只反映已持久化会话，OpenArc 必须自己持有 sessionId 映射，不能依赖 list 枚举活动会话"
    );
  } catch (e) {
    record("session/list", false, e.message);
  }

  // 4) session/cancel —— 无 prompt 在飞时应为 no-op（不报错即视为可调用）
  if (sessionId) {
    try {
      await notify("session/cancel", { sessionId });
      await sleep(400);
      record("session/cancel 可调用（空闲取消 no-op）", true, "未抛错；ACP 明确声明未知 sessionId 为 no-op");
    } catch (e) {
      record("session/cancel", false, e.message);
    }
  }

  // 5) session/close
  if (sessionId) {
    try {
      await request("session/close", { sessionId });
      record("session/close", true, "静默取消 + 落盘 + 仅释放该 Agent 作用域");
    } catch (e) {
      record("session/close", false, e.message);
    }
  }

  // 6) 未知 sessionId 的 cancel 应为 no-op（验证"不误伤"）
  try {
    await notify("session/cancel", { sessionId: "openarc-does-not-exist" });
    await sleep(400);
    const l2 = await request("session/list", {});
    record("未知 sessionId 的 cancel 不破坏服务", Array.isArray(l2?.sessions), "服务仍可响应 session/list");
  } catch (e) {
    record("未知 sessionId cancel", false, e.message);
  }
} catch (e) {
  record("探针执行", false, e.message);
} finally {
  child.stdin.end();
  await sleep(300);
  child.kill("SIGTERM");
}

// 7) 取证：假 MCP 服务器是否真的被 Harness 连上并调用过
if (process.env.DSH_MCP_TOOL === "1") {
  let log = "";
  try {
    log = readFileSync(join(home, "fake-mcp.log"), "utf8").trim();
  } catch {
    log = "";
  }
  const methods = log ? log.split("\n") : [];
  record(
    "Harness 确实连上假 MCP 服务器（initialize + tools/list）",
    methods.includes("initialize") && methods.includes("tools/list"),
    methods.length ? `收到方法：${[...new Set(methods)].join(", ")}` : "无任何调用 —— MCP 挂载未被证实"
  );
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed`);
if (stderrBuf.trim()) console.log("\n--- dsh stderr（截断）---\n" + stderrBuf.split("\n").slice(0, 15).join("\n"));
process.exit(pass === results.length ? 0 : 1);
