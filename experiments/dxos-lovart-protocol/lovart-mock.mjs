/**
 * dxos-lovart-protocol · 本地 mock：严格扮演 Lovart OpenAPI（OpenClaw / Agent Skill）。
 *
 * 只替代**最后一跳网络**（lgw.lovart.ai 对本机不可达，见 artifacts 报告）；协议形状与签名
 * 算法逐行对齐官方仓库 lovartai/lovart-skill（MIT）：
 *   · _sign        agent_skill.py:80-93   HMAC_SHA256(secret, METHOD + "\n" + path + "\n" + ts)
 *                       头 X-Access-Key / X-Timestamp / X-Signature / X-Signed-Method / X-Signed-Path
 *   · _request     agent_skill.py:95-148   信封 { code, message, data }；POST 带 Idempotency-Key
 *   · catalog      scripts/sync_models.py:115-129  { data: { tools: [{name,display_name,category,is_premium}] } }
 *   · send         agent_skill.py:285-331   POST {prefix}/chat → data.thread_id
 *   · watch        agent_skill.py:333-337   GET  {prefix}/chat/status?thread_id=
 *   · result       agent_skill.py:333-337   GET  {prefix}/chat/result?thread_id= → items[].artifacts[]
 *   · project      agent_skill.py:152-186   POST {prefix}/project/save → data.project_id
 *
 * **签名是真校验**：缺头 / 访问键不符 / 方法-路径不符 / HMAC 不符 / 时间戳超出窗口 → 401，
 * 且 state.authRejects 记账。mock 本身绝不记录 secret_key（只记录是否通过）。
 */
import http from "node:http";
import crypto from "node:crypto";

const PREFIX = "/v1/openapi";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const DEFAULT_TOOLS = [
  { name: "generate_image_midjourney", display_name: "Midjourney Image", category: "IMAGE", is_premium: true },
  { name: "generate_image_flux", display_name: "Flux Image", category: "IMAGE", is_premium: false },
  { name: "generate_video_kling", display_name: "Kling Video", category: "VIDEO", is_premium: true },
  { name: "generate_3d_mesh", display_name: "3D Mesh", category: "3D", is_premium: false },
];

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function envelopeOk(data) { return { code: 0, message: "ok", data }; }

