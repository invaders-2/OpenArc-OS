/**
 * B7c · 本地市场目录测试（全离线：只读本地 catalog.json，不联网、不下载）。
 *
 * 覆盖任务书验收点：
 *   ① 从随包 / 本地目录读取清单，列出可用 App 与技能包；
 *   ② 非法清单拒绝（结构非法 / version 不对 / 条目全非法）；
 *   ③ 目录或清单缺失 → MARKET_CATALOG_MISSING；
 *   ④ 绝对路径不过桥（payload 里没有 <userData>/... 绝对路径）、技能包入口拒绝目录穿越；
 *   ⑤ 命令白名单 + 未认证拒绝；
 *   ⑥ 源码级：market 域不含 api.dx-os.com / fetch / http（云发布、审核、灰度一律 OUT）。
 *
 * 只读源：electron/market-domain.cjs（server/marketplace.ts:1-335 的本地部分）、
 *         electron/market-service.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createMarketBundle } = require("../electron/market-service.cjs");
const marketDomain = require("../electron/market-domain.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-market-")); tmpDirs.push(dir); return dir; }

const VALID_CATALOG = {
  version: 1,
  generatedAt: 1_700_000_000_000,
  page: { id: "local", title: "本地市场" },
  apps: [
    {
      id: "com.example.editor", name: "示例编辑器", version: "1.2.3", build: 7, category: "software",
      subtitle: "轻量编辑器", summary: "本地打包的示例应用", tags: ["写作", "离线"], featured: true,
      packageSize: 1024, publishedAt: 1_600_000_000_000,
    },
    { id: "bad id!", name: "非法 ID", version: "1.0.0", build: 1 },
  ],
  skillPacks: [
    { id: "pack.docs", name: "文档技能包", version: "0.3.0", description: "离线文档技能", tags: ["docs"], packageSize: 2048, entry: "skills/docs" },
    { id: "pack.evil", name: "越权技能包", version: "0.1.0", entry: "../../etc/passwd" },
  ],
};

function writeCatalog(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "catalog.json"), typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  return dir;
}

// ── ① 读取与列举 ──────────────────────────────────────────────────────────
test("本地清单：读取 catalog.json，列出有效 App 与技能包，非法条目被丢弃并计数", async () => {
  const dir = writeCatalog(tempDir(), VALID_CATALOG);
  const bundle = createMarketBundle({ marketDir: dir, clock: () => 1 });
  const res = await bundle.execute("market/catalog", {}, { sessionRef: "s1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.source, "local");
  assert.equal(res.value.apps.length, 1);
  assert.equal(res.value.apps[0].id, "com.example.editor");
  assert.equal(res.value.apps[0].featured, true);
  assert.deepEqual(res.value.rejected, { apps: 1, skillPacks: 0 });
  assert.equal(res.value.skillPacks.length, 2);
  const docs = res.value.skillPacks.find((item) => item.id === "pack.docs");
  assert.equal(docs.entry, "skills/docs");
  const evil = res.value.skillPacks.find((item) => item.id === "pack.evil");
  assert.equal(evil.entry, undefined, "目录穿越入口必须被丢弃，但条目本身仍可列出");
  assert.ok(res.value.categories.some((item) => item.id === "software"), "没有 categories 时要有 software/games 兜底");
  assert.equal(JSON.stringify(res.value).includes(dir), false, "绝对路径不得过桥");

  const apps = await bundle.execute("market/apps/list", {}, { sessionRef: "s1" });
  assert.deepEqual(apps.value.items.map((item) => item.id), ["com.example.editor"]);
  assert.equal(apps.value.rejected, 1);
  const packs = await bundle.execute("market/skillpacks/list", {}, { sessionRef: "s1" });
  assert.equal(packs.value.total, 2);

  const one = await bundle.execute("market/apps/get", { id: "com.example.editor" }, { sessionRef: "s1" });
  assert.equal(one.value.name, "示例编辑器");
  const pack = await bundle.execute("market/skillpacks/get", { id: "pack.docs" }, { sessionRef: "s1" });
  assert.equal(pack.value.version, "0.3.0");
});

// ── ② 非法清单拒绝 ────────────────────────────────────────────────────────
test("非法清单：结构非法 / version 不对 / apps 全部非法 → MARKET_MANIFEST_INVALID", async () => {
  assert.equal(marketDomain.normalizeLocalManifest(null).error.code, "MARKET_MANIFEST_INVALID");
  assert.equal(marketDomain.normalizeLocalManifest([]).error.code, "MARKET_MANIFEST_INVALID");
  assert.equal(marketDomain.normalizeLocalManifest({ version: 2, apps: [] }).error.code, "MARKET_MANIFEST_INVALID");
  assert.equal(marketDomain.normalizeLocalManifest({ version: 1 }).error.code, "MARKET_MANIFEST_INVALID");
  assert.equal(marketDomain.normalizeLocalManifest({ version: 1, apps: "nope" }).error.code, "MARKET_MANIFEST_INVALID");
  assert.equal(marketDomain.normalizeLocalManifest({ version: 1, skillPacks: {} }).error.code, "MARKET_MANIFEST_INVALID");
  const allBad = marketDomain.normalizeLocalManifest({ version: 1, apps: [{ id: "中文", name: "", version: "", build: 0 }] });
  assert.equal(allBad.ok, false);
  assert.equal(allBad.error.code, "MARKET_MANIFEST_INVALID");
});

test("非法清单：坏 JSON 与坏结构经 IPC 一律 MARKET_MANIFEST_INVALID", async () => {
  const bad = writeCatalog(tempDir(), "{ not json ");
  const bundle = createMarketBundle({ marketDir: bad });
  const res = await bundle.execute("market/catalog", {}, { sessionRef: "s1" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "MARKET_MANIFEST_INVALID");

  const wrongVersion = writeCatalog(tempDir(), { version: 9, apps: [] });
  const res2 = await createMarketBundle({ marketDir: wrongVersion }).execute("market/catalog", {}, { sessionRef: "s1" });
  assert.equal(res2.error, "MARKET_MANIFEST_INVALID");
});

// ── ③ 目录 / 清单缺失 ─────────────────────────────────────────────────────
test("缺失：没有目录或没有 catalog.json → MARKET_CATALOG_MISSING，健康报告如实 present:false", async () => {
  const bundle = createMarketBundle({ marketDir: path.join(tempDir(), "nope") });
  const res = await bundle.execute("market/catalog", {}, { sessionRef: "s1" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "MARKET_CATALOG_MISSING");

  const health = await bundle.execute("market/health", {}, { sessionRef: "s1" });
  assert.equal(health.ok, true);
  assert.equal(health.value.present, false);
  assert.equal(health.value.valid, false);
  assert.equal(health.value.appCount, 0);
});

// ── ④ 目录优先级 ──────────────────────────────────────────────────────────
test("目录优先级：显式 marketDir > 随包 resources/market > <userData>/dxos/market", () => {
  const userData = tempDir();
  const appDir = tempDir();
  const explicit = writeCatalog(tempDir(), VALID_CATALOG);
  writeCatalog(path.join(userData, "dxos", "market"), { version: 1, apps: [] });
  writeCatalog(path.join(appDir, "resources", "market"), { version: 1, apps: [] });

  assert.equal(createMarketBundle({ marketDir: explicit, appDir, userDataDir: userData }).resolveCatalogDir(), explicit);
  assert.equal(createMarketBundle({ appDir, userDataDir: userData }).resolveCatalogDir(), path.join(appDir, "resources", "market"));
  assert.equal(createMarketBundle({ userDataDir: userData }).resolveCatalogDir(), path.join(userData, "dxos", "market"));
});

// ── ⑤ 白名单 / 未认证 / 未找到 ────────────────────────────────────────────
test("命令面：未认证拒绝、未白名单命令拒绝、未知 App 与非法 ID 结构化失败", async () => {
  const dir = writeCatalog(tempDir(), VALID_CATALOG);
  const bundle = createMarketBundle({ marketDir: dir });
  const unauth = await bundle.execute("market/catalog", {}, {});
  assert.equal(unauth.error, "MARKET_UNAUTHENTICATED");
  const denied = await bundle.execute("market/nope", {}, { sessionRef: "s1" });
  assert.equal(denied.error, "MARKET_COMMAND_NOT_ALLOWED");
  const missing = await bundle.execute("market/apps/get", { id: "com.absent" }, { sessionRef: "s1" });
  assert.equal(missing.error, "MARKET_NOT_FOUND");
  const badId = await bundle.execute("market/apps/get", { id: "中文 id" }, { sessionRef: "s1" });
  assert.equal(badId.error, "MARKET_INVALID_INPUT");
  assert.equal(marketDomain.isMarketCommand("market/catalog"), true);
  assert.equal(marketDomain.isMarketCommand("market/install"), false);
});

// ── ⑥ 源码级：没有云市场 ──────────────────────────────────────────────────
// ── ⑦ B7f：随包清单是"有效但空"的状态 ────────────────────────────────────
test("随包清单：resources/market/catalog.json 有效且为空，不是 MARKET_CATALOG_MISSING", async () => {
  const bundle = createMarketBundle({ appDir: ROOT });
  assert.equal(bundle.resolveCatalogDir(), path.join(ROOT, "resources", "market"), "必须优先读随包目录");
  const status = bundle.catalogStatus();
  assert.equal(status.present, true);
  assert.equal(status.valid, true);
  assert.equal(status.appCount, 0);
  assert.equal(status.skillPackCount, 0);
  assert.equal(status.reason, null);

  const res = await bundle.execute("market/catalog", {}, { sessionRef: "s1" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.value.apps, [], "不许编造示例 App");
  assert.deepEqual(res.value.skillPacks, []);

  const health = await bundle.execute("market/health", {}, { sessionRef: "s1" });
  assert.equal(health.ok, true);
  assert.equal(health.value.present, true);
  assert.equal(health.value.valid, true);

  const file = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "market", "catalog.json"), "utf8"));
  assert.equal(file.version, 1, "必须声明 schema 版本");
  assert.equal(Array.isArray(file.apps) && file.apps.length, 0);
  assert.equal(Array.isArray(file.skillPacks) && file.skillPacks.length, 0);
  assert.ok(file.fields && typeof file.fields === "object" && Object.keys(file.fields).length > 0, "必须有字段说明");
  assert.ok(fs.existsSync(path.join(ROOT, "resources", "market", "README.md")), "必须有投放说明");
});

test("源码级：本地市场域不含 api.dx-os.com / fetch / http（云发布·审核·灰度 OUT）", () => {
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const file of ["market-domain.cjs", "market-service.cjs"]) {
    const code = stripComments(fs.readFileSync(new URL("../electron/" + file, import.meta.url), "utf8"));
    assert.equal(/api\.dx-os\.com/.test(code), false, file + " 不得出现 api.dx-os.com");
    assert.equal(/\bfetch\s*\(/.test(code), false, file + " 不得发起网络请求");
    assert.equal(/require\(["']node:https?["']\)/.test(code), false, file + " 不得引入 http 客户端");
  }
});
