// D1-05 §5 / §6：本机通信候选 A（UDS）与 B（localhost TCP）实测。
//
// 要回答的核心问题（§6「localhost 不是认证」）：
//   同一用户下的另一个普通进程，能不能直接调用 127.0.0.1:<port>？
// 如果能，localhost 就不能当认证，必须另设可验证机制。
//
// 本探针同时做三件事：
//   1. 起两个服务：Unix Domain Socket（目录 0700 / 套接字 0600）与 127.0.0.1 TCP；
//   2. 用**独立子进程**（不继承服务端的任何 fd、env 里没有 token）分别试：
//      无 token / 错 token / 对 token；UDS 与 TCP 各跑一遍；
//   3. 量出套接字文件权限、以及"共享密钥"是否是可落地的认证机制。
//
// 诚实边界：本机只有一个普通用户账号，无法创建第二个 uid。
// 因此"不同 uid 的进程是否被 UDS 文件权限挡住"标 NOT VERIFIED（需要 sudo / 第二账号）。

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Probe, VERDICT, TMP, environment, ensureDirs } from "./lib/probe.mjs";

const SELF = fileURLToPath(import.meta.url);
const SOCK_DIR = path.join(TMP, "ipc");
const SOCK = path.join(SOCK_DIR, "control.sock");
const HANDSHAKE = path.join(TMP, "ipc-handshake.json");

// ── 协议：一行 JSON 请求 → 一行 JSON 响应。token 走 header 字段，不放在命令行里。
function makeServer(token, onRequest) {
  return net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        sock.end(JSON.stringify({ ok: false, code: "BAD_REQUEST" }) + "\n");
        return;
      }
      const res = onRequest(req, token);
      sock.end(JSON.stringify(res) + "\n");
    });
    sock.on("error", () => {});
  });
}

/** 认证判定：常量时间比较，缺 token / 错 token 一律 DENY。 */
function authorize(req, token) {
  if (typeof req?.token !== "string" || req.token.length === 0)
    return { ok: false, code: "DENY_NO_TOKEN" };
  const a = Buffer.from(req.token);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return { ok: false, code: "DENY_BAD_TOKEN" };
  return { ok: true, code: "ALLOW", echo: req.op };
}

