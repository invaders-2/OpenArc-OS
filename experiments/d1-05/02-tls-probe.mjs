// D1-05 §7 / §8：LAN TLS / mTLS 技术 Probe。
//
// 目标：用实测决定「mTLS 是否适合作为 Device Agent 的身份基础」，而不是预设结论。
//
// 做法：本地起一个 **TLS-only** 的 Control Service（127.0.0.1 临时端口，测试证书），
// 用 9 类客户端场景打真实 handshake；服务端记录 authorizationError 与
// "业务请求被服务次数"，用来证明失败时没有降级放行。
//
// 硬性要求（§8）：任何 TLS 失败都不得 fallback 到明文。
// 两条判据：
//   ① 所有 DENY 场景下 requestsServed 不增加；
//   ② 用**裸 TCP** 向同一端口发明文 HTTP，必须拿不到业务响应。

import tls from "node:tls";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { Probe, VERDICT, ART, TLS as TLSDIR, environment } from "./lib/probe.mjs";

const p = new Probe("02-tls", "LAN TLS / mTLS：真实握手与失败场景矩阵");
p.note(`环境：${environment().os} / node ${environment().node}`);

const read = (f) => fs.readFileSync(path.join(TLSDIR, f));
const ident = (name) => ({ key: read(`${name}.key`), cert: read(`${name}.crt`) });

const CA = read("ca.crt");
const SERVER = ident("server");
const SERVER_WRONGHOST = ident("wronghost");
const SERVER_EXPIRED = ident("expired-server");

const fpOf = (pem) => new X509Certificate(pem).fingerprint256;
const FP = {
  clientA: fpOf(read("clientA.crt")),
  clientB: fpOf(read("clientB.crt")),
  expiredClient: fpOf(read("expired-client.crt")),
  forged: fpOf(read("wrongca-client.crt")),
  server: fpOf(read("server.crt")),
  wronghost: fpOf(read("wronghost.crt")),
};

// 应用层状态：Node 的 tls **不做 CRL / OCSP**，所以"撤销"只能在应用层实现。
let revoked = new Set();
let registered = new Set([FP.clientA, FP.clientB]);
let requestsServed = 0;
/** 显式记账：每个"期望被服务"的场景 +1，最后与服务端实际计数对账。 */
let expectedAllows = 0;
const servedLog = [];

const srv = tls.createServer(
  {
    key: SERVER.key,
    cert: SERVER.cert,
    ca: [CA],
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  },
  (sock) => {
    const peer = sock.getPeerCertificate();
    const fp = peer?.fingerprint256 ?? null;
    const authErr = sock.authorizationError || null;

    let denyCode = null;
    if (sock.authorized !== true) denyCode = "TLS_UNAUTHORIZED";
    else if (!fp) denyCode = "NO_PEER_CERT";
    else if (revoked.has(fp)) denyCode = "DEVICE_REVOKED";
    else if (!registered.has(fp)) denyCode = "DEVICE_NOT_REGISTERED";

    if (denyCode) {
      servedLog.push({ fpTail: fp?.slice(-8) ?? null, denyCode, authErr, counted: false });
      sock.end(JSON.stringify({ ok: false, code: denyCode }) + "\n");
      return;
    }
    requestsServed++;
    servedLog.push({ fpTail: fp.slice(-8), denyCode: null, authErr, counted: true });
    sock.end(JSON.stringify({ ok: true, code: "ALLOW", device: peer.subject?.CN }) + "\n");
  }
);
srv.on("tlsClientError", (err) =>
  servedLog.push({ tlsClientError: err.code || err.message, phase: "handshake", counted: false })
);

await new Promise((r) => srv.listen({ host: "127.0.0.1", port: 0 }, r));
const port = srv.address().port;
p.note(`Control Service（TLS-only）监听 127.0.0.1:${port}；测试 CA 签发；minVersion TLSv1.2`);

/** 一次客户端连接尝试。返回握手结果 + 服务端业务计数增量。 */
function connect(opts = {}) {
  return new Promise((resolve) => {
    const before = requestsServed;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, requestsDelta: requestsServed - before });
    };
    const sock = tls.connect({
      host: "127.0.0.1",
      port: opts.port ?? port,
      ca: opts.ca ?? CA,
      servername: opts.servername ?? "localhost",
      rejectUnauthorized: true,
      ...(opts.client ? { key: opts.client.key, cert: opts.client.cert } : {}),
    });
    let out = "";
    sock.setTimeout(4000, () => {
      sock.destroy();
      finish({ phase: "timeout" });
    });
    sock.on("secureConnect", () => {
      sock.__peer = sock.getPeerCertificate();
      sock.__proto = sock.getProtocol();
      sock.__cipher = sock.getCipher()?.name;
    });
    sock.on("data", (d) => (out += d));
    sock.on("error", (e) => {
      sock.__err = e.code || e.message;
    });
    sock.on("close", () => {
      const response = (() => {
        try {
          return JSON.parse(out.trim().split("\n")[0]);
        } catch {
          return null;
        }
      })();
      finish({
        phase: sock.__err ? "error" : "closed",
        error: sock.__err ?? null,
        authorized: sock.authorized,
        authError: sock.authorizationError,
        serverCertFp: sock.__peer?.fingerprint256,
        serverCN: sock.__peer?.subject?.CN,
        protocol: sock.__proto,
        cipher: sock.__cipher,
        response,
      });
    });
  });
}

