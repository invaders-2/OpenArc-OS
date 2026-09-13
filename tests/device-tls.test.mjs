/**
 * D3-03 · device-tls.test
 * 真实 mTLS 握手 + DeviceService 两层判定（TLS Certificate Validity ≠ Device Authorization）。
 *
 * 独立运行：node --test tests/device-tls.test.mjs
 * 覆盖：有效设备 / 未知客户端 / 错误 CA / 过期客户端 / 过期服务端 /
 *       hostname(service identity) mismatch / revoked & disabled 两层 /
 *       证书替换 / requestCert 未退化 / 明文回退缺失。
 *
 * 设备状态用 setDeviceStatus 直接置位而**不撤销凭据**，是为了专门隔离第二层：
 * 证书在密码学上仍有效（第一层通过），但 Registry 已判 REVOKED / DISABLED。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeviceFixture, pairDevice, deviceDomain } from "./device-fixtures.mjs";
import {
  createTestPki,
  startControlService,
  probeTls,
  scanPlaintextFallback,
  scanTlsDegradation,
  inspectCertificate,
} from "../experiments/d3-03/tls-control-service.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D3_DIR = path.resolve(HERE, "..", "experiments", "d3-03");
const SERVICE_SOURCE = path.join(D3_DIR, "tls-control-service.mjs");
const REASON = deviceDomain.REASON;
const STATUS = deviceDomain.DEVICE_STATUS;

// 全套真实 PKI + 真实 DeviceService。
const pki = createTestPki({ deviceCount: 4 });
const fx = await createDeviceFixture({ dbPath: ":memory:" });

const deviceA = await pairDevice(fx, { displayName: "Device A", fingerprint: pki.devices[0].fingerprint });
const deviceR = await pairDevice(fx, { displayName: "Device R", fingerprint: pki.devices[1].fingerprint });
const deviceD = await pairDevice(fx, { displayName: "Device D", fingerprint: pki.devices[2].fingerprint });
const deviceZ = await pairDevice(fx, { displayName: "Device Z", fingerprint: pki.devices[3].fingerprint });

// 只改 Registry 状态、不动凭据：凭据保持 ACTIVE，证书仍密码学有效。
fx.deviceStore.setDeviceStatus(deviceR.device.deviceId, STATUS.REVOKED, { expect: STATUS.ACTIVE });
fx.deviceStore.setDeviceStatus(deviceD.device.deviceId, STATUS.DISABLED, { expect: STATUS.ACTIVE });

const service = await startControlService({ pki, deviceService: fx.deviceService });
const expiredService = await startControlService({ pki, deviceService: fx.deviceService, serverCert: pki.expiredServer.cert, serverKey: pki.expiredServer.key });

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function probe(svc, opts) {
  const cursor = svc.tlsErrors.length;
  const r = await probeTls({ pki, port: svc.port, ...opts });
  await settle();
  r.serverTlsErrors = svc.tlsErrors.slice(cursor);
  return r;
}

after(async () => {
  await service.close();
  await expiredService.close();
  try {
    fx.identity.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(pki.dir, { recursive: true, force: true });
});

test("有效服务端 + 有效设备：允许，且返回 deviceId 与注册一致", async () => {
  const r = await probe(service, { client: pki.devices[0], authorizeAction: "device.use" });
  assert.equal(r.handshake, "SECURE");
  assert.equal(r.serverLine, "OK " + deviceA.device.deviceId);
  assert.equal(r.deviceId, deviceA.device.deviceId);
  assert.equal(r.authorize, "ALLOW");
});

test("未知客户端证书（未注册指纹）：DENY DEVICE_CREDENTIAL_UNKNOWN", async () => {
  assert.equal(fx.deviceStore.credentialByFingerprint(pki.unknownClient.fingerprint), null);
  const r = await probe(service, { client: pki.unknownClient });
  assert.equal(r.allow, false);
  assert.equal(r.reason, REASON.DEVICE_CREDENTIAL_UNKNOWN);
});

test("错误 CA 签发：握手失败，证书不被受信 CA 认可", async () => {
  const r = await probe(service, { client: pki.wrongCaClient });
  assert.equal(r.allow, false);
  assert.equal(r.serverLine, null);
  const info = inspectCertificate(pki.wrongCaClient.cert, { trustedCaPem: pki.ca.cert });
  assert.equal(info.trustedByCa, false);
});

test("过期客户端证书：DENY（crypto expired=true，签名仍受信）", async () => {
  const r = await probe(service, { client: pki.expiredClient });
  assert.equal(r.allow, false);
  assert.equal(r.serverLine, null);
  const info = inspectCertificate(pki.expiredClient.cert, { trustedCaPem: pki.ca.cert });
  assert.equal(info.expired, true);
  assert.equal(info.trustedByCa, true);
});

test("过期服务端证书：客户端校验失败 CERT_HAS_EXPIRED", async () => {
  const r = await probe(expiredService, { client: pki.devices[0] });
  assert.equal(r.handshake, "ERROR");
  assert.equal(r.clientError, "CERT_HAS_EXPIRED");
});

test("hostname / service identity mismatch：客户端显式 SAN 校验 DENY", async () => {
  const r = await probe(service, { client: pki.devices[0], servername: "evil-decoy.openarc.test", expectedServiceIdentity: "evil-decoy.openarc.test" });
  assert.equal(r.handshake, "ERROR");
  assert.equal(r.clientError, "SERVICE_IDENTITY_MISMATCH");
});

test("revoked device：第一层 authenticateConnection OK，第二层 authorizeDevice DENY DEVICE_REVOKED", async () => {
  const firstLayer = fx.deviceService.authenticateConnection({ fingerprint: pki.devices[1].fingerprint });
  assert.equal(firstLayer.ok, true);
  const r = await probe(service, { client: pki.devices[1], authorizeAction: "device.use" });
  assert.equal(r.serverLine, "OK " + deviceR.device.deviceId);
  assert.equal(r.authorize, "DENY");
  assert.equal(r.authorizeReason, REASON.DEVICE_REVOKED);
});

test("disabled device：第一层 authenticateConnection OK，第二层 authorizeDevice DENY DEVICE_DISABLED", async () => {
  const firstLayer = fx.deviceService.authenticateConnection({ fingerprint: pki.devices[2].fingerprint });
  assert.equal(firstLayer.ok, true);
  const r = await probe(service, { client: pki.devices[2], authorizeAction: "device.use" });
  assert.equal(r.serverLine, "OK " + deviceD.device.deviceId);
  assert.equal(r.authorize, "DENY");
  assert.equal(r.authorizeReason, REASON.DEVICE_DISABLED);
});

test("设备证书被替换（同 CN、未走旋转流程的新指纹）：DENY", async () => {
  assert.notEqual(pki.replacedClient.fingerprint, pki.devices[0].fingerprint);
  assert.match(pki.replacedClient.subjectCommonName, /device-a\.openarc\.test/);
  const r = await probe(service, { client: pki.replacedClient });
  assert.equal(r.allow, false);
  assert.equal(r.reason, REASON.DEVICE_CREDENTIAL_UNKNOWN);
});

test("requestCert 必须启用且未退化：无客户端证书被 TLS 层拒绝", async () => {
  assert.equal(service.tlsOptions.requestCert, true);
  assert.equal(service.tlsOptions.rejectUnauthorized, true);
  assert.equal(service.tlsOptions.minVersion, "TLSv1.2");
  assert.equal(scanTlsDegradation([SERVICE_SOURCE]).ok, true);
  const r = await probe(service, {});
  assert.equal(r.allow, false);
  assert.equal(r.serverLine, null);
  const codes = r.serverTlsErrors.map((e) => e.code).join(",");
  assert.match(codes, /PEER_DID_NOT_RETURN_A_CERTIFICATE/);
});

test("明文回退不存在：新增代码里没有任何明文 server 监听", () => {
  const files = fs.readdirSync(D3_DIR).filter((f) => f.endsWith(".mjs")).map((f) => path.join(D3_DIR, f));
  files.push(fileURLToPath(import.meta.url));
  const scan = scanPlaintextFallback(files);
  assert.equal(scan.findings.length, 0);
  assert.ok(scan.createServerCalls.length >= 1);
  assert.ok(scan.createServerCalls.every((c) => c.viaTls));
  assert.equal(scan.ok, true);
});

test("（附加）替换必须走旋转流程：旋转后新指纹允许、旧指纹 STALE", async () => {
  const rotate = fx.deviceService.rotateDeviceCredential({
    context: fx.adminCtx(),
    deviceId: deviceZ.device.deviceId,
    newIdentity: { fingerprint: pki.replacedClient.fingerprint, subject: "CN=device-a.openarc.test" },
  });
  assert.equal(rotate.ok, true);
  const afterNew = await probe(service, { client: pki.replacedClient });
  assert.equal(afterNew.deviceId, deviceZ.device.deviceId);
  const afterOld = await probe(service, { client: pki.devices[3] });
  assert.equal(afterOld.allow, false);
  assert.equal(afterOld.reason, REASON.DEVICE_CREDENTIAL_STALE);
});
