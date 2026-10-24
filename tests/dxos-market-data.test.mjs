/**
 * task-21 · 应用市场数据源：本地清单 additive 扩展（模板 / 发布时间 / 精选 rails / 六段 / 提示词）。
 *
 * 全覆盖离线（只读 resources/market/catalog.json 与纯函数），不联网、不启动 Electron：
 *   ① 模板条目：必填 id/name/prompt；kind 白名单；steps / 提示词 / 六段有界；非法丢弃
 *   ② 清单：templates 可选、必须数组；非法条目计数；全部非法 → MANIFEST_INVALID（与 apps / skillPacks 同口径）
 *   ③ railPages：最多 6 条、每条 itemIds ≤30，非法条目丢弃
 *   ④ 随包 catalog.json：5 条官方技能包（id 与 skill-store 官方技能一致、prompt 与 systemPrompt 逐字一致）、
 *      6 条模板（对应画布 starter flow）、3 个分类、2 条 rails、发布时间可倒序
 *   ⑤ market-service：market/catalog 带出 templates / railPages；health.templateCount 真实
 *   ⑥ 向后兼容：没有 templates / railPages / 新字段的旧清单照样有效
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketDomain = require("../electron/market-domain.cjs");
const { createMarketBundle } = require("../electron/market-service.cjs");
const skillStore = require("../electron/skill-store.cjs");

const shippedRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "market", "catalog.json"), "utf8"));
const shipped = marketDomain.normalizeLocalManifest(shippedRaw);
const OFFICIAL_IDS = ["chat", ...[...skillStore.OFFICIAL_PRESET_IDS].sort()];

test("模板：必填 id/name/prompt；kind 白名单；steps 与文案有界", () => {
  const base = { id: "tpl.ok", name: "模板", prompt: "提示词", kind: "image", category: "film-creative", steps: [{ title: "A", detail: "B" }] };
  const ok = marketDomain.normalizeMarketplaceTemplate(base);
  assert.equal(ok.id, "tpl.ok");
  assert.equal(ok.kind, "image");
  assert.equal(ok.version, "1.0.0");
  assert.equal(ok.nodeTitle, "A", "缺省取第一个步骤标题");
  assert.equal(marketDomain.normalizeMarketplaceTemplate({ ...base, id: "中文 id" }), null);
  assert.equal(marketDomain.normalizeMarketplaceTemplate({ ...base, name: "" }), null);
  assert.equal(marketDomain.normalizeMarketplaceTemplate({ ...base, prompt: "" }), null, "模板必须有可复制的提示词");
  assert.equal(marketDomain.normalizeMarketplaceTemplate({ ...base, kind: "nope" }).kind, "text", "未知 kind 回落 text");
  const many = marketDomain.normalizeMarketplaceTemplate({ ...base, prompt: "x".repeat(5000), steps: Array.from({ length: 15 }, (_, i) => ({ title: "s" + i })) });
  assert.equal(many.prompt.length, 4000, "提示词截断到 4000");
  assert.equal(many.steps.length, 12, "步骤最多 12 条");
  const sections = marketDomain.normalizeMarketplaceTemplate({ ...base, sections: { what: "w".repeat(2000), context: "", how: "h", bogus: "x" } });
  assert.equal(sections.sections.what.length, 1200, "六段每段截断到 1200");
  assert.equal(sections.sections.context, undefined);
  assert.equal(sections.sections.bogus, undefined);
});

test("清单：templates 可选且必须数组；非法模板计数；全是非法模板 → MANIFEST_INVALID", () => {
  const withTemplates = marketDomain.normalizeLocalManifest({ version: 1, apps: [], templates: [{ id: "tpl.a", name: "A", prompt: "p" }, { id: "bad id!", name: "x", prompt: "p" }, { name: "没有 id", prompt: "p" }] });
  assert.equal(withTemplates.ok, true, JSON.stringify(withTemplates));
  assert.equal(withTemplates.value.templates.length, 1);
  assert.deepEqual(withTemplates.value.rejected, { apps: 0, skillPacks: 0, templates: 2, templateDocs: 0, appSources: 0, appPackages: 0 });
  const notArray = marketDomain.normalizeLocalManifest({ version: 1, apps: [], templates: {} });
  assert.equal(notArray.ok, false);
  assert.equal(notArray.error.code, "MARKET_MANIFEST_INVALID");
  const allBad = marketDomain.normalizeLocalManifest({ version: 1, apps: [], templates: [{ id: "ok", name: "缺提示词" }] });
  assert.equal(allBad.ok, false);
  assert.equal(allBad.error.code, "MARKET_MANIFEST_INVALID");
  // 向后兼容：旧清单没有 templates / railPages / 新字段仍然有效
  const legacy = marketDomain.normalizeLocalManifest({ version: 1, apps: [], skillPacks: [{ id: "pack.a", name: "A", version: "1.0.0" }] });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.value.templates, []);
  assert.deepEqual(legacy.value.railPages, []);
  assert.deepEqual(legacy.value.rejected, { apps: 0, skillPacks: 0, templates: 0, templateDocs: 0, appSources: 0, appPackages: 0 });
});

test("精选 rails：最多 6 条、每条 itemIds ≤30；非法条目丢弃", () => {
  const rails = marketDomain.normalizeRailPages([
    ...Array.from({ length: 8 }, (_, i) => ({ id: "r" + i, title: "R" + i, itemIds: Array.from({ length: 40 }, (_, k) => "id" + k) })),
    { id: "bad id", title: "x", itemIds: [] },
    { id: "no-title", itemIds: [] },
  ]);
  assert.equal(rails.length, 6);
  assert.equal(rails[0].itemIds.length, 30);
  assert.deepEqual(marketDomain.normalizeRailPages("nope"), []);
});

test("随包清单：5 条官方技能包（id 与官方技能一致、提示词逐字一致）+ 6 条模板 + 3 个分类 + 2 条 rails", () => {
  assert.equal(shipped.ok, true, JSON.stringify(shipped));
  const value = shipped.value;
  assert.equal(value.apps.length, 8, "task-28：8 条真实应用条目（id 取自应用注册表）");
  assert.equal(value.skillPacks.length, 5);
  assert.deepEqual(value.skillPacks.map((pack) => pack.id).sort(), [...OFFICIAL_IDS].sort(), "技能包 id 必须与 skill/list 的官方技能一致");
  for (const pack of value.skillPacks) {
    const def = skillStore.SKILLS.find((skill) => skill.id === pack.id);
    assert.ok(def, "技能包必须在 skill-store 里有定义：" + pack.id);
    assert.equal(pack.prompt, def.systemPrompt, pack.id + " 的提示词必须与线上技能 systemPrompt 逐字一致");
    assert.equal(pack.featured === true, pack.id === "writing" || pack.id === "code", pack.id + " 精选标记");
    assert.ok(pack.publishedAt > 0, pack.id + " 必须有发布时间");
    assert.ok(pack.sections.what && pack.sections.how, pack.id + " 六段至少有 what/how");
  }
  assert.equal(value.templates.length, 6);
  const expectedTemplates = ["tpl-image-rebackground", "tpl-first-frame-video", "tpl-ecom-poster", "tpl-table-batch", "tpl-storyboard-video", "tpl-text-to-video"];
  assert.deepEqual(value.templates.map((item) => item.id).sort(), expectedTemplates.sort());
  for (const template of value.templates) {
    assert.ok(template.prompt.length > 0, template.id + " 有提示词");
    assert.ok(template.steps.length >= 2, template.id + " 至少两步");
    assert.ok(["text", "image", "video", "audio"].includes(template.kind), template.id + " kind 合法");
    assert.ok(template.category, template.id + " 有分类");
    assert.ok(template.publishedAt > 0, template.id + " 有发布时间");
    assert.ok(template.summary, template.id + " 有 summary");
  }
  assert.deepEqual(value.categories.map((item) => item.id).sort(), ["brand-design", "creative", "ecommerce-ads", "efficiency", "film-creative", "team-resource"]);
  assert.deepEqual(
    Object.fromEntries(value.categories.map((item) => [item.id, item.count])),
    { creative: 4, efficiency: 2, "team-resource": 2, "brand-design": 1, "film-creative": 3, "ecommerce-ads": 2 },
    "分类计数把应用 / 模板都算进去",
  );
  assert.equal(value.railPages.length, 2);
  const entryIds = new Set([...value.apps, ...value.skillPacks, ...value.templates].map((item) => item.id));
  for (const rail of value.railPages) for (const id of rail.itemIds) assert.ok(entryIds.has(id), rail.id + " 的 " + id + " 必须能解析到条目");
  // task-28 起应用条目也进「最新上线」，AI Studio（1760860800000）比电商套图（1760812800000）更新
  const latest = [...value.apps, ...value.skillPacks, ...value.templates].filter((item) => item.publishedAt > 0).sort((a, b) => b.publishedAt - a.publishedAt);
  assert.equal(latest[0].id, "canvas", "「最新上线」第一条应是发布时间最新的条目（应用也计入）");
  assert.equal(latest[1].id, "tpl-ecom-poster");
  const featured = [...value.skillPacks, ...value.templates].filter((item) => item.featured);
  assert.equal(featured.length, 4, "两条精选技能 + 两个精选模板");
});


test("模板 doc：节点/连线有界、id 唯一、kind 白名单、坐标尺寸夹紧、端点必须存在", () => {
  const doc = {
    nodes: [
      { id: "n1", kind: "text", x: -999999, y: 999999, w: 10, h: 99999, title: "t", prompt: "p".repeat(5000) },
      { id: "n2", kind: "image", x: 0, y: 0, w: 260, h: 260 },
      { id: "n3", kind: "table", x: 0, y: 0, w: 420, h: 220, table: { title: "表", columns: Array.from({ length: 20 }, (_, i) => "c" + i), rows: Array.from({ length: 80 }, () => Array.from({ length: 20 }, () => "cell")) } },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2" }, { id: "e2", from: "n2", to: "n3" }],
  };
  const ok = marketDomain.normalizeTemplateDoc(doc);
  assert.ok(ok, "合法 doc");
  assert.equal(ok.nodes.length, 3);
  assert.equal(ok.edges.length, 2);
  assert.equal(ok.nodes[0].x, -200000, "坐标夹紧");
  assert.equal(ok.nodes[0].y, 200000);
  assert.equal(ok.nodes[0].w, 40, "尺寸下限 40");
  assert.equal(ok.nodes[0].h, 4000, "尺寸上限 4000");
  assert.equal(ok.nodes[0].prompt.length, 4000, "提示词截断 4000");
  assert.equal(ok.nodes[2].table.columns.length, 12, "表格列上限 12");
  assert.equal(ok.nodes[2].table.rows.length, 50, "表格行上限 50");
  assert.equal(ok.nodes[2].table.rows[0].length, 12);

  const invalid = [
    { nodes: [], edges: [] },
    { nodes: Array.from({ length: 31 }, (_, i) => ({ id: "n" + i, kind: "text" })), edges: [] },
    { nodes: [{ id: "n1", kind: "text" }, { id: "n1", kind: "text" }], edges: [] },
    { nodes: [{ id: "n1", kind: "video-game" }], edges: [] },
    { nodes: [{ id: "n1", kind: "text" }], edges: [{ from: "n1", to: "missing" }] },
    { nodes: [{ id: "n1", kind: "text" }], edges: [{ from: "n1", to: "n1" }] },
    { nodes: Array.from({ length: 2 }, (_, i) => ({ id: "n" + i, kind: "text" })), edges: Array.from({ length: 61 }, (_, i) => ({ from: "n0", to: "n1" })) },
    { nodes: [{ id: "n1", kind: "table" }], edges: [] },
    null,
    "nope",
  ];
  for (const bad of invalid) assert.equal(marketDomain.normalizeTemplateDoc(bad), null, JSON.stringify(bad).slice(0, 80));
});

test("模板 doc 不合法：模板保留（退回只建首节点），rejected.templateDocs 计数", () => {
  const res = marketDomain.normalizeLocalManifest({
    version: 1,
    apps: [],
    templates: [
      { id: "tpl.good", name: "好的", prompt: "p", doc: { nodes: [{ id: "n1", kind: "text" }], edges: [] } },
      { id: "tpl.bad", name: "坏的", prompt: "p", doc: { nodes: [{ id: "n1", kind: "text" }], edges: [{ from: "n1", to: "gone" }] } },
      { id: "tpl.nodoc", name: "没 doc", prompt: "p" },
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.templates.length, 3);
  assert.equal(res.value.templates.find((t) => t.id === "tpl.good").doc.nodes.length, 1);
  assert.equal(res.value.templates.find((t) => t.id === "tpl.bad").doc, null, "非法 doc 被丢弃");
  assert.equal(res.value.templates.find((t) => t.id === "tpl.nodoc").doc, null);
  assert.equal(res.value.rejected.templateDocs, 1);
  assert.equal(JSON.stringify(res.value).includes("__docInvalid"), false, "内部标记不得过桥");
});

test("随包 6 个模板都带真实 doc（节点/连线数与任务书一致，id 前缀、端点存在、表格有数据）", () => {
  const expected = {
    "tpl-text-to-video": [2, 1],
    "tpl-image-rebackground": [2, 1],
    "tpl-first-frame-video": [2, 1],
    "tpl-ecom-poster": [6, 8],
    "tpl-table-batch": [3, 2],
    "tpl-storyboard-video": [3, 2],
  };
  const value = shipped.value;
  assert.equal(value.rejected.templateDocs, 0, "随包模板 doc 必须全部合法");
  for (const template of value.templates) {
    assert.ok(template.doc, template.id + " 必须有 doc");
    const [n, e] = expected[template.id];
    assert.equal(template.doc.nodes.length, n, template.id + " 节点数");
    assert.equal(template.doc.edges.length, e, template.id + " 连线数");
    const ids = new Set(template.doc.nodes.map((node) => node.id));
    for (const node of template.doc.nodes) {
      assert.ok(node.id.indexOf("tpl-") === 0, node.id + " 必须带模板前缀");
      assert.ok(marketDomain.TEMPLATE_NODE_KINDS.includes(node.kind), node.id + " kind 合法");
      assert.ok(node.w >= 40 && node.w <= 4000 && node.h >= 40 && node.h <= 4000, node.id + " 尺寸有界");
      if (node.kind === "table") assert.ok(node.table && node.table.columns.length >= 1 && node.table.rows.length >= 1, node.id + " 表格必须有列与行");
    }
    for (const edge of template.doc.edges) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to), edge.id + " 端点必须存在");
      assert.notEqual(edge.from, edge.to);
    }
    const prompts = template.doc.nodes.map((node) => node.prompt).filter(Boolean);
    assert.ok(prompts.length > 0, template.id + " 至少一个节点带提示词");
    assert.ok(prompts.join("").indexOf(template.prompt) >= 0, template.id + " 模板 prompt 必须出现在某个节点里");
  }
});


test("catalog apps：8 条真实应用条目（id/name/version 与注册表一致，build=1，分类/发布时间/精选/提示词合法）", () => {
  const apps = shipped.value.apps;
  const registry = require("../src-vue/apps.ts");
  const ids = apps.map((app) => app.id);
  assert.equal(new Set(ids).size, ids.length, "id 不得重复（去重口径：id）");
  assert.deepEqual(ids.slice().sort(), ["browser", "canvas", "chat", "music", "photos", "projects", "resource-library", "video"]);
  for (const app of apps) {
    const entry = registry.APPS.find((item) => item.id === app.id);
    assert.ok(entry, app.id + " 必须在应用注册表里");
    assert.equal(app.name, entry.name, app.id + " 名称取注册表");
    assert.equal(app.version, entry.version, app.id + " 版本取注册表");
    assert.equal(app.build, 1, app.id + " build 填 1");
    assert.ok(app.category === "software", app.id + " category 只允许 software/games");
    assert.ok(app.categoryIds.length >= 1 && app.categoryIds.every((id) => /^[a-z0-9._-]+$/.test(id)), app.id + " categoryIds 必须是合法 id");
    assert.ok(app.publishedAt > 0, app.id + " 必须有发布时间");
    assert.ok(app.summary.length > 0, app.id + " 必须有 summary");
    assert.ok(app.sections.what && app.sections.context && app.sections.how && app.sections.output && app.sections.scope && app.sections.followUp, app.id + " 六段必须齐全");
  }
  assert.equal(apps.filter((app) => app.featured).length, 2, "精选：AI Studio 与对话");
  const withPrompt = apps.filter((app) => app.prompt).map((app) => app.id).sort();
  assert.deepEqual(withPrompt, ["canvas", "chat"], "只有真的能拿提示词直接用的应用才带 prompt，其余如实留空");
});

test("catalog apps 非法条目：缺 build / 缺 version / 非法 id / 非对象一律丢弃并计数", () => {
  const raw = {
    version: 1,
    apps: [
      { id: "canvas", name: "AI Studio", version: "0.1.0", build: 1 },
      { id: "photos", name: "相册", version: "0.1.0" },
      { id: "music", version: "0.1.0", build: 1 },
      { id: "bad id!", name: "x", version: "0.1.0", build: 1 },
      { id: "video", name: "视频剪辑", version: "", build: 1 },
      "nope",
    ],
    skillPacks: [],
    templates: [],
  };
  const res = marketDomain.normalizeLocalManifest(raw);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.value.apps.map((app) => app.id), ["canvas"]);
  assert.equal(res.value.rejected.apps, 5);
  assert.equal(marketDomain.normalizeMarketplaceApp({ id: "x", name: "x", version: "1", build: 1 }).build, 1);
  assert.equal(marketDomain.normalizeMarketplaceApp({ id: "x", name: "x", version: "1", build: 1, prompt: "p".repeat(5000) }).prompt.length, 4000, "提示词有界");
  assert.equal(marketDomain.normalizeMarketplaceApp({ id: "x", name: "x", version: "1", build: 1, sections: { what: "w".repeat(2000) } }).sections.what.length, 1200, "六段有界");
});


test("应用来源/更新元数据：https + 64 hex sha256 + 有界 size/version；非法字段丢弃并计数", () => {
  const sha = "a".repeat(64);
  const base = { id: "canvas", name: "AI Studio", version: "0.1.0", build: 1 };
  const pkg = { url: "https://example.com/app.zip", sha256: sha, size: 1024 * 1024 * 12, version: "0.1.0" };
  const ok = marketDomain.normalizeMarketplaceApp({ ...base, builtIn: true, sourceUrl: "https://example.com/app", package: pkg });
  assert.equal(ok.builtIn, true);
  assert.equal(ok.sourceUrl, "https://example.com/app");
  assert.equal(ok.package.sha256, sha);
  assert.equal(ok.package.size, pkg.size);
  // http 不是 https → 丢弃
  assert.equal(marketDomain.normalizeMarketplaceApp({ ...base, sourceUrl: "http://example.com/app" }).sourceUrl, "");
  assert.equal(marketDomain.normalizeMarketplaceApp({ ...base, package: { ...pkg, url: "http://example.com/app.zip" } }).package, null);
  // sha256 非 hex / 长度不对 → 丢弃
  assert.equal(marketDomain.normalizeAppPackage({ ...pkg, sha256: "z".repeat(64) }), null);
  assert.equal(marketDomain.normalizeAppPackage({ ...pkg, sha256: "abc" }), null);
  // 缺字段 / 越界 → 丢弃
  assert.equal(marketDomain.normalizeAppPackage({ ...pkg, size: 0 }), null);
  assert.equal(marketDomain.normalizeAppPackage({ ...pkg, version: "" }), null);
  assert.equal(marketDomain.normalizeAppPackage({ ...pkg, size: 20 * 1024 * 1024 * 1024 + 1 }), null);
  assert.equal(marketDomain.normalizeAppPackage({ ...pkg, size: 1.5 }), null);
  // 清单计数：非法 sourceUrl / package 各自计入，条目保留
  const res = marketDomain.normalizeLocalManifest({
    version: 1,
    apps: [
      { ...base, sourceUrl: "http://bad.example.com", package: { ...pkg, sha256: "not-hex" } },
      { ...base, id: "photos", name: "相册", sourceUrl: "https://ok.example.com", package: pkg },
    ],
    skillPacks: [],
    templates: [],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.apps.length, 2);
  assert.equal(res.value.apps[0].sourceUrl, "", "非法 sourceUrl 丢弃");
  assert.equal(res.value.apps[0].package, null, "非法 package 丢弃");
  assert.equal(res.value.apps[1].sourceUrl, "https://ok.example.com/");
  assert.equal(res.value.rejected.appSources, 1);
  assert.equal(res.value.rejected.appPackages, 1);
  assert.equal(JSON.stringify(res.value).includes("__packageInvalid"), false);
});

test("详情投影：内置给更新命令、外部包给来源/大小/校验和且安装禁用（通道未接）", () => {
  const builtIn = marketDomain.projectMarketplaceAppDetail({ builtIn: true });
  assert.equal(builtIn.builtIn, true);
  assert.equal(builtIn.updateCommand, "market/update/health");
  assert.deepEqual(builtIn.install, { enabled: false, reason: "NO_PACKAGE" });
  const external = marketDomain.projectMarketplaceAppDetail({
    builtIn: false,
    sourceUrl: "https://example.com/app",
    package: { url: "https://example.com/app.zip", sha256: "b".repeat(64), size: 2048, version: "1.2.3" },
  });
  assert.equal(external.updateCommand, null);
  assert.equal(external.packageUrl, "https://example.com/app.zip");
  assert.equal(external.packageSize, 2048);
  assert.equal(external.packageSha256, "b".repeat(64));
  assert.deepEqual(external.install, { enabled: false, reason: "THIRD_PARTY_PACKAGE_CHANNEL_NOT_WIRED" });
});

test("随包 8 条内置应用：builtIn=true、没有 package（无真实可达包地址就不写）、来源计数为 0", () => {
  const apps = shipped.value.apps;
  assert.equal(apps.length, 8);
  assert.equal(apps.every((app) => app.builtIn === true), true, "8 条都应标内置");
  assert.equal(apps.every((app) => app.package === null), true, "没有真实可达安装包 → package 留空");
  assert.equal(apps.every((app) => app.sourceUrl === ""), true);
  assert.equal(shipped.value.rejected.appSources, 0);
  assert.equal(shipped.value.rejected.appPackages, 0);
});

test("market-service：market/catalog 带出 templates / railPages，health.templateCount 真实", async () => {
  const bundle = createMarketBundle({ appDir: ROOT, clock: () => 1 });
  assert.equal(bundle.resolveCatalogDir(), path.join(ROOT, "resources", "market"));
  const res = await bundle.execute("market/catalog", {}, { sessionRef: "s1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.templates.length, 6);
  assert.equal(res.value.railPages.length, 2);
  assert.equal(res.value.skillPacks.length, 5);
  const status = bundle.catalogStatus();
  assert.equal(status.templateCount, 6);
  const health = await bundle.execute("market/health", {}, { sessionRef: "s1" });
  assert.equal(health.value.templateCount, 6);
  assert.equal(health.value.skillPackCount, 5);
  assert.equal(health.value.appCount, 8);
  assert.equal(JSON.stringify(res.value).includes(ROOT), false, "绝对路径不得过桥");
});