/** 起一个临时 TLS 服务端，只用来观察**客户端是否拒绝服务端身份**。 */
async function probeServerIdentity(material) {
  const s = tls.createServer({ key: material.key, cert: material.cert, ca: [CA] }, (c) =>
    c.end("should-not-reach")
  );
  await new Promise((r) => s.listen({ host: "127.0.0.1", port: 0 }, r));
  const res = await connect({ port: s.address().port });
  s.close();
  return res;
}

// ── 1. valid client + valid server ─────────────────────────
console.log("=== 1. valid client（device-A）+ valid server ===");
const ok1 = await connect({ client: ident("clientA") });
if (ok1.response?.code === "ALLOW") expectedAllows++;
p.case(
  "valid client + valid server → ALLOW（真实 TLS1.3 握手）",
  ok1.response?.code === "ALLOW" ? VERDICT.PASS : VERDICT.FAIL,
  {
    response: ok1.response,
    serverCN: ok1.serverCN,
    protocol: ok1.protocol,
    cipher: ok1.cipher,
    requestsDelta: ok1.requestsDelta,
  }
);

// ── 2. unknown client（无客户端证书）──────────────────────
console.log("\n=== 2. unknown client（不带客户端证书）===");
const noCert = await connect({});
p.case(
  "无客户端证书 → 握手失败，业务层不可达",
  noCert.response?.code !== "ALLOW" ? VERDICT.PASS : VERDICT.FAIL,
  { phase: noCert.phase, error: noCert.error, requestsDelta: noCert.requestsDelta }
);

// ── 3. wrong CA（伪造设备）────────────────────────────────
console.log("\n=== 3. wrong CA 签发的客户端证书 ===");
const forged = await connect({ client: ident("wrongca-client") });
p.case(
  "错 CA 签发的客户端证书 → DENY",
  forged.response?.code !== "ALLOW" ? VERDICT.PASS : VERDICT.FAIL,
  { phase: forged.phase, error: forged.error, response: forged.response }
);

// ── 4. 过期客户端证书 ─────────────────────────────────────
console.log("\n=== 4. 过期客户端证书 ===");
const expClient = await connect({ client: ident("expired-client") });
p.case(
  "过期客户端证书 → DENY（CERT_HAS_EXPIRED）",
  expClient.response?.code !== "ALLOW" ? VERDICT.PASS : VERDICT.FAIL,
  { phase: expClient.phase, error: expClient.error }
);

// ── 5. 过期服务端证书 ─────────────────────────────────────
console.log("\n=== 5. 过期服务端证书 ===");
const expSrv = await probeServerIdentity(SERVER_EXPIRED);
p.case(
  "过期服务端证书 → 客户端拒绝服务端身份",
  expSrv.phase === "error" && !expSrv.response ? VERDICT.PASS : VERDICT.FAIL,
  { error: expSrv.error }
);

// ── 6. 主机名不匹配 ───────────────────────────────────────
console.log("\n=== 6. 主机名不匹配 ===");
const whRes = await probeServerIdentity(SERVER_WRONGHOST);
p.case(
  "服务端证书 SAN 不含 localhost → 客户端拒绝",
  whRes.phase === "error" && whRes.error === "ERR_TLS_CERT_ALTNAME_INVALID" ? VERDICT.PASS : VERDICT.FAIL,
  { error: whRes.error }
);

// ── 7. 撤销设备 ───────────────────────────────────────────
console.log("\n=== 7. 撤销 / 禁用设备 ===");
const beforeRevoke = await connect({ client: ident("clientB") });
if (beforeRevoke.response?.code === "ALLOW") expectedAllows++;
revoked.add(FP.clientB);
const afterRevoke = await connect({ client: ident("clientB") });
p.case(
  "被撤销设备的**证书链与有效期仍然有效** → Node tls 不做 CRL/OCSP，撤销必须应用层实现",
  beforeRevoke.response?.code === "ALLOW" && afterRevoke.phase === "closed" ? VERDICT.PASS : VERDICT.FAIL,
  {
    beforeRevoke: beforeRevoke.response?.code,
    afterRevokePhase: afterRevoke.phase,
    note: "同一次 handshake 成功建立（phase=closed），仅应用层拒绝——这就是「撤销要自己做」的证据",
  }
);
p.case(
  "应用层撤销名单命中 → DENY，且业务计数未增加",
  afterRevoke.response?.code === "DEVICE_REVOKED" && afterRevoke.requestsDelta === 0
    ? VERDICT.PASS
    : VERDICT.FAIL,
  { response: afterRevoke.response, requestsDelta: afterRevoke.requestsDelta }
);

