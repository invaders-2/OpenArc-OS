// D2-01 共用探针基础设施。
//
// 与 D1-05 的 lib/probe.mjs 同源，但产物目录是本轮的 artifacts/d2-01，
// 且额外提供"起静态服务 + 起 Chromium + 按 (theme, glass, motion, view) 打开"，
// 因为设计系统的判据是**渲染后的计算值与像素**，不是源码文本。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { chromium } from "playwright";

export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const ART = path.join(ROOT, "artifacts", "d2-01");
export const DIST = path.join(ROOT, "dist");
export const PORT = Number(process.env.OA_PORT || 5231);

export const CHROMIUM =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

export const VERDICT = {
  PASS: "PASS",
  FAIL: "FAIL",
  PARTIAL: "PARTIAL",
  NOT_VERIFIED: "NOT VERIFIED",
  BLOCKED: "BLOCKED",
};

export function ensureDirs() {
  fs.mkdirSync(ART, { recursive: true });
}

export function environment() {
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    chromium: CHROMIUM,
    renderEngine: "Chromium（Playwright）—— 不是 Electron",
  };
}

/* ── 探针框架（与 D1-05 同口径：一个探针产出多条用例，不是一个布尔值） ── */
export class Probe {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.cases = [];
    this.notes = [];
    this.startedAt = new Date().toISOString();
  }

  case(name, status, detail) {
    this.cases.push({ name, status, detail: detail ?? "" });
    const tag = status === VERDICT.PASS ? "  " : "! ";
    console.log(`${tag}[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
    return status;
  }

  note(text) {
    this.notes.push(text);
    console.log(`   · ${text}`);
  }

  assertAll(list) {
    const pass = list.filter((c) => c.status === VERDICT.PASS).length;
    const fail = list.filter((c) => c.status === VERDICT.FAIL).length;
    this.case(
      `断言 ${list.length} 条：${pass} 通过 / ${fail} 失败`,
      fail === 0 ? VERDICT.PASS : VERDICT.FAIL,
      fail === 0 ? "" : list.filter((c) => c.status === VERDICT.FAIL).map((c) => c.name).join("; "),
    );
    return fail === 0;
  }

  summary() {
    const t = {};
    for (const c of this.cases) t[c.status] = (t[c.status] || 0) + 1;
    return t;
  }

  verdict() {
    const t = this.summary();
    if (t[VERDICT.FAIL]) return VERDICT.FAIL;
    if (t[VERDICT.BLOCKED]) return VERDICT.PARTIAL;
    if (t[VERDICT.PARTIAL] || t[VERDICT.NOT_VERIFIED]) return VERDICT.PARTIAL;
    return VERDICT.PASS;
  }

  write() {
    ensureDirs();
    const out = {
      id: this.id,
      title: this.title,
      verdict: this.verdict(),
      counts: this.summary(),
      environment: environment(),
      notes: this.notes,
      cases: this.cases,
      // 探针可挂结构化原始数据（实测值表），便于人工复核与事后对比
      ...(this.data ? { data: this.data } : {}),
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
    };
    const file = path.join(ART, `${this.id}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    return { file, verdict: out.verdict, counts: out.counts };
  }
}

/* ── 静态服务（只服务 dist，不对外） ── */
export function serveDist() {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || "/").split("?")[0];
    let p = path.join(DIST, urlPath);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      p = path.join(DIST, urlPath.endsWith(".html") ? urlPath : "index.html");
    }
    const ext = path.extname(p);
    const type =
      ext === ".js"
        ? "text/javascript"
        : ext === ".css"
          ? "text/css"
          : ext === ".html"
            ? "text/html"
            : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

export async function launch() {
  if (!fs.existsSync(CHROMIUM)) {
    throw new Error(`Chromium 不存在：${CHROMIUM}\n设置 OA_CHROMIUM 环境变量指向可用二进制。`);
  }
  return chromium.launch({ executablePath: CHROMIUM });
}

export function dsUrl({ theme = "light", glass = "full", motion = "normal", view = "primitives" } = {}) {
  const p = new URLSearchParams({ theme, glass, motion, view });
  return `http://127.0.0.1:${PORT}/design-system.html?${p}`;
}

export const THEMES = ["light", "dark"];
export const GLASSES = ["full", "reduced", "solid"];
export const MOTIONS = ["normal", "reduced"];

export function cells({ motions = ["normal"] } = {}) {
  const out = [];
  for (const theme of THEMES) for (const glass of GLASSES) for (const motion of motions) out.push({ theme, glass, motion });
  return out;
}

/* ── WCAG 对比度（在 Node 侧算，避免依赖页面里的实现） ── */
export function parseColor(s) {
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

export function relativeLuminance({ r, g, b }) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(fg, bg) {
  const a = parseColor(fg);
  const b = parseColor(bg);
  if (!a || !b) return null;
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
