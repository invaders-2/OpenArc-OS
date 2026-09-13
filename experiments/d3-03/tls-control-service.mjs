"use strict";

/**
 * D3-03 · TLS / mTLS 控制服务原型（真实 node:tls，不是 mock）。
 *
 * 这一层解决规格里**第一层**的问题：「这条 TLS 连接是谁」。
 * 它**不做**授权结论 —— 授权是 DeviceService.authorizeDevice 的第二层，
 * 两层都必须过（§24：TLS Certificate Validity ≠ Device Authorization）。
 *
 * 本文件只有三件事：
 *   1. createTestPki()       —— 用 node:crypto 的密钥能力 + 自建 X.509 证书生成
 *                               测试 CA / 服务端 / 设备客户端证书，全部写到临时目录；
 *   2. startControlService() —— tls.createServer({ requestCert:true, rejectUnauthorized:true,
 *                               ca, cert, key, minVersion:'TLSv1.2' })，握手后按
 *                               peer certificate 的 sha256 指纹调用
 *                               DeviceService.authenticateConnection()；
 *   3. probeTls()/connectDeviceClient() —— 真实 tls.connect 的客户端探针，供矩阵/测试复用。
 *
 * 三条硬约束：
 *   ① **禁止明文回退**：本文件不 import node:net / node:http / node:http2，
 *      任何监听都必须经 tls.createServer（scanPlaintextFallback 会静态证明这一点）；
 *   ② 指纹规范与 device-store 存的指纹一致：sha256、大写、冒号分隔十六进制；
 *   ③ 所有私钥只落在 fs.mkdtempSync(os.tmpdir()) 下，绝不写进仓库。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

export const DEFAULT_SERVICE_IDENTITY = "openarc-control.local";
export const TLS_PROTOCOL_MIN = "TLSv1.2";

// ---------------------------------------------------------------------------
// 0. 指纹规范：与 device-store 里存的形式保持同一种（sha256 大写冒号十六进制）
// ---------------------------------------------------------------------------

/** 任意 Node 指纹写法（大小写 / 有无冒号）→ 统一成 AA:BB:... 形式。 */
export function normalizeFingerprint(input) {
  const hex = String(input == null ? "" : input).replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (!hex || hex.length % 2 !== 0) return "";
  return hex.match(/../g).join(":");
}

/** 从 PEM / DER Buffer / X509Certificate / PeerCertificate 取规范指纹。 */
export function fingerprint256Of(what) {
  if (what == null) return null;
  if (typeof what === "string") return normalizeFingerprint(new crypto.X509Certificate(what).fingerprint256);
  if (Buffer.isBuffer(what)) return normalizeFingerprint(new crypto.X509Certificate(what).fingerprint256);
  if (what instanceof crypto.X509Certificate) return normalizeFingerprint(what.fingerprint256);
  if (what.raw && what.raw.length) return normalizeFingerprint(new crypto.X509Certificate(what.raw).fingerprint256);
  if (what.fingerprint256) return normalizeFingerprint(what.fingerprint256);
  return null;
}

/** 握手后的 peer certificate（PeerCertificate）→ 规范指纹。 */
export function peerFingerprint(peer) {
  return fingerprint256Of(peer);
}

// ---------------------------------------------------------------------------
// 1. 最小 X.509 / ASN.1 DER 生成器（只用 node:crypto，无第三方依赖）
// ---------------------------------------------------------------------------

const OID_COMMON_NAME = "2.5.4.3";
const OID_ORGANIZATION = "2.5.4.10";
const OID_COUNTRY = "2.5.4.6";
const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), derLength(v.length), v]);
}

const derSeq = (...parts) => tlv(0x30, Buffer.concat(parts));
const derSet = (...parts) => tlv(0x31, Buffer.concat(parts));