export async function startLovartMock({ accessKey = "ak_mock_access", secretKey = "sk_mock_secret", tools = null, timestampWindowSeconds = 300 } = {}) {
  const state = {
    mode: "success",
    delayMs: 0,
    timestampWindowSeconds,
    tools: tools || DEFAULT_TOOLS,
    requests: [],
    authRejects: 0,
    rejectReasons: [],
    statusSequence: ["running", "running", "done"],
    statusIndex: 0,
    pollCount: 0,
    // 测试可覆盖：产物 URL 指向非白名单主机时验证拒绝路径
    artifactUrl: null,
    // 观测：本次真实收到的 Host（供报告"观察到的主机清单"）
    observedHosts: new Set(),
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, "http://127.0.0.1");
      state.observedHosts.add(url.hostname);

      // 产物下载不是签名请求（官方 skill 用普通 GET + Referer），不参与签名校验。
      if (url.pathname === "/artifacts/mock-1.png") {
        state.requests.push({ method: req.method, path: url.pathname, query: url.search, artifact: true, signatureValid: null });
        res.writeHead(200, { "content-type": "image/png", "content-length": PNG_1X1.length });
        res.end(PNG_1X1);
        return;
      }

      const record = {
        method: req.method,
        path: url.pathname,
        query: url.search,
        signedMethod: req.headers["x-signed-method"] || null,
        signedPath: req.headers["x-signed-path"] || null,
        timestamp: req.headers["x-timestamp"] || null,
        hasSignature: !!req.headers["x-signature"],
        signatureValid: false,
        accessKeyMatches: false,
        timestampValid: false,
        idempotencyKey: !!req.headers["idempotency-key"],
        contentType: req.headers["content-type"] || null,
        userAgent: req.headers["user-agent"] || null,
        body,
      };
      state.requests.push(record);

      const reject = (reason, status = 401) => {
        state.authRejects += 1;
        state.rejectReasons.push(reason);
        json(res, status, { code: status * 100 + 1, message: reason, data: null });
      };

      const ak = req.headers["x-access-key"];
      const signature = req.headers["x-signature"];
      const signedMethod = req.headers["x-signed-method"];
      const signedPath = req.headers["x-signed-path"];
      const timestamp = req.headers["x-timestamp"];
      if (!ak || !signature || !signedMethod || !signedPath || !timestamp) return reject("signature-headers-missing");
      if (ak !== accessKey) return reject("access-key-mismatch");
      if (signedMethod !== req.method) return reject("signed-method-mismatch");
      if (signedPath !== url.pathname) return reject("signed-path-mismatch");
      const expected = crypto.createHmac("sha256", secretKey).update(signedMethod + "\n" + signedPath + "\n" + timestamp, "utf8").digest("hex");
      const a = Buffer.from(String(signature));
      const b = Buffer.from(expected);
      const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
      record.signatureValid = matches;
      record.accessKeyMatches = true;
      const ts = Number(timestamp);
      record.timestampValid = Number.isFinite(ts) && Math.abs(Math.floor(Date.now() / 1000) - ts) <= timestampWindowSeconds;
      if (!matches) return reject("signature-mismatch");
      if (!record.timestampValid) return reject("timestamp-out-of-window");

      const respond = () => {
        const mode = state.mode;
        if (["401", "403", "429", "500", "502", "503"].includes(mode)) {
          return json(res, Number(mode), { code: Number(mode) * 100, message: "mock-" + mode, data: null });
        }
        if (mode === "business-error") return json(res, 200, { code: 1500, message: "mock business error", data: null });

        if (url.pathname === PREFIX + "/tools/catalog") {
          return json(res, 200, envelopeOk({ tools: state.tools }));
        }
        if (url.pathname === PREFIX + "/project/save") {
          return json(res, 200, envelopeOk({ project_id: "proj_mock_1" }));
        }
        if (url.pathname === PREFIX + "/project/validate") {
          return json(res, 200, envelopeOk({ valid: true, project_name: "Mock Project" }));
        }
        if (url.pathname === PREFIX + "/chat") {
          state.pollCount = 0;
          state.statusIndex = 0;
          return json(res, 200, envelopeOk({ thread_id: "thread_mock_1" }));
        }
        if (url.pathname === PREFIX + "/chat/status") {
          let status = "running";
          if (mode === "never-done") status = "running";
          else if (mode === "abort") status = "abort";
          else if (mode === "pending") status = state.pollCount++ < 1 ? "running" : "done";
          else {
            const seq = state.statusSequence;
            status = seq[Math.min(state.statusIndex, seq.length - 1)];
            state.statusIndex += 1;
            state.pollCount += 1;
          }
          return json(res, 200, envelopeOk({ status, thread_id: url.searchParams.get("thread_id") }));
        }
        if (url.pathname === PREFIX + "/chat/result") {
          if (mode === "pending") {
            return json(res, 200, envelopeOk({ final_status: "pending_confirmation", pending_confirmation: { tool: "generate_video_kling" }, items: [] }));
          }
          if (mode === "no-artifacts") {
            return json(res, 200, envelopeOk({ final_status: "done", items: [{ text: "模型只回复了文本，没有产物。" }], failures: [] }));
          }
          const artifactUrl = state.artifactUrl || ("http://127.0.0.1:" + server.address().port + "/artifacts/mock-1.png");
          return json(res, 200, envelopeOk({
            final_status: "done",
            items: [
              {
                text: "已按你的提示生成图像。",
                artifacts: [{ type: "image", content: artifactUrl, mime: "image/png" }],
              },
            ],
            failures: [],
          }));
        }
        if (url.pathname === "/artifacts/mock-1.png") {
          res.writeHead(200, { "content-type": "image/png", "content-length": PNG_1X1.length });
          return res.end(PNG_1X1);
        }
        return json(res, 404, { code: 40400, message: "not found", data: null });
      };

      if (state.delayMs > 0) {
        const timer = setTimeout(respond, state.delayMs);
        timer.unref?.();
        return;
      }
      respond();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  const close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  return { baseUrl, state, server, close, credentials: { accessKey, secretKey } };
}
