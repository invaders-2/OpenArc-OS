/**
 * 应用图标唯一性与来源一致性（task-2）。
 *
 * 为什么需要这组断言：
 *   · APPS 注册表是应用身份图标的唯一真值；一旦两个应用共用一个图标名，
 *     访达/资源库、系统设置/组织、MCP/第三方集成就会在程序坞与市场里撞脸；
 *   · 图标名与 public/icons 的真实文件必须对得上，缺文件是静默 404（界面上只剩空白）；
 *   · 壳层（程序坞 / 应用中心 / 启动台-聚焦搜索 / 应用市场）必须从注册表取图标，
 *     不能再写 icon: "finder" 这类旁路；
 *   · 旧 React 入口（src/main.tsx）有自己的同形清单，共享 appId 的图标名必须与注册表一致，
 *     否则 OA_UI=react 一启动就露馅。
 *
 * 本测试只读源码与 PNG 头，不启动 Electron、不需要构建。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const iconPath = (name) => path.join(ROOT, "public/icons", name + ".png");

const APPS_SOURCE = read("src-vue/apps.ts");
const LEGACY_SOURCE = read("src/main.tsx");
const SOURCE_DOC = read("public/icons/ICONS-SOURCE.md");

/** 非应用身份资产：AI 圆球静态帧、聚焦搜索、回收站满桶（不是 APPS 的 appId 图标）。 */
const NON_APP_ASSETS = Object.freeze(["siri", "spotlight", "trash-full"]);

function parseRegistry(source, pattern) {
  const entries = [];
  let match;
  while ((match = pattern.exec(source))) entries.push({ id: match[1], name: match[2], icon: match[3] });
  return entries;
}
const REGISTRY = parseRegistry(APPS_SOURCE, /\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*icon:\s*"([^"]+)",\s*version:\s*"[^"]+"\s*\}/g);
const LEGACY = parseRegistry(LEGACY_SOURCE, /\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*icon:\s*"([^"]+)"\s*\}/g);
const ICONS = new Set(REGISTRY.map((entry) => entry.icon));
const byId = new Map(REGISTRY.map((entry) => [entry.id, entry]));
const byName = new Map(REGISTRY.map((entry) => [entry.name, entry]));

function pngHeader(file) {
  const buffer = fs.readFileSync(file);
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], path.basename(file) + " 不是 PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    md5: crypto.createHash("md5").update(buffer).digest("hex"),
  };
}
function sourceRows() {
  const rows = new Map();
  const pattern = /^\| \x60([^\x60]+)\x60 \| \x60([^\x60]+)\x60 \| ([^|]+) \|$/gm;
  let match;
  while ((match = pattern.exec(SOURCE_DOC))) rows.set(match[1], { source: match[2].trim(), usage: match[3].trim() });
  return rows;
}

test("① 注册表每个应用一个图标：id 唯一、图标名唯一", () => {
  assert.ok(REGISTRY.length >= 25, "APPS 解析数量异常：" + REGISTRY.length);
  const ids = REGISTRY.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "APPS 有重复 appId");
  const iconList = REGISTRY.map((entry) => entry.icon);
  assert.equal(new Set(iconList).size, iconList.length, "APPS 有共用图标：" + iconList.filter((x, i) => iconList.indexOf(x) !== i).join(", "));
});

test("② 三组历史重复 + 新增协议/MCP 一组，四组都已分开", () => {
  const distinct = (a, b) => assert.notEqual(byId.get(a).icon, byId.get(b).icon, a + " 与 " + b + " 仍在共用图标");
  distinct("files", "resource-library");
  distinct("settings", "organization");
  distinct("mcp-center", "integrations");
  distinct("protocols", "mcp-center");
  distinct("protocols", "integrations");
  assert.equal(byId.get("resource-library").icon, "library");
  assert.equal(byId.get("organization").icon, "contacts");
  assert.equal(byId.get("mcp-center").icon, "mcp");
  assert.equal(byId.get("integrations").icon, "sharing", "第三方集成保留 sharing");
  assert.equal(byId.get("files").icon, "finder", "访达保留 finder");
  assert.equal(byId.get("settings").icon, "settings", "系统设置保留 settings");
});