function derInt(value) {
  let buf;
  if (typeof value === "bigint") {
    let v = value;
    const bytes = [];
    if (v === 0n) bytes.push(0);
    while (v > 0n) {
      bytes.unshift(Number(v & 0xffn));
      v >>= 8n;
    }
    buf = Buffer.from(bytes);
  } else if (typeof value === "number") {
    let v = value;
    const bytes = [];
    if (v === 0) bytes.push(0);
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v = Math.floor(v / 256);
    }
    buf = Buffer.from(bytes);
  } else if (Buffer.isBuffer(value)) {
    buf = Buffer.from(value);
  } else {
    buf = Buffer.from(String(value), "hex");
  }
  while (buf.length > 1 && buf[0] === 0 && (buf[1] & 0x80) === 0) buf = buf.subarray(1);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

function derOid(oid) {
  const parts = oid.split(".").map(Number);
  const first = 40 * parts[0] + parts[1];
  const rest = [];
  for (const arc of parts.slice(2)) {
    const stack = [arc & 0x7f];
    let q = Math.floor(arc / 128);
    while (q > 0) {
      stack.unshift((q & 0x7f) | 0x80);
      q = Math.floor(q / 128);
    }
    rest.push(...stack);
  }
  return tlv(0x06, Buffer.from([first, ...rest]));
}

function rdn(oid, value, tag = 0x0c) {
  return derSet(derSeq(derOid(oid), tlv(tag, Buffer.from(String(value), "utf8"))));
}

function x509Name({ commonName, organization = "OpenArc Test", country = "US" }) {
  const parts = [];
  if (country) parts.push(rdn(OID_COUNTRY, country, 0x13));
  if (organization) parts.push(rdn(OID_ORGANIZATION, organization));
  parts.push(rdn(OID_COMMON_NAME, commonName));
  return derSeq(...parts);
}

function x509Time(date) {
  const year = date.getUTCFullYear();
  const p = (n) => String(n).padStart(2, "0");
  if (year >= 1950 && year <= 2049) {
    return tlv(0x17, Buffer.from(p(year % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + "Z", "ascii"));
  }
  return tlv(0x18, Buffer.from(String(year) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + "Z", "ascii"));
}

function derBitString(unusedBits, bytes) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), Buffer.from(bytes)]));
}

