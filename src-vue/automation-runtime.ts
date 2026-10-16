import { reactive } from "vue";

/**
 * 自动化运行时（10-15）：按时间触发一次「全局 AI 任务」（task/run）。
 *
 * 口径：
 *   · 只在 OpenArc 运行期间触发；应用关着时错过的时间点**不补跑**（下次照常）；
 *   · 触发 = 以自动化里写好的目标发起一个普通任务：模型 / 身份 / 预算 / 写操作确认
 *     全部仍由主进程任务运行时决定，这里不绕过任何闸门；
 *   · 记录存本机 localStorage「oa-automations」。
 */
export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekday: number } // 0=周日
  | { kind: "interval"; minutes: number }
  | { kind: "manual" };
export type RunRecord = { at: number; ok: boolean; taskId?: string; error?: string };
export type Automation = {
  id: string;
  name: string;
  goal: string;
  schedule: Schedule;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  runs: RunRecord[];
};

const KEY = "oa-automations";
function read(): Automation[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((a) => a && typeof a.id === "string" && typeof a.goal === "string") : [];
  } catch {
    return [];
  }
}
export const automation = reactive<{ items: Automation[]; running: Set<string> }>({ items: read(), running: new Set() });
export function persistAutomations() {
  try {
    localStorage.setItem(KEY, JSON.stringify(automation.items));
  } catch {
    /* 存储不可用 */
  }
}

const hm = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return [Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0];
};
/** 下一次触发时间（毫秒）；手动 / 停用返回 null。from 之后（不含）的第一个时间点。 */
export function nextRunAt(a: Automation, from = Date.now()): number | null {
  if (!a.enabled) return null;
  const s = a.schedule;
  if (s.kind === "manual") return null;
  if (s.kind === "interval") {
    const step = Math.max(5, s.minutes) * 60000;
    const base = a.lastRunAt ?? a.createdAt;
    let t = base + step;
    if (t <= from) t = from + step - ((from - base) % step);
    return t;
  }
  const [h, m] = hm(s.time);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(h, m);
  for (let i = 0; i < 8; i += 1) {
    const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m).getTime();
    if (cand <= from) continue;
    if (s.kind === "weekly" && new Date(cand).getDay() !== s.weekday) continue;
    return cand;
  }
  return null;
}

type Notify = (n: { appId: string; title: string; body?: string }) => void;
let notifyFn: Notify | null = null;

export async function runAutomation(a: Automation) {
  const bridge = window.openarc?.task;
  if (automation.running.has(a.id)) return;
  automation.running.add(a.id);
  const at = Date.now();
  a.lastRunAt = at;
  let rec: RunRecord;
  if (!bridge) rec = { at, ok: false, error: "NO_RUNTIME" };
  else {
    const r = await bridge.command({ command: "task/run", payload: { goal: a.goal } }).catch(() => null);
    rec = r?.ok ? { at, ok: true, taskId: r.taskId } : { at, ok: false, error: r?.error ?? "INTERNAL_ERROR" };
  }
  a.runs = [rec, ...(a.runs ?? [])].slice(0, 20);
  automation.running.delete(a.id);
  persistAutomations();
  notifyFn?.({
    appId: "automation",
    title: rec.ok ? `自动化已触发：${a.name}` : `自动化未能运行：${a.name}`,
    body: rec.ok ? "已作为任务交给助理，结果可在「对话」里查看。" : `原因：${rec.error}`,
  });
}

/** 应用启动时装一次；每 30 秒检查到点的自动化。 */
export function installAutomationRuntime(notify: Notify) {
  notifyFn = notify;
  // 记下装载时刻：只触发「装载之后」到点的，关机期间错过的不补跑
  let lastTick = Date.now();
  const tick = () => {
    const now = Date.now();
    for (const a of automation.items) {
      const due = nextRunAt(a, lastTick - 1);
      if (due !== null && due > lastTick - 1 && due <= now) void runAutomation(a);
    }
    lastTick = now;
  };
  const timer = window.setInterval(tick, 30000);
  return () => window.clearInterval(timer);
}