test("③ 引用到的 PNG 都存在，且与现有资产同规格（256×256、8-bit RGBA）", () => {
  const seen = new Map();
  for (const entry of REGISTRY) {
    const file = iconPath(entry.icon);
    assert.ok(fs.existsSync(file), entry.id + " 的图标文件缺失：public/icons/" + entry.icon + ".png");
    const header = pngHeader(file);
    assert.equal(header.width, 256, entry.icon + " 宽度不是 256");
    assert.equal(header.height, 256, entry.icon + " 高度不是 256");
    assert.equal(header.bitDepth, 8, entry.icon + " 不是 8-bit");
    assert.equal(header.colorType, 6, entry.icon + " 不是 RGBA");
    assert.ok(!seen.has(header.md5), entry.icon + " 与 " + seen.get(header.md5) + " 是同一张图（像素内容完全相同）");
    seen.set(header.md5, entry.icon);
  }
  // task-2 的直接证据：新 mcp.png 与换源后的 protocols.png 不是同一张图。
  assert.notEqual(pngHeader(iconPath("mcp")).md5, pngHeader(iconPath("protocols")).md5);
});

test("④ ICONS-SOURCE.md 与注册表同步：每个应用图标都有来源行，且 task-2 换源写对", () => {
  const rows = sourceRows();
  for (const entry of REGISTRY) {
    assert.ok(rows.has(entry.icon + ".png"), "ICONS-SOURCE.md 缺少 " + entry.icon + ".png 的来源行");
  }
  assert.equal(rows.get("library.png").source, "src/apps/scalable/gnome-books.svg");
  assert.equal(rows.get("mcp.png").source, "src/apps/scalable/gnome-connections.svg");
  assert.equal(rows.get("contacts.png").source, "src/apps/scalable/addressbook.svg");
  assert.equal(rows.get("protocols.png").source, "src/apps/scalable/preferences-system-network-remote.svg", "协议中心必须换源，不能再写 gnome-connections");
  assert.ok(rows.get("library.png").usage.includes("资源库"));
  assert.ok(rows.get("mcp.png").usage.includes("MCP"));
  assert.ok(rows.get("protocols.png").usage.includes("协议"));
  assert.ok(!rows.get("protocols.png").source.includes("gnome-connections"), "旧记录必须删掉");
});