function pemToDer(pem) {
  return Buffer.from(String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

function derToPem(der, label) {
  const body = der.toString("base64").match(/.{1,64}/g).join("\n");
  return "-----BEGIN " + label + "-----\n" + body + "\n-----END " + label + "-----\n";
}

function x509Extension(oid, critical, valueDer) {
  const parts = [derOid(oid)];
  if (critical) parts.push(tlv(0x01, Buffer.from([0xff])));
  parts.push(tlv(0x04, valueDer));
  return derSeq(...parts);
}

function basicConstraints(ca, pathLen = null) {
  const parts = [];
  if (ca) parts.push(tlv(0x01, Buffer.from([0xff])));
  if (pathLen != null) parts.push(derInt(pathLen));
  return derSeq(...parts);
}

function extendedKeyUsage(...oids) {
  return derSeq(...oids.map(derOid));
}

function subjectAltName(entries) {
  return derSeq(
    ...entries.map((e) => {
      if (e.type === "dns") return tlv(0x82, Buffer.from(e.value, "ascii"));
      if (e.type === "ip") return tlv(0x87, Buffer.from(e.value.split(".").map(Number)));
      throw new Error("unsupported SAN type: " + e.type);
    }),
  );
}

const SHA256_RSA_ALGORITHM = derSeq(derOid(OID_SHA256_WITH_RSA), tlv(0x05, Buffer.alloc(0)));

function tbsCertificate({ serial, issuerName, subjectName, notBefore, notAfter, spkiDer, isCa, sans, ekuValues, keyUsageDer }) {
  const extensions = [];
  extensions.push(x509Extension(OID_BASIC_CONSTRAINTS, true, basicConstraints(isCa)));
  extensions.push(x509Extension(OID_KEY_USAGE, true, keyUsageDer));
  if (ekuValues && ekuValues.length) extensions.push(x509Extension(OID_EXT_KEY_USAGE, false, extendedKeyUsage(...ekuValues)));
  if (sans && sans.length) extensions.push(x509Extension(OID_SUBJECT_ALT_NAME, false, subjectAltName(sans)));
  return derSeq(
    tlv(0xa0, derInt(2)),
    derInt(serial),
    SHA256_RSA_ALGORITHM,
    issuerName,
    derSeq(x509Time(notBefore), x509Time(notAfter)),
    subjectName,
    spkiDer,
    tlv(0xa3, derSeq(...extensions)),
  );
}

function randomSerial() {
  const buf = crypto.randomBytes(9);
  buf[0] &= 0x7f;
  if (buf[0] === 0) buf[0] = 1;
  return buf;
}

function newRsaKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

/**
 * 签发一张真实的 X.509 证书。
 * @param opts.subject        subject Name（{commonName, organization, country}）
 * @param opts.issuer         issuer Name（CA 自签时与 subject 相同）
 * @param opts.publicKey      被签发者的 SPKI PEM
 * @param opts.signerKey      签发者私钥 PEM（PKCS#8）
 * @param opts.isCa           basicConstraints CA
 * @param opts.keyUsage       {unused, bytes}
 * @param opts.eku            extendedKeyUsage OID 数组
 * @param opts.sans           subjectAltName [{type:'dns'|'ip', value}]
 */
function issueCertificate({ subject, issuer, publicKey, signerKey, isCa, keyUsage, eku = null, sans = null, notBefore, notAfter }) {
  const spkiDer = pemToDer(publicKey);
  const tbs = tbsCertificate({
    serial: randomSerial(),
    issuerName: issuer,
    subjectName: subject,
    notBefore,
    notAfter,
    spkiDer,
    isCa,
    sans,
    ekuValues: eku,
    keyUsageDer: derBitString(keyUsage.unused, keyUsage.bytes),
  });
  const signature = crypto.sign("sha256", tbs, signerKey);
  const der = derSeq(tbs, SHA256_RSA_ALGORITHM, derBitString(0, signature));
  return derToPem(der, "CERTIFICATE");
}

// keyUsage：CA = keyCertSign(5)+cRLSign(6)；服务端 = digitalSignature(0)+keyEncipherment(2)；
// 客户端 = digitalSignature(0)。（bit 0 = 首字节最高位）
const KEY_USAGE_CA = Object.freeze({ unused: 1, bytes: [0x06] });
const KEY_USAGE_SERVER = Object.freeze({ unused: 5, bytes: [0xa0] });
const KEY_USAGE_CLIENT = Object.freeze({ unused: 7, bytes: [0x80] });

// ---------------------------------------------------------------------------
// 2. createTestPki：生成全套测试 PKI 并落盘到临时目录
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} [opts.dir]           写入目录，缺省 fs.mkdtempSync(os.tmpdir())
 * @param {number} [opts.deviceCount]   正常设备证书数量（device-a / device-b ...）
 * @returns {object} pki 句柄（含 ca / wrongCa / server / expiredServer / devices / 各种特殊客户端）
 */
export function createTestPki({ dir = null, deviceCount = 4, validDays = 365 } = {}) {
  const baseDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), "openarc-d3-03-tls-"));
  fs.mkdirSync(baseDir, { recursive: true });
  const written = [];
  const write = (name, text) => {
    const p = path.join(baseDir, name);
    fs.writeFileSync(p, text);
    written.push(p);
    return p;
  };
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const common = { notBefore: new Date(now - day), notAfter: new Date(now + validDays * day) };

  const caName = x509Name({ commonName: "OpenArc D3-03 Test Root CA", organization: "OpenArc D3-03" });
  const caKeys = newRsaKeyPair();
  const caCert = issueCertificate({ subject: caName, issuer: caName, publicKey: caKeys.publicKey, signerKey: caKeys.privateKey, isCa: true, keyUsage: KEY_USAGE_CA, ...common });

  const wrongCaName = x509Name({ commonName: "OpenArc D3-03 Wrong CA", organization: "Not Trusted" });
  const wrongCaKeys = newRsaKeyPair();
  const wrongCaCert = issueCertificate({ subject: wrongCaName, issuer: wrongCaName, publicKey: wrongCaKeys.publicKey, signerKey: wrongCaKeys.privateKey, isCa: true, keyUsage: KEY_USAGE_CA, ...common });

  const serverName = x509Name({ commonName: DEFAULT_SERVICE_IDENTITY, organization: "OpenArc D3-03" });
  const serverSans = [{ type: "dns", value: "localhost" }, { type: "dns", value: DEFAULT_SERVICE_IDENTITY }, { type: "ip", value: "127.0.0.1" }];
  const serverKeys = newRsaKeyPair();
  const serverCert = issueCertificate({ subject: serverName, issuer: caName, publicKey: serverKeys.publicKey, signerKey: caKeys.privateKey, isCa: false, keyUsage: KEY_USAGE_SERVER, eku: [OID_EKU_SERVER_AUTH], sans: serverSans, ...common });

  const expiredServerKeys = newRsaKeyPair();
  const expiredServerCert = issueCertificate({
    subject: serverName,
    issuer: caName,
    publicKey: expiredServerKeys.publicKey,
    signerKey: caKeys.privateKey,
    isCa: false,
    keyUsage: KEY_USAGE_SERVER,
    eku: [OID_EKU_SERVER_AUTH],
    sans: serverSans,
    notBefore: new Date(now - 3 * validDays * day),
    notAfter: new Date(now - 2 * validDays * day),
  });

  const buildClient = (name, { subjectCommonName, issuerName, signerKey, validity = common } = {}) => {
    const keys = newRsaKeyPair();
    const cert = issueCertificate({
      subject: x509Name({ commonName: subjectCommonName || name + ".openarc.test", organization: "OpenArc D3-03" }),
      issuer: issuerName || caName,
      publicKey: keys.publicKey,
      signerKey: signerKey || caKeys.privateKey,
      isCa: false,
      keyUsage: KEY_USAGE_CLIENT,
      eku: [OID_EKU_CLIENT_AUTH],
      ...validity,
    });
    const certPath = write("client-" + name + ".pem", cert);
    const keyPath = write("client-" + name + "-key.pem", keys.privateKey);
    return { name, subjectCommonName: subjectCommonName || name + ".openarc.test", cert, key: keys.privateKey, certPath, keyPath, fingerprint: normalizeFingerprint(new crypto.X509Certificate(cert).fingerprint256) };
  };

  const devices = [];
  for (let i = 0; i < deviceCount; i++) {
    const suffix = String.fromCharCode(97 + i); // a, b, c, d ...
    devices.push(buildClient("device-" + suffix, { subjectCommonName: "device-" + suffix + ".openarc.test" }));
  }

  // 未注册（但由受信 CA 签发、密码学有效）的客户端 —— unknown client
  const unknownClient = buildClient("unknown", { subjectCommonName: "device-unknown.openarc.test" });
  // 错误 CA 签发 —— wrong CA
  const wrongCaClient = buildClient("wrong-ca", { subjectCommonName: "device-wrongca.openarc.test", issuerName: wrongCaName, signerKey: wrongCaKeys.privateKey });
  // 已过期客户端 —— expired client
  const expiredClient = buildClient("expired", {
    subjectCommonName: "device-expired.openarc.test",
    validity: { notBefore: new Date(now - 3 * validDays * day), notAfter: new Date(now - 2 * validDays * day) },
  });
  // 与 device-a 同 subject、但新密钥的新指纹 —— 未走旋转流程的"被替换证书"
  const replacedClient = buildClient("replaced", { subjectCommonName: "device-a.openarc.test" });

  write("ca.pem", caCert);
  write("ca-key.pem", caKeys.privateKey);
  write("wrong-ca.pem", wrongCaCert);
  write("wrong-ca-key.pem", wrongCaKeys.privateKey);
  write("server.pem", serverCert);
  write("server-key.pem", serverKeys.privateKey);
  write("server-expired.pem", expiredServerCert);
  write("server-expired-key.pem", expiredServerKeys.privateKey);

  const describe = (entry) => ({ name: entry.name, subjectCommonName: entry.subjectCommonName, cert: entry.cert, key: entry.key, certPath: entry.certPath, keyPath: entry.keyPath, fingerprint: entry.fingerprint });

  return {
    dir: baseDir,
    files: written,
    ca: { cert: caCert, key: caKeys.privateKey, certPath: path.join(baseDir, "ca.pem"), name: "OpenArc D3-03 Test Root CA" },
    wrongCa: { cert: wrongCaCert, key: wrongCaKeys.privateKey, certPath: path.join(baseDir, "wrong-ca.pem"), name: "OpenArc D3-03 Wrong CA" },
    server: { cert: serverCert, key: serverKeys.privateKey, certPath: path.join(baseDir, "server.pem"), keyPath: path.join(baseDir, "server-key.pem"), fingerprint: normalizeFingerprint(new crypto.X509Certificate(serverCert).fingerprint256), sans: ["localhost", DEFAULT_SERVICE_IDENTITY, "127.0.0.1"] },
    expiredServer: { cert: expiredServerCert, key: expiredServerKeys.privateKey, certPath: path.join(baseDir, "server-expired.pem"), keyPath: path.join(baseDir, "server-expired-key.pem") },
    devices: devices.map(describe),
    unknownClient: describe(unknownClient),
    wrongCaClient: describe(wrongCaClient),
    expiredClient: describe(expiredClient),
    replacedClient: describe(replacedClient),
  };
}

