import { reactive } from "vue";

/**
 * 壳层运行日志（10-15，开发者应用用）：从启动起收集渲染进程里**真实发生**的
 * 未捕获错误、未处理的 Promise 拒绝与 console.error / console.warn。只在内存里，最多 300 条。
 */
export type DevLog = { t: number; level: "error" | "warn" | "reject"; msg: string };
export const devlog = reactive<{ items: DevLog[] }>({ items: [] });

function push(level: DevLog["level"], parts: unknown[]) {
  const msg = parts
    .map((p) => (p instanceof Error ? p.stack || p.message : typeof p === "string" ? p : safeJson(p)))
    .join(" ")
    .slice(0, 2000);
  devlog.items.push({ t: Date.now(), level, msg });
  if (devlog.items.length > 300) devlog.items.splice(0, devlog.items.length - 300);
}
function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

let installed = false;
export function installDevLog() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => push("error", [e.error ?? e.message]));
  window.addEventListener("unhandledrejection", (e) => push("reject", [e.reason]));
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args);
      orig(...args);
    };
  }
}