test("⑤ 程序坞 / 应用中心 / 启动台(聚焦搜索) / 应用市场都从注册表取图标", () => {
  const consumers = [
    { file: "src-vue/shell/Dock.vue", use: /iconUrl\(app\.icon\)/ },
    { file: "src-vue/shell/AppsPopover.vue", use: /iconUrl\(a\.id[^)]*\)|iconUrl\(a\.icon\)/ },
    { file: "src-vue/shell/Launchpad.vue", use: /iconUrl\(a\.icon\)/ },
    { file: "src-vue/apps/HomeApp.vue", use: /iconUrl\(id === "trash"[\s\S]*?icon\)|iconUrl\(appById/ },
    { file: "src-vue/apps/MarketApp.vue", use: /iconUrl\(a\.icon\)|iconUrl\(appById/ },
  ];
  for (const consumer of consumers) {
    const source = read(consumer.file);
    assert.match(source, /from "\.\.\/apps"|from "\.\.\/\.\.\/apps"/, consumer.file + " 没有从注册表导入");
    assert.match(source, consumer.use, consumer.file + " 没有把注册表图标交给 iconUrl");
    assert.ok(source.indexOf('"./icons/"') < 0 && source.indexOf("'/icons/'") < 0, consumer.file + " 仍在手拼 icons 路径");
  }
  assert.match(APPS_SOURCE, /export const iconUrl = \(name: string\): string => "\.\/icons\/" \+ name \+ "\.png"/, "iconUrl 唯一实现被改动");
});

test("⑥ 壳层不再有 icon: \"…\" 旁路；应用内硬编码只剩“自己的身份图标”且在注册表内", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + "/" + entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(vue|ts)$/.test(entry.name) && rel !== "src-vue/apps.ts") files.push(rel);
    }
  };
  walk("src-vue");
  const propLiterals = [];
  const callLiterals = [];
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/icon:\s*"([a-z0-9-]+)"/g)) propLiterals.push({ file, icon: match[1] });
    for (const match of source.matchAll(/iconUrl\(\s*['"]([a-z0-9-]+)['"]\s*\)/g)) callLiterals.push({ file, icon: match[1] });
  }
  // 窗口 meta 的 icon 必须来自注册表（TopBar 的 new-finder 已收敛）；这里有旁路就报出来。
  assert.deepEqual(propLiterals, [], "还有 icon: \"…\" 旁路：" + JSON.stringify(propLiterals));
  assert.ok(callLiterals.length > 0, "扫描没读到 iconUrl 字面量，规则可能失效");
  for (const item of callLiterals) {
    assert.ok(ICONS.has(item.icon) || NON_APP_ASSETS.includes(item.icon), item.file + " 的 iconUrl('" + item.icon + "') 既不是注册表图标也不是已知非应用资产");
  }
  // 允许存在的旁路（应用页里的“自己的身份图标”）必须与注册表里的同名图标一致，
  // 且每个文件只允许出现自己的那个图标名；新增旁路请改成 iconUrl(appById(id).icon)。
  const expectedOwnIcon = {
    "src-vue/apps/WeatherApp.vue": "weather",
    "src-vue/apps/NotesApp.vue": "text-editor",
    "src-vue/apps/VideoApp.vue": "video",
    "src-vue/apps/AutomationApp.vue": "clock",
    "src-vue/apps/TrashApp.vue": "trash",
    "src-vue/apps/DramaApp.vue": "drama",
    "src-vue/apps/ProjectsApp.vue": "folder",
  };
  const appPageLiterals = callLiterals.filter((item) => item.file.indexOf("src-vue/apps/") === 0);
  for (const item of appPageLiterals) {
    assert.equal(item.icon, expectedOwnIcon[item.file], item.file + " 出现了非自身身份图标的硬编码：" + item.icon);
  }
  for (const [file, icon] of Object.entries(expectedOwnIcon)) {
    assert.ok(appPageLiterals.some((item) => item.file === file && item.icon === icon), file + " 的自身身份图标 '" + icon + "' 变了吗？");
  }
});

test("⑦ 旧 React 入口与注册表在共享 appId 上图标一致，自身也不重复", () => {
  assert.ok(LEGACY.length >= 10, "src/main.tsx 的 apps 清单解析失败：" + LEGACY.length);
  for (const legacy of LEGACY) {
    const current = byId.get(legacy.id);
    if (current) assert.equal(legacy.icon, current.icon, "旧入口 " + legacy.id + " 图标与注册表不一致");
    assert.ok(fs.existsSync(iconPath(legacy.icon)), "旧入口引用的图标缺失：" + legacy.icon + ".png");
  }
  const legacyIcons = LEGACY.map((entry) => entry.icon);
  assert.equal(new Set(legacyIcons).size, legacyIcons.length, "旧入口内部有共用图标");
  // 旧入口的“组织治理”与当前“组织”是同一 appId，名字不同但图标必须已经分开。
  assert.equal(byId.get("organization").icon, "contacts");
  assert.equal(LEGACY.find((entry) => entry.id === "organization").icon, "contacts");
  assert.equal(LEGACY.find((entry) => entry.id === "mcp-center").icon, "mcp");
});

test("⑧ DOCK_DEFAULT 的 appId 全部能在注册表里找到（程序坞不会渲染空图标）", () => {
  const block = /export const DOCK_DEFAULT[^=]*=\s*\[([\s\S]*?)\];/.exec(APPS_SOURCE);
  assert.ok(block, "DOCK_DEFAULT 解析失败");
  const ids = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length >= 10, "DOCK_DEFAULT 数量异常：" + ids.length);
  const missing = ids.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], "DOCK_DEFAULT 引用了不存在的 appId");
  assert.ok(byName.size === REGISTRY.length, "应用名重复会让按名查图标失准");
});