// ---------------------------------------------------------------------------
// 3. 服务端身份校验（客户端侧）：显式校验服务端证书 SAN
// ---------------------------------------------------------------------------

/**
 * 显式 SAN 校验，作为 tls.connect({ checkServerIdentity }) 注入。
 * 匹配 → undefined（放行）；不匹配 → 返回带 code=SERVICE_IDENTITY_MISMATCH 的 Error。
 *
 * 我们**不用** Node 默认的报错文案（ERR_TLS_CERT_ALTNAME_INVALID），
 * 而是把原因固定成 device-domain 里的 REASON.SERVICE_IDENTITY_MISMATCH，
 * 这样矩阵输出里的原因码与服务端语义一致。
 */
export function verifyServiceIdentity(hostname, cert, expected = null) {
  const expectedName = expected || hostname;
  let dns = [];
  let ips = [];
  let cn = "";
  try {
    const x509 = cert && cert.raw && cert.raw.length ? new crypto.X509Certificate(cert.raw) : null;
    const alt = (x509 && x509.subjectAltName) || (cert && cert.subjectaltname) || "";
    dns = [...String(alt).matchAll(/DNS:([^,\n]+)/g)].map((m) => m[1].trim());
    ips = [...String(alt).matchAll(/IP Address:([^,\n]+)/g)].map((m) => m[1].trim());
    if (x509) cn = (String(x509.subject).match(/CN=([^,\n]+)/) || [])[1] || "";
  } catch {
    /* 解析失败按不匹配处理 */
  }
  const matched = dns.includes(expectedName) || ips.includes(expectedName) || (dns.length === 0 && ips.length === 0 && cn === expectedName);
  if (matched) return undefined;
  const err = new Error("SERVICE_IDENTITY_MISMATCH: expected '" + expectedName + "', 服务端证书 SAN DNS=[" + dns.join(", ") + "] IP=[" + ips.join(", ") + "]");
  err.code = "SERVICE_IDENTITY_MISMATCH";
  err.reason = "SERVICE_IDENTITY_MISMATCH";
  err.expectedServiceIdentity = expectedName;
  return err;
}

