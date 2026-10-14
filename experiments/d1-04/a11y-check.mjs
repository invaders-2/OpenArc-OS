import { chromium } from "playwright";
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";
// Chromium 解析优先级：OA_CHROMIUM → Playwright 官方 chromium → 系统 Google Chrome（见 experiments/lib/chromium.mjs）。
const CHROMIUM_INFO = resolveChromium();
const EXEC = CHROMIUM_INFO.path;
if (!EXEC) {
  console.error("找不到可用 Chromium，已按优先级尝试：" + describeChromiumCandidates(CHROMIUM_INFO.candidates) + "（设置 OA_CHROMIUM 指向可用二进制）");
  process.exit(1);
}
const b=await chromium.launch({executablePath:EXEC});
const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto("http://127.0.0.1:5210/");
await p.evaluate(()=>localStorage.setItem("oa-dark","true"));
await p.reload(); await p.waitForSelector(".dock-item");

// 打开右键菜单
await p.mouse.click(700,500,{button:"right"});
await p.waitForTimeout(300);
console.log("打开后 context-menu:", await p.locator(".context-menu").count(), " menu-shade:", await p.locator(".menu-shade").count());

// 按 Esc
await p.keyboard.press("Escape");
await p.waitForTimeout(400);
const afterMenu = await p.locator(".context-menu").count();
const afterShade = await p.locator(".menu-shade").count();
console.log("按 Esc 后 context-menu:", afterMenu, " menu-shade:", afterShade);

// 尝试用键盘打开菜单（Tab 到桌面文件夹后按菜单键/Shift+F10）
const tabbed = await p.evaluate(()=>{
  const els=[...document.querySelectorAll('.desktop-folder,[tabindex="0"]')];
  return els.length;
});
console.log("桌面可 Tab 元素数:", tabbed);

// 搜索面板 Esc
await p.keyboard.press("Escape");
await p.mouse.click(700,500);
await p.waitForTimeout(200);
await p.keyboard.press("Meta+k");
await p.waitForTimeout(300);
console.log("Cmd+K 后 search-panel:", await p.locator(".search-panel").count());
await p.keyboard.press("Escape");
await p.waitForTimeout(300);
console.log("Esc 后 search-panel:", await p.locator(".search-panel").count());
await b.close();
