/**
 * 模型出网代理单测夹具：本机假代理 + 本机 TLS 目标。
 *
 * 全部本机回环、无真实联网：
 *   · startTlsTarget   真实 https 服务器（优先复用 artifacts/d1-05/tls；缺失时用 openssl 现生成自签证书）
 *   · startFakeProxy   HTTP 代理：普通请求回显（absolute-form）、CONNECT 隧道（转发到 TLS 目标），
 *                      另可切 auth(407) / fail(502) / hang(不响应)
 */
import net from "node:net";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TLS_DIR = path.join(ROOT, "artifacts", "d1-05", "tls");
let cachedTls = null;
let cachedTlsHostname = null;

/** openssl 现生成一张自签 localhost 证书（不依赖仓库里未跟踪的 artifacts）。 */
function generateSelfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-egress-tls-"));
  const config = path.join(dir, "openssl.cnf");
  const hostname = process.env.OA_EGRESS_TEST_HOSTNAME || "localhost";
  fs.writeFileSync(config, [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = v3_req",
    "prompt = no",
    "[dn]",
    "CN = " + hostname,
    "[v3_req]",
    "subjectAltName = DNS:" + hostname + ",IP:127.0.0.1",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "server.ext"), "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:" + hostname + ",IP:127.0.0.1\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "ca.key"), "-out", path.join(dir, "ca.crt"), "-days", "2", "-subj", "/CN=OpenArc Test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "server.key"), "-out", path.join(dir, "server.csr"), "-config", config], { stdio: "ignore" });
  execFileSync("openssl", ["x509", "-req", "-in", path.join(dir, "server.csr"), "-CA", path.join(dir, "ca.crt"), "-CAkey", path.join(dir, "ca.key"), "-set_serial", "1000", "-out", path.join(dir, "server.crt"), "-days", "2", "-extfile", path.join(dir, "server.ext")], { stdio: "ignore" });
  return {
    ca: fs.readFileSync(path.join(dir, "ca.crt")),
    key: fs.readFileSync(path.join(dir, "server.key")),
    cert: fs.readFileSync(path.join(dir, "server.crt")),
    dir,
  };
}

export function tlsFixtures() {
  const hostname = process.env.OA_EGRESS_TEST_HOSTNAME || null;
  if (hostname && cachedTls && cachedTlsHostname === hostname) return cachedTls;
  if (hostname) {
    cachedTls = generateSelfSigned();
    cachedTlsHostname = hostname;
    return cachedTls;
  }
  if (cachedTls) return cachedTls;
  const caFile = path.join(TLS_DIR, "ca.crt");
  const keyFile = path.join(TLS_DIR, "server.key");
  const certFile = path.join(TLS_DIR, "server.crt");
  cachedTls = fs.existsSync(caFile) && fs.existsSync(keyFile) && fs.existsSync(certFile)
    ? { ca: fs.readFileSync(caFile), key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
    : generateSelfSigned();
  return cachedTls;
}

/** 真实 TLS 目标：把方法 / 原始 URL / 头 / 体回显成 JSON，便于断言"隧道内请求正确"。 */
export async function startTlsTarget({ delayMs = 0 } = {}) {
  const { key, cert } = tlsFixtures();
  const server = https.createServer({ key, cert }, (req, res) => {
    if (req.url === "/media.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from("proxied-png")); return; }
    if (req.url === "/redirect-private") { res.writeHead(302, { location: "http://127.0.0.1/media.png" }); res.end(); return; }
    if (req.url === "/redirect-media") { res.writeHead(302, { location: "/media.png" }); res.end(); return; }
    if (req.url === "/large.png") { res.writeHead(200, { "content-type": "image/png" }); for (let i = 0; i < 16; i += 1) res.write(Buffer.alloc(1024, i)); res.end(); return; }
    let body = Buffer.alloc(0);
    req.on("data", (chunk) => { body = Buffer.concat([body, chunk]); });
    req.on("end", () => {
      const payload = JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8") });
      const send = () => {
        res.writeHead(201, { "content-type": "application/json", "x-echo": "yes", "content-length": String(Buffer.byteLength(payload)) });
        res.end(payload);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      for (const socket of sockets) { try { socket.destroy(); } catch { /* ignore */ } }
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      server.close(finish);
      setTimeout(finish, 1000).unref?.();
    }),
  };
}

/**
 * 本机假代理。
 * mode: "tunnel"（转发到 upstreamPort，默认）| "auth"(407) | "fail"(502) | "hang"(不响应)
 */
export async function startFakeProxy({ upstreamPort = 0, mode = "tunnel" } = {}) {
  const state = { connects: [], requests: [], connectHeaders: [], authRejects: 0, clientClosed: 0, sockets: new Set() };
  const server = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on("data", (chunk) => { body = Buffer.concat([body, chunk]); });
    req.on("end", () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8") });
      const payload = JSON.stringify({ via: "proxy-absolute-form", method: req.method, url: req.url, body: body.toString("utf8") });
      res.writeHead(200, { "content-type": "application/json", "x-proxy": "fake", "content-length": String(Buffer.byteLength(payload)) });
      res.end(payload);
    });
  });
  server.on("connect", (req, clientSocket, head) => {
    state.connects.push(req.url);
    state.connectHeaders.push(req.headers);
    state.sockets.add(clientSocket);
    clientSocket.on("close", () => state.sockets.delete(clientSocket));
    if (mode === "auth") {
      state.authRejects += 1;
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"fake-proxy\"\r\nContent-Length: 0\r\n\r\n");
      clientSocket.end();
      return;
    }
    if (mode === "fail") {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      clientSocket.end();
      return;
    }
    if (mode === "hang") { clientSocket.on("close", () => { state.clientClosed += 1; }); return; }
    const upstream = net.connect({ host: "127.0.0.1", port: upstreamPort });
    upstream.on("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => { try { clientSocket.destroy(); } catch { /* ignore */ } });
    clientSocket.on("error", () => { try { upstream.destroy(); } catch { /* ignore */ } });
    clientSocket.on("close", () => { state.clientClosed += 1; try { upstream.destroy(); } catch { /* ignore */ } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    url: "http://127.0.0.1:" + port,
    state,
    close: () => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      for (const socket of state.sockets) { try { socket.destroy(); } catch { /* ignore */ } }
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      server.close(finish);
      setTimeout(finish, 1000).unref?.();
    }),
  };
}

/** 取一个当前没人监听的回环端口（用于"代理不可达"）。 */
export async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** 简易 AbortController 延时（不引测试框架依赖）。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