// ---------------------------------------------------------------------------
// 4. startControlService：真实 mTLS 监听
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.pki             createTestPki() 结果
 * @param {object} opts.deviceService   DeviceService 实例（authenticateConnection / authorizeDevice）
 * @param {number} [opts.port]          0 = 随机端口
 * @param {string} [opts.host]
 * @param {string} [opts.serverCert]    覆盖服务端证书（如"过期服务端证书"场景）
 * @param {string} [opts.serverKey]
 * @param {function} [opts.resolveActor] 第二层授权用的 actor（缺省 ADMIN）
 * @param {string} [opts.requestIdPrefix]
 * @returns {Promise<{server, port, tlsOptions, tlsErrors, secureConnections, close}>}
 */
export async function startControlService({ pki, deviceService, port = 0, host = "127.0.0.1", serverCert = null, serverKey = null, resolveActor = null, requestIdPrefix = "tls" } = {}) {
  if (!pki) throw new Error("startControlService 需要 pki");
  if (!deviceService) throw new Error("startControlService 需要 deviceService");

  // 唯一允许的监听入口：tls.createServer，且强制要求客户端证书。
  const tlsOptions = Object.freeze({
    key: serverKey || pki.server.key,
    cert: serverCert || pki.server.cert,
    ca: [pki.ca.cert],
    requestCert: true,          // 必须要求客户端证书（配置退化自检的核心）
    rejectUnauthorized: true,   // 客户端证书必须通过 CA / 有效期校验
    minVersion: TLS_PROTOCOL_MIN,
  });

  const tlsErrors = [];
  const secureConnections = [];
  const defaultActor = (auth) => ({ userId: auth.device.registered_by || null, role: "ADMIN", organizationId: auth.device.organization_id });

  const server = tls.createServer(tlsOptions, (socket) => {
    const peer = socket.getPeerCertificate();
    const fingerprint = peerFingerprint(peer);
    secureConnections.push({ fingerprint, authorized: socket.authorized, protocol: socket.getProtocol(), at: Date.now() });
    const requestId = requestIdPrefix + "-" + secureConnections.length;
    const auth = deviceService.authenticateConnection({ fingerprint, requestId });

    // 第一层不过：DENY + 关闭，绝不做"无证书也放行"的降级。
    if (!auth.ok) {
      socket.write("DENY " + auth.error + "\n");
      socket.end();
      return;
    }

    socket.write("OK " + auth.device.id + "\n");

    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const [command, arg] = line.split(/\s+/);
        if (command === "AUTHORIZE") {
          // 第二层：即使 TLS 已经证明"这是谁"，Registry 仍要再判一次。
          const actor = typeof resolveActor === "function" ? resolveActor(auth) : defaultActor(auth);
          const verdict = deviceService.authorizeDevice({ device: auth.device, action: arg, actor, credential: auth.credential });
          socket.write(verdict.ok ? "ALLOW\n" : "DENY " + verdict.error + "\n");
        } else if (command === "PING") {
          socket.write("PONG\n");
        } else {
          socket.write("DENY INVALID_INPUT\n");
        }
      }
    });
  });

  server.on("tlsClientError", (err) => {
    tlsErrors.push(describeTlsError(err));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    host,
    port: server.address().port,
    tlsOptions,
    tlsErrors,
    secureConnections,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 把 OpenSSL / Node 的握手错误压成可打印的形状。 */
export function describeTlsError(err) {
  if (!err) return { message: "unknown" };
  return {
    code: err.code || null,
    reason: err.reason || null,
    message: err.message || String(err),
    openssl: Array.isArray(err.opensslErrorStack) ? err.opensslErrorStack.join(" | ") : null,
  };
}

// ---------------------------------------------------------------------------
// 5. 客户端探针（真实 tls.connect）
// ---------------------------------------------------------------------------

function createLineReader(socket) {
  let buffer = "";
  const queued = [];
  const waiters = [];
  let closed = false;
  const deliver = (line) => {
    if (waiters.length) waiters.shift()(line);
    else queued.push(line);
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      deliver(line);
    }
  });
  const onEnd = () => {
    if (closed) return;
    closed = true;
    if (buffer.trim()) deliver(buffer.trim());
    buffer = "";
    while (waiters.length) waiters.shift()(null);
  };
  socket.on("close", onEnd);
  socket.on("end", onEnd);
  socket.on("error", () => {
    /* 握手/连接错误由 probeTls 的 error 监听负责 */
  });
  return {
    next(timeoutMs = 4000) {
      if (queued.length) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
  };
}

/**
 * 建立一条真实 mTLS 连接（供更细粒度的用证复用）。
 * 成功 → { status:"SECURE", socket, reader, peerFingerprint, protocol, authorized }
 * 失败 → { status:"ERROR"|"CLOSED"|"TIMEOUT", errorCode, message }
 */
export async function connectDeviceClient({ pki, client = null, port, host = "127.0.0.1", servername = DEFAULT_SERVICE_IDENTITY, expectedServiceIdentity = null, explicitSanCheck = true, ca = null, timeoutMs = 5000 } = {}) {
  const expected = expectedServiceIdentity == null ? servername : expectedServiceIdentity;
  const connectOptions = { host, port, minVersion: TLS_PROTOCOL_MIN, ca: ca || [pki.ca.cert], servername };
  if (client) {
    connectOptions.cert = client.cert;
    connectOptions.key = client.key;
  }
  if (explicitSanCheck) connectOptions.checkServerIdentity = (h, cert) => verifyServiceIdentity(h, cert, expected);

  const socket = tls.connect(connectOptions);
  const reader = createLineReader(socket);
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      finish("SECURE");
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      finish({ status: "ERROR", errorCode: err.code || err.name || "ERROR", message: err.message });
    });
    socket.once("close", () => {
      clearTimeout(timer);
      finish("CLOSED");
    });
  });

  if (outcome === "SECURE") {
    return { status: "SECURE", socket, reader, peerFingerprint: peerFingerprint(socket.getPeerCertificate()), protocol: socket.getProtocol(), authorized: socket.authorized, connectOptions, expectedServiceIdentity: expected, servername };
  }
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
  if (typeof outcome === "object") return { status: "ERROR", errorCode: outcome.errorCode, message: outcome.message, connectOptions, expectedServiceIdentity: expected, servername };
  return { status: outcome, connectOptions, expectedServiceIdentity: expected, servername };
}

