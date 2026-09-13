"use strict";

/**
 * D3-03 · TLS / mTLS 场景矩阵（真实 tls 握手，逐条 PASS/FAIL）。
 *
 * 每条都跑在真实的 node:tls 服务端 / 客户端上，任一条不符 -> process.exit(1)。
 * 覆盖：有效设备、未注册证书、错误 CA、过期客户端、过期服务端、
 *       hostname/service identity mismatch、requestCert 配置退化自检、
 *       明文回退缺失证明、REVOKED/DISABLED 两层判定、证书替换。
 */

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  createTestPki,
  startControlService,
  probeTls,
  scanPlaintextFallback,
  scanTlsDegradation,
  inspectCertificate,
} from "./tls-control-service.mjs";
import { createDeviceFixture, pairDevice } from "../../tests/device-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SOURCE = path.join(HERE, "tls-control-service.mjs");
const TEST_FILE = path.resolve(HERE, "..", "..", "tests", "device-tls.test.mjs");

function summarizeErrors(errors) {
  if (!errors || !errors.length) return "无";
  return errors
    .map((e) => (e.code || e.name || "?") + (e.message ? "(" + String(e.message).split("\n")[0].slice(0, 70) + ")" : ""))
    .join(" ; ");
}

/** 故意退化的服务端：requestCert:false —— 只用于证明"该配置 MUST NOT OCCUR"。 */
async function startDegenerateService(pki) {
  const state = { secureConnections: 0 };
  const server = tls.createServer(
    { key: pki.server.key, cert: pki.server.cert, ca: [pki.ca.cert], requestCert: false, rejectUnauthorized: false, minVersion: "TLSv1.2" },
    (socket) => {
      socket.end();
    },
  );
  server.on("secureConnection", () => {
    state.secureConnections++;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 匿名（不带客户端证书）连接退化服务端，观察它是否在 TLS 层被放行。 */
function probeAnonymous(pki, port) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({ host: "127.0.0.1", port, ca: [pki.ca.cert], minVersion: "TLSv1.2" });
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    socket.once("secureConnect", () => done({ accepted: true, protocol: socket.getProtocol() }));
    socket.once("error", (err) => done({ accepted: false, errorCode: err.code || err.name || "ERROR", message: err.message }));
    socket.once("close", () => done({ accepted: false, errorCode: "CLOSED" }));
    setTimeout(() => done({ accepted: false, errorCode: "TIMEOUT" }), 4000);
  });
}

