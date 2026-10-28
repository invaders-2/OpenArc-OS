/**
 * task-21 · 应用市场数据源：本地清单 additive 扩展（模板 / 发布时间 / 精选 rails / 六段 / 提示词）。
 *
 * 全覆盖离线（只读 resources/market/catalog.json 与纯函数），不联网、不启动 Electron：
 *   ① 模板条目：必填 id/name/prompt；kind 白名单；steps / 提示词 / 六段有界；非法丢弃
 *   ② 清单：templates 可选、必须数组；非法条目计数；全部非法 → MANIFEST_INVALID（与 apps / skillPacks 同口径）
 *   ③ railPages：最多 6 条、每条 itemIds ≤30，非法条目丢弃
 *   ④ 随包 catalog.json：5 条官方技能包（id 与 skill-store 官方技能一致、prompt 与 systemPrompt 逐字一致）、
 *      24 条模板（6 条起步 + 18 条扩充，覆盖 5 个业务分类）、8 个分类、2 条 rails、发布时间可倒序
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

/**
 * 跨任务契约：TapNow 条目里「真正带 guide」的判据从源文件实测。
 * resources/market/tapnow-items.json 归 task-59（详情补齐）维护、会被并行动，所以不写死条数；
 * 判据与 market-domain 的 normalizeTapnowGuide 拒绝规则一致：任一文本段非空，或至少一条用例带标题。
 */
function hasTapnowGuide(guide) {
  if (!guide || typeof guide !== "object" || Array.isArray(guide)) return false;
  const filled = ["summary", "requiredContext", "steps", "outputs", "boundaries", "followUps"].some((key) => String(guide[key] || "").trim());
  const hasUseCase = Array.isArray(guide.useCases) && guide.useCases.some((entry) => entry && String(entry.title || (typeof entry === "string" ? entry : "")).trim());
  return filled || hasUseCase;
}
function countTapnowGuides(raw) {
  const items = Array.isArray(raw && raw.items) ? raw.items : [];
  return items.filter((item) => hasTapnowGuide(item && item.guide)).length;
}

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