/**
 * 一次完整的探针：握手 → 读服务端第一行 → 可选 AUTHORIZE → 读第二行。
 * 无论握手失败还是业务 DENY，都返回结构化结果而**不抛异常**，方便矩阵逐条判定。
 */
export async function probeTls({ pki, client = null, port, host = "127.0.0.1", servername = DEFAULT_SERVICE_IDENTITY, expectedServiceIdentity = null, explicitSanCheck = true, authorizeAction = null, ca = null, timeoutMs = 5000 } = {}) {
  const conn = await connectDeviceClient({ pki, client, port, host, servername, expectedServiceIdentity, explicitSanCheck, ca, timeoutMs });
  const result = {
    handshake: conn.status,
    servername: conn.servername,
    expectedServiceIdentity: conn.expectedServiceIdentity,
    explicitSanCheck,
    clientError: conn.errorCode || null,
    clientMessage: conn.message || null,
    peerFingerprint: conn.peerFingerprint || null,
    protocol: conn.protocol || null,
    authorizeAction,
  };
  if (conn.status !== "SECURE") {
    result.allow = false;
    result.deny = true;
    return result;
  }

  const socket = conn.socket;
  const first = await conn.reader.next(timeoutMs);
  result.serverLine = first;
  const okMatch = /^OK\s+(\S+)$/.exec(first || "");
  const denyMatch = /^DENY\s+(\S+)$/.exec(first || "");
  if (okMatch) {
    result.deviceId = okMatch[1];
    result.allow = true;
    result.deny = false;
    if (authorizeAction) {
      socket.write("AUTHORIZE " + authorizeAction + "\n");
      const second = await conn.reader.next(timeoutMs);
      result.authorizeLine = second;
      if (/^ALLOW$/.test(second || "")) {
        result.authorize = "ALLOW";
      } else {
        const ad = /^DENY\s+(\S+)$/.exec(second || "");
        result.authorize = "DENY";
        result.authorizeReason = ad ? ad[1] : second || null;
      }
    }
  } else if (denyMatch) {
    result.reason = denyMatch[1];
    result.allow = false;
    result.deny = true;
  } else {
    // 握手在 TLS 层被服务端中止：客户端拿不到任何协议行。
    result.allow = false;
    result.deny = true;
    result.reason = result.clientError || "TLS_HANDSHAKE_REJECTED";
  }
  try {
    socket.end();
    socket.destroy();
  } catch {
    /* ignore */
  }
  return result;
}