export async function runTlsMatrix() {
  const results = [];
  const record = (ok, name, detail) => {
    results.push({ ok, name, detail });
    console.log((ok ? "PASS" : "FAIL") + " | " + name + " | " + detail);
    return ok;
  };

  const pki = createTestPki({ deviceCount: 4 });
  const fx = await createDeviceFixture({ dbPath: ":memory:" });
  let main = null;
  let expiredService = null;
  let degenerateService = null;

  const probe = async (service, opts) => {
    const cursor = service.tlsErrors.length;
    const r = await probeTls({ pki, port: service.port, ...opts });
    // 让服务端 tlsClientError 的最后一个 tick 落定，避免记到下一个场景头上。
    await new Promise((resolve) => setTimeout(resolve, 30));
    r.serverTlsErrors = service.tlsErrors.slice(cursor);
    return r;
  };

  try {
    const deviceA = await pairDevice(fx, { displayName: "Device A", fingerprint: pki.devices[0].fingerprint });
    const deviceR = await pairDevice(fx, { displayName: "Device R", fingerprint: pki.devices[1].fingerprint });
    const deviceD = await pairDevice(fx, { displayName: "Device D", fingerprint: pki.devices[2].fingerprint });
    const deviceZ = await pairDevice(fx, { displayName: "Device Z", fingerprint: pki.devices[3].fingerprint });

    // 关键：第二层隔离。只改 Registry 状态，**不动凭据**（凭据仍 ACTIVE），
    // 于是证书在密码学上完全有效（第一层 OK），但 Registry 已判 REVOKED / DISABLED。
    fx.deviceStore.setDeviceStatus(deviceR.device.deviceId, "REVOKED", { expect: "ACTIVE" });
    fx.deviceStore.setDeviceStatus(deviceD.device.deviceId, "DISABLED", { expect: "ACTIVE" });

    main = await startControlService({ pki, deviceService: fx.deviceService });
    console.log("[run-tls-matrix] PKI 临时目录: " + pki.dir);
    console.log("[run-tls-matrix] 有效 TLS 配置: requestCert=" + main.tlsOptions.requestCert + " rejectUnauthorized=" + main.tlsOptions.rejectUnauthorized + " minVersion=" + main.tlsOptions.minVersion);

    // ---- S1 valid server + valid device -------------------------------------
    {
      const r = await probe(main, { client: pki.devices[0], authorizeAction: "device.use" });
      const idMatch = r.deviceId === deviceA.device.deviceId;
      record(
        r.handshake === "SECURE" && r.serverLine === "OK " + deviceA.device.deviceId && idMatch && r.authorize === "ALLOW",
        "valid server + valid device -> 允许，deviceId 与注册一致",
        "serverLine=" + (r.serverLine || "-") + " 注册=" + deviceA.device.deviceId + " 一致=" + idMatch + "；第二层=" + (r.authorize || "-"),
      );
    }

    // ---- S2 unknown client certificate --------------------------------------
    {
      const r = await probe(main, { client: pki.unknownClient });
      record(r.deny === true && r.reason === "DEVICE_CREDENTIAL_UNKNOWN", "unknown client certificate（未注册指纹）-> DENY", "serverLine=" + (r.serverLine || "-") + "；crypto 指纹=" + pki.unknownClient.fingerprint.slice(0, 17) + "...");
    }

    // ---- S3 wrong CA --------------------------------------------------------
    {
      const r = await probe(main, { client: pki.wrongCaClient });
      const info = inspectCertificate(pki.wrongCaClient.cert, { trustedCaPem: pki.ca.cert });
      record(
        r.allow === false && r.serverLine == null && info.trustedByCa === false,
        "wrong CA（客户端证书由另一套 CA 签发）-> 握手失败/DENY",
        "无 OK；crypto verify(受信CA)=false；issuer=" + info.issuer.replace(/\n/g, "/") + "；serverTlsErrors=" + summarizeErrors(r.serverTlsErrors),
      );
    }

    // ---- S4 expired client certificate --------------------------------------
    {
      const r = await probe(main, { client: pki.expiredClient });
      const info = inspectCertificate(pki.expiredClient.cert, { trustedCaPem: pki.ca.cert });
      record(
        r.allow === false && r.serverLine == null && info.expired === true,
        "expired client certificate -> DENY",
        "无 OK；crypto expired=" + info.expired + "（validTo=" + info.validTo + "，签名仍受信=" + info.trustedByCa + "）；serverTlsErrors=" + summarizeErrors(r.serverTlsErrors),
      );
    }

    // ---- S5 expired server certificate --------------------------------------
    {
      expiredService = await startControlService({ pki, deviceService: fx.deviceService, serverCert: pki.expiredServer.cert, serverKey: pki.expiredServer.key });
      const r = await probe(expiredService, { client: pki.devices[0] });
      const info = inspectCertificate(pki.expiredServer.cert, { trustedCaPem: pki.ca.cert });
      record(
        r.handshake === "ERROR" && r.clientError === "CERT_HAS_EXPIRED",
        "expired server certificate -> 客户端校验失败",
        "clientError=" + r.clientError + " message=" + JSON.stringify(r.clientMessage) + "；crypto expired=" + info.expired + " validTo=" + info.validTo,
      );
    }

    // ---- S6 hostname / service identity mismatch ----------------------------
    {
      const badIdentity = "evil-decoy.openarc.test";
      const r = await probe(main, { client: pki.devices[0], servername: badIdentity, expectedServiceIdentity: badIdentity });
      record(
        r.handshake === "ERROR" && r.clientError === "SERVICE_IDENTITY_MISMATCH",
        "hostname / service identity mismatch -> DENY",
        "实现方式=servername + 客户端显式 SAN 校验(tls.connect.checkServerIdentity)；期望=" + badIdentity + " clientError=" + r.clientError + "：" + (r.clientMessage || ""),
      );
    }

    // ---- S7 requestCert 配置退化自检 (MUST NOT OCCUR) ------------------------
    {
      const real = await probe(main, {});
      const realRejected = real.allow === false && real.serverLine == null && (real.serverTlsErrors.length > 0 || real.clientError != null);
      const degradationScan = scanTlsDegradation([SERVICE_SOURCE]);
      degenerateService = await startDegenerateService(pki);
      const anonymous = await probeAnonymous(pki, degenerateService.port);
      const configStrict = main.tlsOptions.requestCert === true && main.tlsOptions.rejectUnauthorized === true && main.tlsOptions.minVersion === "TLSv1.2";
      record(
        configStrict && degradationScan.ok && realRejected && anonymous.accepted === true,
        "requestCert 未启用 -> MUST NOT OCCUR（配置退化自检）",
        "真实服务 requestCert=" + main.tlsOptions.requestCert + "/rejectUnauthorized=" + main.tlsOptions.rejectUnauthorized + "；无客户端证书在 TLS 层被拒(" + summarizeErrors(real.serverTlsErrors) + " clientError=" + (real.clientError || "无") + "）；反例 requestCert=false 的退化服务放行匿名 socket=" + anonymous.accepted + "（secureConnection=" + degenerateService.state.secureConnections + "）-> 标记 MUST NOT OCCUR",
      );
    }

    // ---- S8 plaintext fallback 缺失证明 -------------------------------------
    {
      const d3Files = fs.readdirSync(HERE).filter((f) => f.endsWith(".mjs")).map((f) => path.join(HERE, f));
      const scanFiles = fs.existsSync(TEST_FILE) ? [...d3Files, TEST_FILE] : d3Files;
      const scan = scanPlaintextFallback(scanFiles);
      record(
        scan.ok === true,
        "plaintext fallback -> 证明不存在（静态扫描）",
        "扫描 " + scanFiles.length + " 个新增文件：明文监听入口=" + scan.findings.length + "；createServer 调用=" + scan.createServerCalls.length + " 次，全部经 tls.createServer=" + scan.createServerCalls.every((c) => c.viaTls),
      );
    }

    // ---- S9 revoked device：两层都必须过 ------------------------------------
    {
      const firstLayer = fx.deviceService.authenticateConnection({ fingerprint: pki.devices[1].fingerprint });
      const r = await probe(main, { client: pki.devices[1], authorizeAction: "device.use" });
      record(
        firstLayer.ok === true && r.serverLine === "OK " + deviceR.device.deviceId && r.authorize === "DENY" && r.authorizeReason === "DEVICE_REVOKED",
        "revoked device（证书仍密码学有效）-> 第一层 OK，第二层 DENY DEVICE_REVOKED",
        "第一层 authenticateConnection=" + (firstLayer.ok ? "ALLOW" : "DENY:" + firstLayer.error) + "；TLS serverLine=" + (r.serverLine || "-") + "；第二层=" + (r.authorize || "-") + " " + (r.authorizeReason || ""),
      );
    }

    // ---- S10 disabled device：两层都必须过 ----------------------------------
    {
      const firstLayer = fx.deviceService.authenticateConnection({ fingerprint: pki.devices[2].fingerprint });
      const r = await probe(main, { client: pki.devices[2], authorizeAction: "device.use" });
      record(
        firstLayer.ok === true && r.serverLine === "OK " + deviceD.device.deviceId && r.authorize === "DENY" && r.authorizeReason === "DEVICE_DISABLED",
        "disabled device（证书仍密码学有效）-> 第一层 OK，第二层 DENY DEVICE_DISABLED",
        "第一层 authenticateConnection=" + (firstLayer.ok ? "ALLOW" : "DENY:" + firstLayer.error) + "；TLS serverLine=" + (r.serverLine || "-") + "；第二层=" + (r.authorize || "-") + " " + (r.authorizeReason || ""),
      );
    }

    // ---- S11 证书被替换（未走旋转流程） -------------------------------------
    {
      const r = await probe(main, { client: pki.replacedClient });
      const sameSubject = /device-a\.openarc\.test/.test(pki.replacedClient.subjectCommonName);
      const differentKey = pki.replacedClient.fingerprint !== pki.devices[0].fingerprint;
      record(
        r.deny === true && r.reason === "DEVICE_CREDENTIAL_UNKNOWN" && sameSubject && differentKey,
        "设备证书被替换（未走旋转流程的新指纹）-> DENY",
        "同 subject=device-a、新指纹=" + pki.replacedClient.fingerprint.slice(0, 17) + "... != 注册指纹；serverLine=" + (r.serverLine || "-"),
      );
    }

    // ---- S12（附加）走旋转流程 -> 新指纹允许、旧指纹 STALE -------------------
    {
      const rotate = fx.deviceService.rotateDeviceCredential({
        context: fx.adminCtx(),
        deviceId: deviceZ.device.deviceId,
        newIdentity: { fingerprint: pki.replacedClient.fingerprint, subject: "CN=device-a.openarc.test" },
      });
      const afterNew = await probe(main, { client: pki.replacedClient });
      const afterOld = await probe(main, { client: pki.devices[3] });
      record(
        rotate.ok === true && afterNew.deviceId === deviceZ.device.deviceId && afterOld.deny === true && afterOld.reason === "DEVICE_CREDENTIAL_STALE",
        "（附加）替换必须走旋转流程：旋转后新指纹允许、旧指纹 STALE",
        "rotate.ok=" + rotate.ok + "；新证书=" + (afterNew.serverLine || afterNew.reason) + "；旧证书=" + (afterOld.serverLine || afterOld.reason),
      );
    }
  } finally {
    if (main) await main.close();
    if (expiredService) await expiredService.close();
    if (degenerateService) await degenerateService.close();
    try { fx.identity.close(); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("[run-tls-matrix] " + (results.length - failed.length) + "/" + results.length + " 场景通过" + (failed.length ? "；FAIL: " + failed.map((f) => f.name).join(" / ") : ""));
  return { ok: failed.length === 0, results };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runTlsMatrix()
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => {
      console.error("run-tls-matrix 崩溃:", err);
      process.exit(1);
    });
}
