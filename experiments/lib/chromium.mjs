/**
 * 探针 Chromium 解析（去环境依赖）。
 *
 * 优先级：OA_CHROMIUM → Playwright 官方 chromium（executablePath() 解析出的路径真实存在才用）
 *        → 系统 Google Chrome（macOS 固定安装路径）→ 全部缺失时返回 null，
 *        由调用方打印候选清单并退出 1（绝不返回不存在的路径，也绝不假装建好）。
 *
 * 不硬编码某台机器手建的浏览器缓存路径（如 chromium-1228 软链）：Playwright 升级会改官方目录名，
 * 缓存被清或换机后硬编码会静默失效，探针就变成"因为环境而不是因为代码"变红。
 */
import fs from "node:fs";
import { chromium } from "playwright";

const SYSTEM_GOOGLE_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Playwright 官方 chromium 的可执行文件路径；未安装时 executablePath() 可能抛错，按缺失处理。 */
function playwrightChromiumPath() {
  try { return chromium.executablePath(); } catch { return null; }
}

/**
 * 按优先级返回第一个真实存在的 Chromium：{ path, source, candidates }。
 * path === null 表示一个都没有；candidates 保留完整候选（含不存在的），用于明确报错。
 */
export function resolveChromium() {
  const candidates = [
    ["OA_CHROMIUM", process.env.OA_CHROMIUM],
    ["playwright-chromium", playwrightChromiumPath()],
    ["system-google-chrome", SYSTEM_GOOGLE_CHROME],
  ].filter(([, p]) => typeof p === "string" && p.length > 0);
  for (const [source, p] of candidates) {
    if (fs.existsSync(p)) return { path: p, source, candidates };
  }
  return { path: null, source: null, candidates };
}

/** 把候选渲染成一行，供失败时明确报出"试过哪些路径"。 */
export function describeChromiumCandidates(candidates) {
  return candidates.map(([source, p]) => source + "=" + p).join(" / ");
}
