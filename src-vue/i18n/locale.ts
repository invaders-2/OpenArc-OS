/**
 * 最小 i18n 基础设施（0.6.1 · 英文界面第一层）。
 *
 * 设计取舍：
 *   · 词典以**中文原文为键**（en-US.ts 只维护英文），于是 zh-CN 是源语言、零漏译成本；
 *     英文缺项时回退中文，界面不会出现空白或键名。
 *   · t() 读 locale ref，模板/计算属性里直接调用即可随设置·语言切换即时更新。
 *   · 持久化键 oa-locale（与其它 oa-* 同域），只保存语言代码，不保存任何内容数据。
 *   · 不翻译用户内容（文件名、项目名、消息正文等）—— 它们不经过 t()。
 */
import { ref } from "vue";
import { EN_US } from "./en-US";

export type Locale = "zh-CN" | "en-US";
export const SUPPORTED_LOCALES: Locale[] = ["zh-CN", "en-US"];
const STORAGE_KEY = "oa-locale";

function readStoredLocale(): Locale {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "en-US" ? "en-US" : "zh-CN";
  } catch {
    return "zh-CN";
  }
}

export const locale = ref<Locale>(readStoredLocale());

export function setLocale(next: Locale): void {
  locale.value = next === "en-US" ? "en-US" : "zh-CN";
  try {
    localStorage.setItem(STORAGE_KEY, locale.value);
  } catch {
    /* 存储不可用：本次会话内仍然生效 */
  }
  applyDocumentLang();
}

export function applyDocumentLang(): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale.value;
}

export function initI18n(): void {
  applyDocumentLang();
}

/**
 * 翻译一条界面文案。
 * @param zh     中文原文（同时是词典键；缺失英文时回退它）
 * @param params 可选的 {name} / {n} 插值；中英文共用同一组占位符
 */
export function t(zh: string, params?: Record<string, string | number>): string {
  const source = locale.value === "en-US" ? EN_US[zh] ?? zh : zh;
  if (!params) return source;
  let out = source;
  for (const [key, value] of Object.entries(params)) out = out.split("{" + key + "}").join(String(value));
  return out;
}

export const localeLabel = (value: Locale): string => (value === "en-US" ? "English" : "简体中文");
