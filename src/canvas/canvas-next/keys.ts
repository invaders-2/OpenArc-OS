/**
 * 快捷键文案按平台显示：源码统一用 Mac 符号（⌘ ⇧ ⌥ ⌫ ↵）书写，
 * Windows / Linux 上换成 Ctrl / Shift / Alt / Backspace / Enter。
 */
const nav = typeof navigator !== "undefined" ? navigator as Navigator & { userAgentData?: { platform?: string } } : undefined;
export const IS_MAC = !!nav && /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || "");

const NAMES: Record<string, string> = { "⌘": "Ctrl", "⇧": "Shift", "⌥": "Alt", "⌫": "Backspace", "↵": "Enter" };
const MODS = new Set(["⌘", "⇧", "⌥"]);

/** 把一段含快捷键符号的文字转成当前平台的写法；Mac 上原样返回 */
export function kbd(text: string, mac = IS_MAC): string {
  if (mac) return text;
  // 「⌘/Ctrl+滚轮」这类两种写法并列的旧文案先归一
  const src = text.replace(/⌘\/Ctrl\+?/g, "⌘").replace(/⇧⌘/g, "⌘⇧"); // Windows 习惯 Ctrl 在前：Ctrl+Shift+Z
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const name = NAMES[c];
    if (!name) { out += c; continue; }
    out += name;
    // 修饰键后面紧跟按键时补「+」；后面是空格、标点或结尾时不补（如「⇧ 10px」「方向键（⇧）」）
    const next = src[i + 1];
    if (MODS.has(c) && next !== undefined && !/[\s)）/／,，、·]/.test(next)) {
      // 「⌘+滚轮」：已有加号不重复；「⌘+ / ⌘−」：按键本身就是加号，写成 Ctrl++
      const plusIsKey = next === "+" && (src[i + 2] === undefined || /\s/.test(src[i + 2]));
      out += next === "+" && !plusIsKey ? "" : "+";
    }
  }
  return out;
}