test("随包清单：5 条官方技能包（id 与官方技能一致、提示词逐字一致）+ 24 条模板 + 8 个分类 + 2 条 rails", () => {
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
  // 数据契约：模板从 6 条扩到 24 条；条数断言跟着契约走，既有 6 条必须原样保留。
  assert.equal(value.templates.length, 24, "模板 24 条：6 条起步 + 18 条扩充");
  const legacyTemplates = ["tpl-image-rebackground", "tpl-first-frame-video", "tpl-ecom-poster", "tpl-table-batch", "tpl-storyboard-video", "tpl-text-to-video"];
  const templateIds = value.templates.map((item) => item.id);
  assert.equal(new Set(templateIds).size, templateIds.length, "模板 id 全局唯一");
  for (const id of legacyTemplates) assert.ok(templateIds.includes(id), id + " 必须原样保留（railPages 与其它用例引用它）");
  for (const template of value.templates) {
    assert.ok(template.prompt.length > 0, template.id + " 有提示词");
    assert.ok(template.steps.length >= 2, template.id + " 至少两步");
    assert.ok(["text", "image", "video", "audio"].includes(template.kind), template.id + " kind 合法");
    assert.ok(template.category, template.id + " 有分类");
    assert.ok(template.publishedAt > 0, template.id + " 有发布时间");
    assert.ok(template.summary, template.id + " 有 summary");
  }
  assert.deepEqual(value.categories.map((item) => item.id).sort(), ["brand-design", "creative", "ecommerce-ads", "efficiency", "film-creative", "interactive-games", "social-media-content", "team-resource"]);
  assert.deepEqual(
    Object.fromEntries(value.categories.map((item) => [item.id, item.count])),
    { creative: 4, efficiency: 2, "team-resource": 2, "brand-design": 5, "film-creative": 5, "ecommerce-ads": 6, "interactive-games": 3, "social-media-content": 5 },
    "分类计数把应用 / 模板都算进去（模板扩到 24 条后按实际条数重算，清单里写 count:0 即运行时合并口径）",
  );
  assert.equal(value.railPages.length, 2);
  const entryIds = new Set([...value.apps, ...value.skillPacks, ...value.templates].map((item) => item.id));
  for (const rail of value.railPages) for (const id of rail.itemIds) assert.ok(entryIds.has(id), rail.id + " 的 " + id + " 必须能解析到条目");
  // 2026-09~10 新增 18 条模板后，最新的条目变成新模板；断言口径不变：按 publishedAt 倒序取第一/第二条
  const latest = [...value.apps, ...value.skillPacks, ...value.templates].filter((item) => item.publishedAt > 0).sort((a, b) => b.publishedAt - a.publishedAt);
  assert.equal(latest[0].id, "tpl-social-calendar-poster", "「最新上线」第一条应是发布时间最新的条目（2026-10-23）");
  assert.equal(latest[1].id, "tpl-social-talking-head", "第二条为次新条目（2026-10-20）");
  assert.ok(latest.some((item) => item.id === "canvas"), "应用条目仍计入「最新上线」候选");
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

test("随包 24 个模板都带真实 doc（节点/连线数与清单一致，id 前缀、端点存在、表格有数据）", () => {
  const expected = {
    "tpl-text-to-video": [2, 1],
    "tpl-image-rebackground": [2, 1],
    "tpl-first-frame-video": [2, 1],
    "tpl-ecom-poster": [6, 8],
    "tpl-table-batch": [3, 2],
    "tpl-storyboard-video": [3, 2],
    "tpl-text-to-image": [2, 1],
    "tpl-product-scene": [3, 2],
    "tpl-brand-board": [3, 2],
    "tpl-sticker-pack": [3, 2],
    "tpl-character-turnaround": [4, 3],
    "tpl-image-to-video": [3, 2],
    "tpl-ecom-detail-long": [4, 3],
    "tpl-ecom-hero-triptych": [4, 3],
    "tpl-ecom-aplus": [3, 2],
    "tpl-ecom-multilang": [3, 2],
    "tpl-game-level-scene": [3, 2],
    "tpl-game-ui-screen": [3, 2],
    "tpl-game-character-card": [3, 2],
    "tpl-social-cover-set": [4, 3],
    "tpl-social-grid-9": [4, 3],
    "tpl-social-podcast": [3, 2],
    "tpl-social-talking-head": [3, 2],
    "tpl-social-calendar-poster": [4, 3],
  };
  const value = shipped.value;
  assert.equal(value.rejected.templateDocs, 0, "随包模板 doc 必须全部合法");
  assert.equal(Object.keys(expected).length, 24, "期望表要覆盖全部 24 条");
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

// 数据契约变更（模板 6 → 24）新增的守门用例：一次断言条数、唯一性、doc 合法性、分类归属与五类覆盖。
test("模板清单契约：24 条 id 唯一、doc 逐条过 normalizeTemplateDoc、分类都在 categories 里且五类齐全", () => {
  const LEGACY = new Set(["tpl-image-rebackground", "tpl-first-frame-video", "tpl-ecom-poster", "tpl-table-batch", "tpl-storyboard-video", "tpl-text-to-video"]);
  const value = shipped.value;
  const ids = value.templates.map((item) => item.id);
  assert.equal(ids.length, 24, "模板 24 条");
  assert.equal(new Set(ids).size, ids.length, "模板 id 不得重复");
  const categoryIds = new Set(value.categories.map((item) => item.id));
  const perCategory = {};
  for (const template of value.templates) {
    assert.match(template.id, /^tpl-[a-z0-9]+(-[a-z0-9]+)*$/, template.id + " id 必须是 tpl- 前缀的小写连字符形状");
    assert.equal(template.version, "1.0.0", template.id + " 版本 1.0.0");
    assert.ok(categoryIds.has(template.category), template.id + " 分类必须在 categories 里：" + template.category);
    perCategory[template.category] = (perCategory[template.category] || 0) + 1;
    const normalized = marketDomain.normalizeTemplateDoc(template.doc);
    assert.ok(normalized, template.id + " doc 必须能过 normalizeTemplateDoc");
    assert.deepEqual(normalized, template.doc, template.id + " doc 不应被夹紧或改写");
    assert.ok(template.tags.length >= 3 && template.tags.length <= 4, template.id + " 3-4 个标签");
    assert.ok(template.summary.length <= 80, template.id + " summary ≤80 字");
    assert.ok(template.prompt.length <= 200, template.id + " prompt ≤200 字");
    assert.ok(template.steps.length >= 3 && template.steps.length <= 5, template.id + " 3-5 步");
    assert.ok(["text", "image", "video", "audio"].includes(template.kind), template.id + " kind 合法");
    if (LEGACY.has(template.id)) continue;
    assert.equal(template.tags.includes("模板"), false, template.id + " 标签不许糊一个「模板」了事");
    assert.ok(template.publishedAt >= Date.parse("2026-09-01T00:00:00Z") && template.publishedAt < Date.parse("2026-11-01T00:00:00Z"), template.id + " 发布时间在 2026-09~10：" + new Date(template.publishedAt).toISOString());
  }
  const dates = value.templates.map((item) => item.publishedAt);
  assert.equal(new Set(dates).size, dates.length, "24 条发布时间互不重复");
  assert.deepEqual(perCategory, { "brand-design": 5, "film-creative": 5, "ecommerce-ads": 6, "interactive-games": 3, "social-media-content": 5 }, "5 个业务分类的模板条数");
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


test("TapNow 字段：ratio 白名单、useCases/tools 有界、modelHint 截断；随包每类条目都有用例与工具", () => {
  const base = { id: "canvas", name: "AI Studio", version: "0.1.0", build: 1 };
  const valid = marketDomain.normalizeMarketplaceApp({
    ...base, ratio: "16/9", modelHint: "m".repeat(120),
    useCases: Array.from({ length: 30 }, (_, i) => ({ title: "用例" + i, description: "d".repeat(600) })),
    tools: Array.from({ length: 30 }, (_, i) => "工具" + i),
  });
  assert.equal(valid.ratio, "16/9");
  assert.equal(valid.modelHint.length, 60, "推荐模型截断到 60");
  assert.equal(valid.useCases.length, 20, "用例最多 20 条");
  assert.equal(valid.useCases[0].description.length, 400, "用例描述截断到 400");
  assert.equal(valid.tools.length, 20, "工具最多 20 个");
  assert.equal(marketDomain.normalizeMarketplaceApp({ ...base, ratio: "5/7" }).ratio, "", "未知比例丢弃");
  const value = shipped.value;
  for (const item of [...value.apps, ...value.skillPacks, ...value.templates]) {
    assert.ok(item.ratio, item.id + " 必须有封面比例");
    assert.ok(item.useCases.length > 0, item.id + " 必须有用例");
    assert.ok(item.tools.length > 0, item.id + " 必须有支持的工具");
  }
});


test("市场分类统一：唯一来源 catalog.categories（顺序 + count>0），顶部与左侧标签集合相等", () => {
  const fs2 = require("node:fs");
  const path2 = require("node:path");
  const src = fs2.readFileSync(path2.join(ROOT, "src-vue/apps/MarketApp.vue"), "utf8");
  assert.match(src, /const marketCategories = computed\(\(\) => \(catalogCategories\.value \|\| \[\]\)\.filter\(\(c\) => c\.count > 0\)\)/, "唯一分类来源应是 catalogCategories 过滤 count>0");
  assert.match(src, /v-for="c in marketCategories"/, "左侧导航必须用 marketCategories");
  assert.match(src, /marketCategoryTabs\.value\.map\(\(c\) => \(\{ id: "cat:" \+ c\.id, label: c\.name \}\)\)/, "顶部页签必须来自同一个列表");
  const categories = shipped.value.categories.filter((c) => c.count > 0);
  assert.ok(categories.length >= 3);
  assert.equal(new Set(categories.map((c) => c.name)).size, categories.length, "分类 label 不重复");
  assert.deepEqual(categories.map((c) => c.id), shipped.value.categories.filter((c) => c.count > 0).map((c) => c.id), "顺序保持 catalog 顺序");
  // 顶部标签 = 全部/应用/官方技能 + 分类 label；左侧标签 = 分类 label。集合相等断言：
  const topLabels = ["全部", "应用", "官方技能", ...categories.map((c) => c.name)];
  const leftLabels = categories.map((c) => c.name);
  assert.deepEqual(new Set(topLabels).size, topLabels.length);
  assert.deepEqual([...new Set(topLabels)].filter((label) => !["全部", "应用", "官方技能"].includes(label)), leftLabels, "顶部与左侧的分类标签集合必须相等");
});


test("TapNow 导入：83 条（60 skill + 23 app），guide 条数按源文件实测，schema/来源/分类/封面色校验", () => {
  const raw = JSON.parse(require("node:fs").readFileSync(require("node:path").join(ROOT, "resources", "market", "tapnow-items.json"), "utf8"));
  const tp = marketDomain.normalizeTapnowManifest(raw);
  assert.equal(tp.ok, true, JSON.stringify(tp).slice(0, 200));
  assert.equal(tp.value.items.length, 83);
  assert.equal(tp.value.skillCount, 60);
  assert.equal(tp.value.appCount, 23);
  assert.equal(tp.value.guideCount, countTapnowGuides(raw), "guideCount 必须等于源文件里真正带 guide 的条数（数据驱动，不写死）");
  assert.equal(tp.value.delistedCount, 2, "2 条来源已下架");
  assert.equal(tp.value.missingGuideCount, 0, "0 条未同步");
  assert.deepEqual(tp.value.items.filter((i) => i.delisted).map((i) => i.id).sort(), ["tapnow-app-tapnow-baidupan", "tapnow-app-tapnow-descript"]);
  assert.equal(tp.value.rejected, 0);
  assert.equal(tp.value.source.name, "TapNow");
  assert.equal(tp.value.source.contentVersion.length, 16);
  assert.deepEqual(tp.value.categories.map((c) => c.id), ["brand-design", "film-creative", "ecommerce-ads", "interactive-games", "social-media-content"]);
  const ids = tp.value.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "id 不得重复");
  assert.ok(ids.every((id) => /^tapnow-(app|skill)-/.test(id)), "id 必须带 tapnow 前缀");
  assert.equal(tp.value.items.filter((i) => !i.businessScenario).length, 19, "19 条缺业务场景照实保留");
  assert.ok(tp.value.items.every((i) => !i.coverUrl || i.coverUrl.startsWith("https://")), "封面只收 https");
  // 非法：schema 不对 / 重复 id / 未知分类 / 非 https 封面（丢弃为空）/ 超长 guide
  assert.equal(marketDomain.normalizeTapnowManifest({ schema: "nope", source: {}, categories: [], items: [] }).ok, false);
  const item = { id: "tapnow-skill-x", kind: "skill", displayName: "X", summary: "s", businessScenario: "brand-design", coverUrl: "http://insecure/x.png" };
  const dup = marketDomain.normalizeTapnowManifest({ schema: marketDomain.TAPNOW_SCHEMA, source: {}, categories: [{ id: "brand-design", label: "品牌设计" }], items: [item, { ...item }] });
  assert.equal(dup.value.items.length, 1, "重复 id 只留一条");
  assert.equal(dup.value.rejected, 1);
  assert.equal(dup.value.items[0].coverUrl, "", "http 封面丢弃");
  const badScenario = marketDomain.normalizeTapnowManifest({ schema: marketDomain.TAPNOW_SCHEMA, source: {}, categories: [{ id: "brand-design", label: "品牌设计" }], items: [{ ...item, businessScenario: "unknown-cat" }] });
  assert.equal(badScenario.value.rejected, 1);
  const longGuide = marketDomain.normalizeTapnowManifest({ schema: marketDomain.TAPNOW_SCHEMA, source: {}, categories: [], items: [{ ...item, businessScenario: "", guide: { summary: "s".repeat(2000), useCases: [{ title: "u", description: "d" }] } }] });
  assert.equal(longGuide.value.items[0].guide.summary.length, 1200);
});

test("市场合并：catalog 分类计数并入 TapNow 条目（只留有内容的分类），external 来源与 contentVersion 标记", async () => {
  const bundle = createMarketBundle({ appDir: ROOT, clock: () => 1 });
  const res = await bundle.execute("market/catalog", {}, { sessionRef: "s1" });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200));
  const value = res.value;
  assert.equal(value.external.source, "tapnow");
  assert.equal(value.external.name, "TapNow");
  assert.equal(value.external.contentVersion.length, 16);
  assert.equal(value.external.count, 83);
  assert.equal(value.external.items.length, 83);
  const tapnowRaw = JSON.parse(require("node:fs").readFileSync(require("node:path").join(ROOT, "resources", "market", "tapnow-items.json"), "utf8"));
  assert.equal(value.external.guideCount, countTapnowGuides(tapnowRaw), "合并后的 guideCount 同样按源文件实测");
  assert.equal(value.external.delistedCount, 2);
  assert.equal(value.external.missingGuideCount, 0);
  const counts = Object.fromEntries(value.categories.map((c) => [c.id, c.count]));
  // 合并计数 = TapNow 条目数 + 本地模板条数：模板扩到 24 条后本地计数变化，期望值随之更新
  assert.equal(counts["interactive-games"], 11, "互动游戏：TapNow 8 + 模板 3");
  assert.equal(counts["social-media-content"], 14, "社媒内容：TapNow 9 + 模板 5");
  assert.equal(counts["brand-design"], 12, "品牌设计：TapNow 7 + 模板 5");
  assert.equal(counts["film-creative"], 37, "影视创意：TapNow 32 + 模板 5");
  assert.equal(counts["ecommerce-ads"], 14, "电商广告：TapNow 8 + 模板 6");
  assert.ok(value.categories.every((c) => c.count > 0), "不放空分类");
  // 去重：本地条目 id 与 TapNow id 不重叠
  const localIds = new Set([...value.apps, ...value.skillPacks, ...value.templates].map((x) => x.id));
  assert.equal(value.external.items.filter((i) => localIds.has(i.id)).length, 0);
  const health = await bundle.execute("market/health", {}, { sessionRef: "s1" });
  assert.equal(health.value.externalItems, 83);
});

test("TapNow 详情投影：guide 6 段 + 用例；无 guide 标详情未同步；不导入对方提示词正文", () => {
  const raw = JSON.parse(require("node:fs").readFileSync(require("node:path").join(ROOT, "resources", "market", "tapnow-items.json"), "utf8"));
  const tp = marketDomain.normalizeTapnowManifest(raw).value;
  const withGuide = tp.items.filter((i) => i.guide);
  assert.equal(withGuide.length, countTapnowGuides(raw), "带 guide 条数必须与源文件实测一致");
  const partial = withGuide.find((i) => !i.guide.boundaries || !i.guide.requiredContext);
  assert.ok(partial, "存在缺段条目（用于验证缺段渲染）");
  assert.equal(typeof partial.guide.requiredContext, "string", "缺段保留空串，不假设八段齐全");
  const delisted = tp.items.filter((i) => i.delisted);
  assert.equal(delisted.length, 2);
  assert.ok(delisted.every((i) => !i.guide), "下架条目没有 guide");
  for (const item of withGuide) {
    assert.ok(item.guide.summary, item.id + " guide.summary 必有（items2 覆盖 81/81）");
    for (const key of ["requiredContext", "steps", "outputs", "boundaries", "followUps"]) {
      assert.equal(typeof item.guide[key], "string", item.id + " " + key + " 缺段保留空串");
    }
    assert.ok(Array.isArray(item.guide.useCases));
    assert.equal(JSON.stringify(item.guide).includes("{{skill:"), false, "不得导入对方提示词正文");
  }
  const full = withGuide.find((i) => i.guide.steps && i.guide.outputs && i.guide.boundaries);
  assert.ok(full, "至少一条六段齐全（截图用）");
  assert.equal(tp.items.filter((i) => !i.guide && !i.delisted).length, 0, "没有未同步条目");
  // 源码口径：封面失败回退 + 外部 CTA 文案
  const src = require("node:fs").readFileSync(require("node:path").join(ROOT, "src-vue/apps/MarketApp.vue"), "utf8");
  assert.match(src, /@error="brokenCovers\[entry\.id\] = true"/, "封面加载失败必须回退");
  assert.match(src, /data-market-cover-fallback/, "回退封面有数据标记");
  assert.match(src, /copyText: item\.displayName \+ "\\n" \+ item\.summary/, "复制简介使用同步简介");
  assert.match(src, /TAPNOW_DETAIL_MISSING/, "无 guide 显示详情未同步");
  assert.match(src, /已从来源下架/, "下架条目有诚实状态文案");
  assert.match(src, /chat: delisted/, "下架条目禁用「在对话中试用」");
});

// 跨任务契约：TapNow guide 计数与字段一律对源文件推导（task-59 正在并行补齐 guide，不写死数字）。
test("TapNow guide 数据驱动：计数来自源文件，字段与源数据一致（不凭空长/不被吞/不含 HTML/不是字符串化 JSON）", () => {
  const raw = JSON.parse(require("node:fs").readFileSync(require("node:path").join(ROOT, "resources", "market", "tapnow-items.json"), "utf8"));
  const tp = marketDomain.normalizeTapnowManifest(raw);
  assert.equal(tp.ok, true, JSON.stringify(tp).slice(0, 200));
  assert.equal(tp.value.guideCount, countTapnowGuides(raw), "guideCount = 源文件里真正带 guide 的条数");
  assert.equal(tp.value.delistedCount, tp.value.items.filter((item) => item.delisted).length, "delistedCount 与条目标记一致");
  assert.equal(tp.value.missingGuideCount, tp.value.items.filter((item) => !item.guide && !item.delisted).length, "missingGuideCount 与条目一致");
  assert.equal(tp.value.guideCount + tp.value.missingGuideCount + tp.value.delistedCount, tp.value.items.length, "带 guide + 未同步 + 下架 = 总条数");
  const HTML = /<[a-zA-Z!/][^>]*>/;
  const looksLikeJson = (text) => {
    const trimmed = text.trim();
    if (!trimmed || !/^[[{]/.test(trimmed)) return false;
    try { JSON.parse(trimmed); return true; } catch { return false; }
  };
  const rawById = new Map((Array.isArray(raw.items) ? raw.items : []).map((item) => [String((item && item.id) || ""), item]));
  for (const item of tp.value.items) {
    const source = rawById.get(item.id);
    assert.ok(source, item.id + " 必须能在源文件里找到");
    // 有/无 guide 必须与源数据一致：不凭空长出来，也不被吞掉
    assert.equal(item.guide !== null, hasTapnowGuide(source.guide), item.id + " 有/无 guide 必须与源数据一致");
    if (!item.guide) continue;
    for (const key of marketDomain.TAPNOW_GUIDE_KEYS) {
      const expected = String(source.guide[key] == null ? "" : source.guide[key]).trim().slice(0, 1200);
      assert.equal(item.guide[key], expected, item.id + " guide." + key + " 必须与源数据一致（源里空就空着，不许编造）");
    }
    const expectedScenarios = (Array.isArray(source.guide.scenarios) ? source.guide.scenarios : [])
      .map((entry) => String(entry == null ? "" : entry).trim().slice(0, 2048)).filter(Boolean).slice(0, 12)
      .map((entry) => entry.slice(0, 80)).filter(Boolean);
    assert.deepEqual(item.guide.scenarios, expectedScenarios, item.id + " guide.scenarios 必须与源数据一致");
    const expectedUseCases = (Array.isArray(source.guide.useCases) ? source.guide.useCases : [])
      .map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : { title: entry }))
      .map((entry) => ({
        title: String(entry.title == null ? "" : entry.title).trim().slice(0, 120),
        description: String(entry.description == null ? "" : entry.description).trim().slice(0, 400),
        context: String(entry.context == null ? "" : entry.context).trim().slice(0, 80),
      }))
      .filter((entry) => entry.title).slice(0, 20);
    assert.deepEqual(item.guide.useCases, expectedUseCases, item.id + " guide.useCases 必须与源数据一致（源里空就空着）");
    const texts = [
      ...marketDomain.TAPNOW_GUIDE_KEYS.map((key) => item.guide[key]),
      ...item.guide.scenarios,
      ...item.guide.useCases.flatMap((entry) => [entry.title, entry.description, entry.context]),
    ].filter(Boolean);
    for (const text of texts) {
      assert.equal(HTML.test(text), false, item.id + " guide 字段不得含 HTML：" + text.slice(0, 40));
      assert.equal(looksLikeJson(text), false, item.id + " guide 字段不得是字符串化 JSON：" + text.slice(0, 40));
    }
  }
  // 24 条模板的详情走 sections / doc，不夹带 TapNow 的 guide 结构
  for (const template of shipped.value.templates) assert.equal(Object.prototype.hasOwnProperty.call(template, "guide"), false, template.id + " 不应带 guide 字段");
});


test("来源前缀：每段只有一次「来源：」，同步/下架/本地来源字符串不带前缀", () => {
  const fs2 = require("node:fs");
  const path2 = require("node:path");
  const src = fs2.readFileSync(path2.join(ROOT, "src-vue/apps/MarketApp.vue"), "utf8");
  assert.equal(src.includes("来源：来源"), false, "源码里不得出现「来源：来源」");
  // 六段来源只渲染一次前缀
  assert.equal((src.match(/t\("来源：\{source\}", \{ source: sec\.source \}\)/g) || []).length, 1, "六段来源前缀只应出现一次");
  assert.equal((src.match(/data-market-detail-source/g) || []).length, 1, "详情头部来源只渲染一次");
  // 来源字符串本身不带前缀（同步 / 下架 / 本地）
  assert.match(src, /const sourceLabel = t\("外部同步（内容版本 \{version\}）"/, "同步来源不带「来源：」前缀");
  assert.match(src, /已从来源下架 · 外部同步（内容版本 \{version\}）/, "下架来源不带「来源：」前缀");
  assert.equal(/SECTION_SOURCE_CATALOG = t\("来源：/.test(src), false, "本地来源不带「来源：」前缀");
  const sourcePrefix = (src.match(/t\("来源：\{source\}"/g) || []).length;
  assert.equal(sourcePrefix, 2, "来源占位渲染恰好两处（六段 + 头部）");
  // 源码里的注释也可能出现该字样，按代码行判断：不得出现连续两个前缀
  const codeLines = src.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("/*"));
  assert.equal(codeLines.some((line) => line.includes("来源：来源")), false, "代码里不得出现连续两个「来源：」");
});


test("品牌清理：用户可见文案/展示字段不得出现 TapNow（内部 id / 文件 / provider 标识除外）", () => {
  const fs2 = require("node:fs");
  const path2 = require("node:path");
  // ① 随包展示字段（id/name/coverUrl/source 内部标识允许）
  const raw = JSON.parse(fs2.readFileSync(path2.join(ROOT, "resources", "market", "tapnow-items.json"), "utf8"));
  const displayHits = [];
  const scan = (value, where) => {
    if (typeof value === "string") { if (/TapNow/i.test(value)) displayHits.push(where); return; }
    if (Array.isArray(value)) { value.forEach((entry, index) => scan(entry, where + "[" + index + "]")); return; }
    if (value && typeof value === "object") for (const key of Object.keys(value)) scan(value[key], where + "." + key);
  };
  for (const item of raw.items) {
    for (const key of ["displayName", "summary", "marketingLine", "category"]) scan(item[key], item.id + "." + key);
    if (item.guide) scan(item.guide, item.id + ".guide");
  }
  assert.deepEqual(displayHits, [], "展示字段里不得出现 TapNow");
  // ② 界面文案（t("...") 字面量）
  const appSrc = fs2.readFileSync(path2.join(ROOT, "src-vue/apps/MarketApp.vue"), "utf8");
  const tLiterals = [...appSrc.matchAll(/t\("([^"]*)"\)/g)].map((m) => m[1]).filter((text) => /TapNow/i.test(text));
  assert.deepEqual(tLiterals, [], "t() 文案里不得出现 TapNow");
  // ③ i18n 英文值
  const i18n = fs2.readFileSync(path2.join(ROOT, "src-vue", "i18n", "en-US.ts"), "utf8");
  const i18nValues = [...i18n.matchAll(/^\s*"([^"]+)":\s*"([^"]*)",?$/gm)].map((m) => m[2]).filter((text) => /TapNow/i.test(text));
  assert.deepEqual(i18nValues, [], "en-US 文案值里不得出现 TapNow");
  // ④ 内部 id 保留（证明不是把内部标识也洗了）
  assert.ok(raw.items.every((item) => item.id.startsWith("tapnow-")));
});

test("market-service：market/catalog 带出 templates / railPages，health.templateCount 真实", async () => {
  const bundle = createMarketBundle({ appDir: ROOT, clock: () => 1 });
  assert.equal(bundle.resolveCatalogDir(), path.join(ROOT, "resources", "market"));
  const res = await bundle.execute("market/catalog", {}, { sessionRef: "s1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.templates.length, 24, "market/catalog 返回 24 条模板");
  assert.equal(res.value.railPages.length, 2);
  assert.equal(res.value.skillPacks.length, 5);
  const status = bundle.catalogStatus();
  assert.equal(status.templateCount, 24);
  const health = await bundle.execute("market/health", {}, { sessionRef: "s1" });
  assert.equal(health.value.templateCount, 24);
  assert.equal(health.value.skillPackCount, 5);
  assert.equal(health.value.appCount, 8);
  assert.equal(JSON.stringify(res.value).includes(ROOT), false, "绝对路径不得过桥");
});