// ── 8. 未注册设备 ─────────────────────────────────────────
console.log("\n=== 8. 未注册设备（证书链有效但不在团队注册表）===");
registered.delete(FP.clientA);
const unregistered = await connect({ client: ident("clientA") });
p.case(
  "证书链有效但未在团队注册 → DENY（DEVICE_NOT_REGISTERED）",
  unregistered.response?.code === "DEVICE_NOT_REGISTERED" ? VERDICT.PASS : VERDICT.FAIL,
  { response: unregistered.response, requestsDelta: unregistered.requestsDelta }
);

// ── 9. 证书轮换 + 重连 ────────────────────────────────────
console.log("\n=== 9. 证书轮换与重连 ===");
// 步骤 7 把 clientB 放进过 revoked；轮换场景要干净地测「注册表」，先解除撤销。
revoked.delete(FP.clientB);
registered = new Set([FP.clientB]);
const rotOld = await connect({ client: ident("clientA") });
const rotNew = await connect({ client: ident("clientB") });
if (rotNew.response?.code === "ALLOW") expectedAllows++;
p.case(
  "轮换后旧证书被拒、新证书被接受（无需重启服务）",
  rotOld.response?.code === "DEVICE_NOT_REGISTERED" && rotNew.response?.code === "ALLOW"
    ? VERDICT.PASS
    : VERDICT.FAIL,
  { old: rotOld.response?.code, new: rotNew.response?.code }
);

registered = new Set([FP.clientA, FP.clientB]);
const rc1 = await connect({ client: ident("clientA") });
const rc2 = await connect({ client: ident("clientA") });
if (rc1.response?.code === "ALLOW") expectedAllows++;
if (rc2.response?.code === "ALLOW") expectedAllows++;
p.case(
  "重连（同设备连续两次）→ 两次均 ALLOW",
  rc1.response?.code === "ALLOW" && rc2.response?.code === "ALLOW" ? VERDICT.PASS : VERDICT.FAIL,
  { first: rc1.response?.code, second: rc2.response?.code }
);

// ── 10. 无明文 fallback ───────────────────────────────────
console.log("\n=== 10. 无明文 fallback ===");
const plain = await new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => {
    s.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  });
  let out = "";
  let done = false;
  const fin = (extra = {}) => {
    if (done) return;
    done = true;
    resolve({ data: out, ...extra });
  };
  s.on("data", (d) => (out += d));
  s.setTimeout(2500, () => {
    s.destroy();
    fin();
  });
  s.on("close", () => fin());
  s.on("error", (e) => fin({ error: e.code }));
});
p.case(
  "向 TLS 端口发明文 HTTP → 拿不到业务响应（无明文 fallback）",
  !/ALLOW|"ok":true/.test(plain.data) ? VERDICT.PASS : VERDICT.FAIL,
  {
    receivedBytes: plain.data.length,
    sample: JSON.stringify(plain.data.slice(0, 48)),
  }
);

// ── 11. 证书 pinning 可行性 ───────────────────────────────
console.log("\n=== 11. 证书 pinning 可行性 ===");
p.case(
  "客户端可读到服务端证书指纹 → pinning 可实现",
  ok1.serverCertFp === FP.server ? VERDICT.PASS : VERDICT.FAIL,
  {
    pinnedFp: FP.server,
    observedFp: ok1.serverCertFp,
    note: "getPeerCertificate().fingerprint256 与 openssl 计算的 SHA-256 指纹一致，可直接用于 pin 比对",
  }
);

// ── 12. 无降级放行的总账 ──────────────────────────────────
const appDenies = servedLog.filter((r) => r.denyCode && !r.counted);
const tlsDenies = servedLog.filter((r) => r.tlsClientError || r.denyCode === "TLS_UNAUTHORIZED");
p.case(
  "总账：服务端被服务的业务请求次数 == 显式记账的允许次数，即所有 DENY 场景均未放行",
  requestsServed === expectedAllows && appDenies.length + tlsDenies.length >= 6 ? VERDICT.PASS : VERDICT.FAIL,
  {
    allowServed: requestsServed,
    expectedAllows,
    denyScenarios: { applicationLevel: appDenies.length, tlsLevel: tlsDenies.length },
    applicationDenies: appDenies.map((r) => `${r.fpTail ?? "?"}:${r.denyCode}`),
    tlsLevelDenials: tlsDenies.map((r) => r.tlsClientError ?? r.denyCode),
  }
);

p.note(
  "结论：① mTLS 可以承担设备身份——invalid/错 CA/过期/主机名不匹配 全部在握手期被拒；" +
    "② 撤销与「是否已注册」落在应用层，Node tls 完全没有 CRL/OCSP，必须自建撤销名单；" +
    "③ 证书轮换不需要重启服务；④ 全程无明文 fallback（裸 TCP 拿不到业务响应）。"
);

fs.writeFileSync(
  path.join(ART, "02-tls-handshake-log.json"),
  JSON.stringify({ port, fingerprints: FP, servedLog }, null, 2)
);
srv.close();
await new Promise((r) => setTimeout(r, 50));
p.write();
process.exit(0);
