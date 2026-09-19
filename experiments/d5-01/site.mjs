/**
 * D5-01 · 本地受控站点（**只用本地内容**，不使用真实账号或真实网站）。
 *
 * 它存在的理由：真实网站不可控（网络、证书、内容随时变），而 D5-01 要验收的是
 * "浏览器容器自己"的行为 —— 导航 / 标签 / 下载落盘 / 弹窗 / 权限 / 外部协议 /
 * 证书错误 / 文件上传 / 桥隔离。这些必须由确定性页面来触发。
 *
 * 三个服务：
 *   · HTTP 站点（默认 127.0.0.1:5391）—— 主页与各类触发页、下载端点
 *   · flaky 服务（默认 5392）—— **默认不启动**，用于"连接失败 → 重试成功"
 *   · 自签名 HTTPS（默认 5393）—— 证书错误路径（openssl 现生成，测试专用）
 *
 * 站点内容不代表产品能力，只提供确定性的触发条件。
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const PAYLOAD = "OPENARC-D501-DOWNLOAD-PAYLOAD-0123456789";

const html = (title, body, script = "") => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1 id="title">${title}</h1>${body}<script>${script}</script></body></html>`;

function routes() {
  return {
    "/": () =>
      html(
        "OpenArc D5-01 Site",
        `<nav>
          <a id="to-page2" href="/page2">page2</a>
          <a id="to-download" href="/dl/hello.txt">download</a>
          <a id="to-broken" href="/dl/broken">broken download</a>
          <a id="to-popup" href="/popup">popup</a>
          <a id="to-permission" href="/permission">permission</a>
          <a id="to-external" href="/external">external</a>
          <a id="to-bridge" href="/bridge">bridge</a>
          <a id="to-upload" href="/fileupload">upload</a>
          <a id="to-cookie" href="/cookie">cookie</a>
        </nav>`,
      ),
    "/page2": () => html("PAGE2", `<h2 id="page2-marker">PAGE2-MARKER-9f3a</h2>`),
    "/dl/hello.txt": null, // 由 server 单独处理（附件下载）
    "/dl/broken": null,
    "/popup": () =>
      html("POPUP", `<button id="popup-btn">open popup</button>`, `document.getElementById('popup-btn').onclick = () => { window.open('/page2', '_blank'); };`),
    "/permission": () =>
      html(
        "PERMISSION",
        `<div id="perm-result">pending</div>`,
        `window.__perm = { geo: 'pending', notify: 'pending' };
         navigator.geolocation.getCurrentPosition(
           () => { window.__perm.geo = 'granted'; document.getElementById('perm-result').textContent = 'geo granted'; },
           (e) => { window.__perm.geo = 'denied:' + (e && e.code); document.getElementById('perm-result').textContent = 'geo denied'; }
         );
         if (window.Notification && Notification.requestPermission) Notification.requestPermission().then((v) => { window.__perm.notify = v; });`,
      ),
    "/external": () => html("EXTERNAL", `<a id="mail-link" href="mailto:d501@example.com">mail us</a>`),
    "/bridge": () =>
      html(
        "BRIDGE",
        `<div id="bridge-result">pending</div>`,
        `window.__d501Bridge = {
           openarc: typeof window.openarc,
           require: typeof window.require,
           process: typeof window.process,
           module: typeof window.module,
           electron: typeof window.electron,
           ipcRenderer: typeof window.ipcRenderer,
           shell: typeof window.shell,
           fs: typeof window.fs,
         };
         (async () => {
           try {
             if (window.openarc) { await window.openarc.identity.command({ type: 'identity/snapshot' }); window.__d501Bridge.callResult = 'CALLED'; }
             else window.__d501Bridge.callResult = 'NO_BRIDGE';
           } catch (e) { window.__d501Bridge.callResult = 'THREW:' + String((e && e.message) || e).slice(0, 60); }
           document.getElementById('bridge-result').textContent = JSON.stringify(window.__d501Bridge);
         })();`,
      ),
    "/fileupload": () =>
      html(
        "UPLOAD",
        `<input type="file" id="file-input"><div id="file-info">none</div>`,
        `window.__fileInfo = null;
         document.getElementById('file-input').addEventListener('change', (e) => {
           const f = e.target.files && e.target.files[0];
           window.__fileInfo = f ? { name: f.name, size: f.size, path: (f.path || null) } : null;
           document.getElementById('file-info').textContent = f ? (f.name + ':' + f.size) : 'none';
         });`,
      ),
    "/cookie": () =>
      html(
        "COOKIE",
        `<div id="whoami">-</div>`,
        `(function () {
           const params = new URLSearchParams(location.search);
           if (params.get('set') === '1') {
             document.cookie = 'd501=USERA; path=/';
             try { localStorage.setItem('d501', 'USERA'); } catch {}
           }
           window.__whoami = { cookie: document.cookie, storage: (() => { try { return localStorage.getItem('d501'); } catch { return null; } })() };
           document.getElementById('whoami').textContent = JSON.stringify(window.__whoami);
         })();`,
      ),
    "/slow": () => html("SLOW", `<p id="slow-marker">SLOW-DONE</p>`),
    // A12 输入路由：页面自己数事件。只有真正到达网页的输入才会让它变化。
    "/input": () =>
      html(
        "INPUT",
        `<div id="input-count">0</div>`,
        `window.__counts = { pointerdown: 0, click: 0, keydown: 0 };
         for (const name of Object.keys(window.__counts)) {
           window.addEventListener(name, () => {
             window.__counts[name] += 1;
             document.getElementById('input-count').textContent = JSON.stringify(window.__counts);
           }, true);
         }`,
      ),
    "/red": () => `<!doctype html><html><head><meta charset="utf-8"><title>RED</title></head><body style="margin:0;background:#ff0000"><div id="red-marker" style="width:100%;height:100vh"></div></body></html>`,
    "/marker": () => "MARKER-OK",
  };
}

/** 启动 HTTP 站点。返回 { port, base, close }。 */
export async function startSite({ port = Number(process.env.OA_D501_PORT || 5391) } = {}) {
  const table = routes();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname === "/dl/hello.txt") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="hello.txt"',
        "Content-Length": Buffer.byteLength(PAYLOAD),
      });
      res.end(PAYLOAD);
      return;
    }
    if (pathname === "/dl/broken") {
      // 声明大长度、只写一小段就断开 —— 确定性地制造 interrupted（失败）下载。
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "1048576" });
      res.write(Buffer.alloc(128, 7));
      setTimeout(() => { try { res.socket.destroy(); } catch { /* ignore */ } }, 30);
      return;
    }
    if (pathname === "/slow") {
      // 真的慢：用于观察加载状态（1500ms 足够让 UI 渲染出停止按钮/标签 spinner）。
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html("SLOW", `<p id="slow-marker">SLOW-DONE</p>`));
      }, 1500);
      return;
    }
    const handler = table[pathname];
    if (!handler) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const body = handler();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** flaky 服务：默认不启动，用于"先失败、后重试成功"。 */
export async function startFlaky({ port = Number(process.env.OA_D501_FLAKY_PORT || 5392) } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html("FLAKY-OK", `<p id="flaky-marker">FLAKY-RECOVERED</p>`));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** 自签名 HTTPS：证书错误路径。openssl 不可用时返回 null（该项记 NOT VERIFIED）。 */
export async function startTls({ port = Number(process.env.OA_D501_TLS_PORT || 5393) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html("TLS-SITE", `<p id="tls-marker">SHOULD-NOT-LOAD</p>`));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    base: `https://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.close(resolve); fs.rmSync(dir, { recursive: true, force: true }); }),
  };
}