// ---------------------------------------------------------------------------
// 6. 静态自检：明文回退 / TLS 配置退化
// ---------------------------------------------------------------------------

export const PLAINTEXT_LISTENER_PATTERNS = Object.freeze([
  { id: "import node:net", re: /(?:require\(\s*["']node:net["']\s*\)|from\s+["']node:net["'])/ },
  { id: "import node:http", re: /(?:require\(\s*["']node:http["']\s*\)|from\s+["']node:http["'])/ },
  { id: "import node:http2", re: /(?:require\(\s*["']node:http2["']\s*\)|from\s+["']node:http2["'])/ },
  { id: "net.createServer", re: /\bnet\.createServer\s*\(/ },
  { id: "http.createServer", re: /\bhttp\.createServer\s*\(/ },
  { id: "http2.createServer", re: /\bhttp2\.createServer\s*\(/ },
  { id: "new net.Server", re: /\bnew\s+net\.Server\s*\(/ },
]);

/** 扫描给定文件：不存在任何明文监听入口，且所有 createServer 都是 tls.createServer。 */
export function scanPlaintextFallback(files) {
  const findings = [];
  const createServerCalls = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const pattern of PLAINTEXT_LISTENER_PATTERNS) {
      const m = pattern.re.exec(src);
      if (m) findings.push({ file, pattern: pattern.id, excerpt: src.slice(Math.max(0, m.index - 30), m.index + 40) });
    }
    const re = /createServer\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const prefix = src.slice(Math.max(0, m.index - 5), m.index);
      createServerCalls.push({ file, viaTls: /tls\.\s*$/.test(prefix) });
    }
  }
  const nonTls = createServerCalls.filter((c) => !c.viaTls);
  return { ok: findings.length === 0 && nonTls.length === 0, findings, createServerCalls, scanned: files };
}

export const TLS_DEGRADATION_PATTERNS = Object.freeze([
  { id: "requestCert disabled", re: /requestCert\s*:\s*false/ },
  { id: "rejectUnauthorized disabled", re: /rejectUnauthorized\s*:\s*false/ },
  { id: "minVersion 低于 TLSv1.2", re: /minVersion\s*:\s*["'](?:TLSv1|TLSv1\.0|TLSv1\.1)["']/ },
]);

/** 扫描服务端实现：不得出现"忘记要求客户端证书"的退化配置。 */
export function scanTlsDegradation(files) {
  const findings = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const pattern of TLS_DEGRADATION_PATTERNS) {
      if (pattern.re.test(src)) findings.push({ file, pattern: pattern.id });
    }
  }
  return { ok: findings.length === 0, findings };
}

/**
 * 独立解析一张证书，给出"为什么密码学上不被接受"的客观依据。
 * 与握手观察互补：握手只能告诉我们"被拒了"，这里告诉我们"拒在哪里"。
 */
export function inspectCertificate(certPem, { trustedCaPem = null } = {}) {
  const x = new crypto.X509Certificate(certPem);
  const out = {
    subject: x.subject,
    issuer: x.issuer,
    serialNumber: x.serialNumber,
    validFrom: x.validFrom,
    validTo: x.validTo,
    fingerprint256: normalizeFingerprint(x.fingerprint256),
    subjectAltName: x.subjectAltName || null,
    expired: Date.parse(x.validTo) <= Date.now(),
    trustedByCa: null,
  };
  if (trustedCaPem) {
    try {
      const caPublicKey = new crypto.X509Certificate(trustedCaPem).publicKey;
      out.trustedByCa = x.verify(caPublicKey);
    } catch (err) {
      out.trustedByCa = false;
      out.verifyError = err.message;
    }
  }
  return out;
}

export const __testing = { derSeq, derInt, derOid, issueCertificate, x509Name };