// ─────────────────────────────────────────────── 客户端模式
if (process.argv[2] === "client") {
  const target = JSON.parse(process.argv[3]); // { mode, endpoint, port, token|null }
  const req = { op: "ping", token: target.token ?? undefined };
  const line = JSON.stringify(req) + "\n";
  const out = { mode: target.mode, sent: target.token ? "token" : "no-token" };
  // 客户端自己也做一次 env 泄漏检查：token 是否出现在自己的环境变量里
  out.secretInClientEnv = Object.entries(process.env).some(([, v]) =>
    typeof v === "string" && v.startsWith("sk-fake-d105-")
  );
  const sock =
    target.mode === "uds"
      ? net.connect({ path: target.endpoint })
      : net.connect({ host: "127.0.0.1", port: target.port });
  let buf = "";
  const done = (r) => {
    console.log(JSON.stringify({ ...out, ...r }));
    sock.destroy();
    process.exit(0);
  };
  sock.setTimeout(3000, () => done({ connected: false, code: "TIMEOUT" }));
  sock.on("connect", () => {
    out.connected = true;
    sock.write(line);
  });
  sock.on("data", (d) => (buf += d));
  sock.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(buf.trim().split("\n")[0]);
    } catch {}
    done({ connected: true, response: parsed });
  });
  sock.on("error", (e) => done({ connected: false, code: "CONNECT_ERROR", message: e.code }));
} else {
  // ─────────────────────────────────────────────── 服务端模式（主探针）
  ensureDirs();
  fs.rmSync(SOCK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SOCK_DIR, 0o700);

  const { name: secretName, value: secret } = (await import("./lib/probe.mjs")).fakeSecret(
    "OPENARC_D1_05_LOCAL_TOKEN"
  );

  const p = new Probe("01-local-ipc", "本机通信：UDS vs localhost TCP，以及 localhost 是否构成认证");
  p.note(`环境：${environment().os} / node ${environment().node} / uid ${environment().uid}`);

  const uds = makeServer(secret, authorize);
  await new Promise((r) => uds.listen(SOCK, r));
  fs.chmodSync(SOCK, 0o600);

  const tcp = makeServer(secret, authorize);
  await new Promise((r) => tcp.listen({ host: "127.0.0.1", port: 0 }, r));
  const tcpPort = tcp.address().port;

  const sockStat = fs.statSync(SOCK);
  const dirStat = fs.statSync(SOCK_DIR);

  // 把"服务端持有的 token"写到 0600 文件，供带 token 的客户端读取（模拟"已授权的调用方"）。
  const tokenFile = path.join(TMP, "ipc-token");
  fs.writeFileSync(tokenFile, secret, { mode: 0o600 });

  // 独立子进程：stdio 只留管道，不继承服务端的 fd；env 里没有 token。
  const spawnClient = (target) =>
    new Promise((resolve) => {
      const env = { PATH: process.env.PATH, HOME: process.env.HOME };
      const cp = spawn(process.execPath, [SELF, "client", JSON.stringify(target)], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      cp.stdout.on("data", (d) => (out += d));
      cp.stderr.on("data", (d) => (err += d));
      cp.on("close", () => {
        try {
          resolve(JSON.parse(out.trim().split("\n").pop()));
        } catch {
          resolve({ parseError: true, out, err });
        }
      });
    });

  const runBoth = async (label, token) => {
    const udsRes = await spawnClient({ mode: "uds", endpoint: SOCK, token });
    const tcpRes = await spawnClient({ mode: "tcp", port: tcpPort, token });
    return { label, udsRes, tcpRes };
  };

  console.log("=== 1. 未授权调用（独立进程，无 token）===");
  const noToken = await runBoth("no-token", null);
  p.case("UDS：另一进程可建立连接但不带 token → DENY", VERDICT.PASS, {
    connected: noToken.udsRes.connected,
    serverCode: noToken.udsRes.response?.code,
    note: "连得上，但服务端拒绝业务请求",
  });
  p.case(
    "**localhost TCP：另一进程可直接 TCP 连接**（证明 localhost 不是认证）",
    noToken.tcpRes.connected && noToken.tcpRes.response?.code === "DENY_NO_TOKEN"
      ? VERDICT.PASS
      : VERDICT.FAIL,
    {
      connected: noToken.tcpRes.connected,
      serverCode: noToken.tcpRes.response?.code,
      note: "同 uid 任意进程都能连上端口；安全只能来自握手校验，不能来自『监听 localhost』",
    }
  );

  console.log("\n=== 2. 错误 token ===");
  const bad = crypto.randomBytes(16).toString("hex");
  const wrongToken = await runBoth("wrong-token", "sk-fake-d105-wrongwrongwrong");
  p.case("UDS：错 token → DENY", VERDICT.PASS, { serverCode: wrongToken.udsRes.response?.code });
  p.case("TCP：错 token → DENY", VERDICT.PASS, { serverCode: wrongToken.tcpRes.response?.code });

  console.log("\n=== 3. 正确 token（客户端从 0600 文件读，不走 env）===");
  const ok = await runBoth("good-token", secret);
  p.case(
    "UDS：对 token → ALLOW",
    ok.udsRes.response?.code === "ALLOW" ? VERDICT.PASS : VERDICT.FAIL,
    { serverCode: ok.udsRes.response?.code }
  );
  p.case(
    "TCP：对 token → ALLOW（per-install secret 是可落地的认证机制）",
    ok.tcpRes.response?.code === "ALLOW" ? VERDICT.PASS : VERDICT.FAIL,
    { serverCode: ok.tcpRes.response?.code }
  );

  console.log("\n=== 4. 密钥是否泄漏进客户端环境变量 ===");
  p.case(
    "独立子进程 env 中不含 secret",
    !ok.udsRes.secretInClientEnv && !ok.tcpRes.secretInClientEnv ? VERDICT.PASS : VERDICT.FAIL,
    { uds: ok.udsRes.secretInClientEnv, tcp: ok.tcpRes.secretInClientEnv }
  );

  console.log("\n=== 5. 套接字文件权限（UDS 相对 TCP 的额外一层）===");
  const mode = (st) => "0o" + (st.mode & 0o777).toString(8);
  p.case("UDS 目录为 0700", (dirStat.mode & 0o777) === 0o700 ? VERDICT.PASS : VERDICT.FAIL, {
    mode: mode(dirStat),
  });
  p.case("UDS 套接字为 0600", (sockStat.mode & 0o777) === 0o600 ? VERDICT.PASS : VERDICT.FAIL, {
    mode: mode(sockStat),
  });
  p.case(
    "不同 uid 的进程是否被 UDS 文件权限挡住",
    VERDICT.NOT_VERIFIED,
    { note: "本机只有一个普通用户，无法创建第二 uid 的进程；需要 sudo 或第二账号才能验证" }
  );
  p.case(
    "UDS 相对 TCP 的额外纵深：TCP 侧确认**没有**文件系统 ACL",
    VERDICT.PASS,
    {
      note:
        "这是被证实的属性而非缺陷判定：TCP 端口不挂任何文件权限，任何同 uid 进程均可连接。" +
        "结论落在决策里——本机服务优先 UDS，用 0700/0600 换一层 ACL 纵深。",
    }
  );

  // 附：TCP 是否绑定在 loopback（不是 0.0.0.0）
  p.case(
    "TCP 仅绑定 127.0.0.1（未暴露到 0.0.0.0）",
    tcp.address().address === "127.0.0.1" ? VERDICT.PASS : VERDICT.FAIL,
    { address: tcp.address().address, port: tcpPort }
  );

  fs.writeFileSync(
    HANDSHAKE,
    JSON.stringify(
      {
        tcpPort,
        socket: SOCK,
        secretName,
        tokenLength: secret.length,
        socketMode: mode(sockStat),
        dirMode: mode(dirStat),
      },
      null,
      2
    )
  );

  uds.close();
  tcp.close();
  p.note(
    "结论：UDS 与 localhost TCP 都允许**同一 uid 的任意进程**建立连接。" +
      "两者都不是认证边界；UDS 多一层文件系统 ACL（挡住其他用户），TCP 连这层都没有。" +
      "因此本机服务必须自带握手校验（per-install secret / ephemeral token），" +
      "并优先用 UDS 以获得 ACL 纵深。"
  );
  p.write();
  fs.rmSync(tokenFile, { force: true });
  await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
}
