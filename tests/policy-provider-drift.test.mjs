/**
 * D5-03 第四批 · BASELINE_POLICY_PROVIDERS 防漂移守卫。
 *
 * 表（electron/identity-store.cjs 的 BASELINE_POLICY_PROVIDERS）是**产品事实**，不是测试数据：
 * revokeTombstoneTargets 靠它决定给哪些 App 补撤销墓碑。表与实际提供点漂移的后果是
 * "撤销判错 App / 撤销被下一次播种复活"，所以用两道守卫把它钉住，两道都不允许"静默放过"：
 *
 *   ① 行为级（主）T1/T2：走真实装配路径 createIdentityService（先建库 → 注册管理员 → 登录 →
 *      真实资源操作）触发全部内置策略播种，断言实际产生的 (appId, policyKey) 集合与表**逐项相等**
 *      ——多一个、少一个都 FAIL；反向再对"全部 App Principal × 全部策略键"穷举，断言表里没写的
 *      一个记录都不许有。
 *   ② 源码级（兜底）T3/T4：扫描 electron/**，凡是引用政策提供记录（policyProvisionByKey）的文件
 *      都必须在守卫里登记；未登记的文件、登记文件里出现表外 appId / 表外 policyKey、锚点消失或
 *      文件读不到，一律 FAIL（fail-closed）。
 *
 * 负向自证 T5/T6：把漂移注入**内存里的源码副本**，守卫必须报错（不碰产品文件）。
 *
 * 临时目录前缀刻意用 oa-d503d-drift-，与 mcp-policy-e2e.mjs 的 oa-d503b- 命名空间分开，
 * 免得被那个脚本的 orphan 清理误当成自己的产物。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_ELECTRON = path.join(ROOT, "electron");
/**
 * 只影响"源码扫描读哪个目录"的负向验证开关：把 electron/ 复制到别处、注入漂移再跑本文件。
 * 行为级断言始终 require 仓库里的真实 electron/ 模块，且锚点文件缺失时扫描直接 FAIL，
 * 所以指到别处只会让守卫更严，不会让守卫变松。
 */
const ELECTRON_ROOT = process.env.OA_POLICY_DRIFT_ELECTRON_ROOT ? path.resolve(process.env.OA_POLICY_DRIFT_ELECTRON_ROOT) : REAL_ELECTRON;

const { createIdentityService } = require(path.join(REAL_ELECTRON, "identity-bootstrap.cjs"));
const { APP_POLICY_KEYS } = require(path.join(REAL_ELECTRON, "identity-store.cjs"));

const TEMP_PREFIX = "oa-d503d-drift-";
const ADMIN = { id: "admin@d503d-drift.test", pw: "drift-password-1" };
const TEMP_DIRS = [];
test.after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ══════════════════════ 源码扫描（fail-closed） ══════════════════════ */

/** 必须存在的锚点文件：少了任何一个都说明扫描的不是产品代码，直接 FAIL。 */
const ANCHOR_FILES = Object.freeze(["identity-store.cjs", "authorization-store.cjs", "resource-service.cjs", "model-bootstrap.cjs", "mcp-bootstrap.cjs"]);
const MIN_SOURCE_FILES = 20;

function listElectronSources(root = ELECTRON_ROOT) {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? prefix + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) files.set(rel, fs.readFileSync(abs, "utf8"));
    }
  };
  walk(root, "");
  if (files.size < MIN_SOURCE_FILES) throw new Error("electron 源码枚举异常：只读到 " + files.size + " 个文件（守卫 fail-closed）：" + root);
  for (const name of ANCHOR_FILES) if (!files.has(name)) throw new Error("缺少锚点文件 " + name + "（守卫 fail-closed）：" + root);
  return files;
}

/** 严格解析 BASELINE_POLICY_PROVIDERS 字面量；任何一行解析不了都 FAIL（不许退化成"空表"）。 */
function declaredTable(sources) {
  const rel = "identity-store.cjs";
  const src = sources.get(rel);
  if (typeof src !== "string") throw new Error("读不到 " + rel + "（守卫 fail-closed）");
  const anchor = "const BASELINE_POLICY_PROVIDERS = Object.freeze({";
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error("找不到 BASELINE_POLICY_PROVIDERS 声明锚点（守卫 fail-closed，源码结构变了？）");
  const end = src.indexOf("});", start + anchor.length);
  if (end < 0) throw new Error("BASELINE_POLICY_PROVIDERS 字面量未闭合（守卫 fail-closed）");
  const table = Object.create(null);
  for (const raw of src.slice(start + anchor.length, end).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*Object\.freeze\(\[(.*)\]\),?$/.exec(line);
    if (!m) throw new Error("BASELINE_POLICY_PROVIDERS 出现无法解析的行（守卫 fail-closed）：" + JSON.stringify(line));
    if (m[1] in table) throw new Error("BASELINE_POLICY_PROVIDERS 出现重复键 " + m[1] + "（守卫 fail-closed）");
    const body = m[2].trim();
    const items = body === "" ? [] : body.split(",").map((s) => s.trim());
    for (const item of items) {
      if (!/^"[A-Za-z0-9._-]+"$/.test(item)) throw new Error("BASELINE_POLICY_PROVIDERS." + m[1] + " 出现无法解析的 appId 元素（守卫 fail-closed）：" + JSON.stringify(item));
    }
    table[m[1]] = items.map((s) => s.slice(1, -1));
  }
  const declaredKeys = Object.keys(table).sort();
  const productKeys = [...APP_POLICY_KEYS].sort();
  if (JSON.stringify(declaredKeys) !== JSON.stringify(productKeys)) {
    throw new Error("表声明的策略族 " + JSON.stringify(declaredKeys) + " 与产品 APP_POLICY_KEYS " + JSON.stringify(productKeys) + " 不一致（守卫 fail-closed）");
  }
  return table;
}

const declaredPairs = (table) => {
  const pairs = [];
  for (const [policyKey, appIds] of Object.entries(table)) for (const appId of appIds) pairs.push(appId + "|" + policyKey);
  return [...new Set(pairs)].sort();
};

const RE_SPECIALS = new Set(Array.from("\\^$.*+?()[]{}|"));
const escapeRe = (s) => Array.from(String(s)).map((ch) => (RE_SPECIALS.has(ch) ? "\\" + ch : ch)).join("");

/** 字面量或同文件里的 const 字符串；解析不出来就 FAIL。 */
function resolveAppIdExpression(src, expr, rel) {
  const token = expr.trim();
  const literal = /^"([A-Za-z0-9._-]+)"$/.exec(token);
  if (literal) return literal[1];
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token)) throw new Error(rel + " 里播种用的 appId 表达式无法静态解析（守卫 fail-closed）：" + JSON.stringify(token));
  const m = new RegExp("const\\s+" + escapeRe(token) + "\\s*=\\s*\"([A-Za-z0-9._-]+)\"").exec(src);
  if (!m) throw new Error(rel + " 里找不到常量 " + token + " 的字符串取值（守卫 fail-closed）");
  return m[1];
}

/** resource 族提供者 = resource-service.cjs BUILTIN_APP_BASELINE 的键。 */
function extractResourceProviders(sources) {
  const rel = "resource-service.cjs";
  const src = sources.get(rel);
  const anchor = "const BUILTIN_APP_BASELINE = Object.freeze({";
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error("找不到 " + rel + " 的 BUILTIN_APP_BASELINE 锚点（守卫 fail-closed）");
  const end = src.indexOf("});", start + anchor.length);
  if (end < 0) throw new Error("BUILTIN_APP_BASELINE 字面量未闭合（守卫 fail-closed）");
  const appIds = [];
  for (const raw of src.slice(start + anchor.length, end).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:"([A-Za-z0-9._-]+)"|([A-Za-z_$][A-Za-z0-9_$]*)):\s*\{/.exec(line);
    if (!m) throw new Error("BUILTIN_APP_BASELINE 出现无法解析的行（守卫 fail-closed）：" + JSON.stringify(line));
    appIds.push(m[1] || m[2]);
  }
  if (!appIds.length) throw new Error("BUILTIN_APP_BASELINE 解析出 0 个 App（守卫 fail-closed）");
  return appIds;
}

/** model 族提供者 = model-bootstrap.cjs 里 seed(<appId>, …) 的调用点。 */
function extractModelProviders(sources) {
  const rel = "model-bootstrap.cjs";
  const src = sources.get(rel);
  const appIds = [];
  const re = /\bseed\(\s*([^,]+?)\s*,/g;
  let m;
  while ((m = re.exec(src))) appIds.push(resolveAppIdExpression(src, m[1], rel));
  if (!appIds.length) throw new Error(rel + " 里找不到 seed(<appId>, …) 播种调用点（守卫 fail-closed）");
  return appIds;
}

/** mcp 族提供者 = mcp-bootstrap.cjs 播种入口里政策门禁与 upsertAppGrant 同一个 appId 表达式。 */
function extractMcpProviders(sources) {
  const rel = "mcp-bootstrap.cjs";
  const src = sources.get(rel);
  const gate = /policyProvisionByKey\(\{\s*organizationId,\s*appId:\s*([^,]+?),\s*policyKey:\s*"mcp"\s*\}\)/.exec(src);
  if (!gate) throw new Error(rel + " 里找不到 mcp 族的政策门禁调用（守卫 fail-closed）");
  const expr = gate[1].trim();
  if (!new RegExp("upsertAppGrant\\(\\{\\s*appId:\\s*" + escapeRe(expr) + "\\s*,").test(src)) {
    throw new Error(rel + " 的政策门禁 appId 与 upsertAppGrant 的 appId 不是同一个表达式（守卫 fail-closed）：" + JSON.stringify(expr));
  }
  return [resolveAppIdExpression(src, expr, rel)];
}

/** 已登记的政策播种点。新播种点必须在这里登记，否则 T3 FAIL。 */
const REGISTERED_SEEDING_SITES = Object.freeze({
  "resource-service.cjs": { policyKey: "resource", extract: extractResourceProviders },
  "model-bootstrap.cjs": { policyKey: "model", extract: extractModelProviders },
  "mcp-bootstrap.cjs": { policyKey: "mcp", extract: extractMcpProviders },
});
/** 政策提供记录 SQL / 读写入口的拥有者：它定义规则，本身不是播种点。 */
const PROVISION_GATE_OWNER = "authorization-store.cjs";

/** 扫描全部播种点；未登记的文件、登记文件里不一致的 policyKey 都 FAIL。 */
function collectSeedingSites(sources) {
  const gated = new Map();
  const gateRe = /policyProvisionByKey\s*\(/;
  const keyRe = /policyKey:\s*"([^"]*)"/g;
  for (const [rel, src] of sources) {
    if (!gateRe.test(src)) continue;
    const keys = new Set();
    let m;
    keyRe.lastIndex = 0;
    while ((m = keyRe.exec(src))) keys.add(m[1]);
    gated.set(rel, keys);
  }
  for (const rel of gated.keys()) {
    if (rel === PROVISION_GATE_OWNER) continue;
    if (!REGISTERED_SEEDING_SITES[rel]) {
      throw new Error("发现未登记的政策播种点（引用了 policyProvisionByKey 却没在本守卫登记）：" + rel + "；请把它的 (appId, policyKey) 写进 BASELINE_POLICY_PROVIDERS 并在此登记提取器");
    }
  }
  for (const rel of Object.keys(REGISTERED_SEEDING_SITES)) {
    if (!gated.has(rel)) throw new Error("登记的播种点 " + rel + " 不再引用 policyProvisionByKey（播种点被移走/删除？守卫 fail-closed）");
    const keys = [...gated.get(rel)].sort();
    const expected = REGISTERED_SEEDING_SITES[rel].policyKey;
    if (keys.length !== 1 || keys[0] !== expected) {
      throw new Error(rel + " 的政策键为 " + JSON.stringify(keys) + "，与本守卫登记的 " + JSON.stringify([expected]) + " 不一致（守卫 fail-closed）");
    }
  }
  return gated;
}

/** 源码级给出的 (appId, policyKey) 全集。 */
function sourcePairs(sources) {
  collectSeedingSites(sources);
  const pairs = [];
  for (const [rel, spec] of Object.entries(REGISTERED_SEEDING_SITES)) {
    for (const appId of spec.extract(sources)) pairs.push(appId + "|" + spec.policyKey);
  }
  return [...new Set(pairs)].sort();
}

function comparePairs(observed, declared, label) {
  const a = new Set(observed);
  const b = new Set(declared);
  const missing = [...b].filter((x) => !a.has(x)).sort();
  const extra = [...a].filter((x) => !b.has(x)).sort();
  if (missing.length || extra.length) {
    throw new Error(label + " 与表漂移：表里声明但实际没有 " + JSON.stringify(missing) + "；实际有但表里没写 " + JSON.stringify(extra));
  }
}

const SOURCES = (() => {
  let cached = null;
  return () => (cached = cached || listElectronSources());
})();

/* ══════════════════════ 行为级探针（真实装配路径） ══════════════════════ */

async function observeSeededProvisions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  TEMP_DIRS.push(dir);
  const app = createIdentityService({ userDataDir: dir, safeStorage: null, allowAdmin: true, serviceIdentity: "svc_d503d_drift" });
  try {
    const init = await app.service.dispatch({ type: "identity/initialize", identifier: ADMIN.id, password: ADMIN.pw, displayName: "Drift Admin" });
    assert.equal(init.ok, true, "identity/initialize 必须成功：" + JSON.stringify(init));
    const login = await app.service.dispatch({ type: "identity/login", identifier: ADMIN.id, password: ADMIN.pw });
    assert.equal(login.ok, true, "identity/login 必须成功：" + JSON.stringify(login));
    const orgId = login.snapshot.teamId;
    assert.equal(typeof orgId, "string", "登录快照必须带组织：" + JSON.stringify(login.snapshot));
    const afterLogin = app.authStore.allPolicyProvisions().filter((r) => r.organization_id === orgId);

    const created = await app.resourceService.createResource({
      context: { sessionRef: login.snapshot.sessionRef, appId: "resource-library", source: "ui" },
      resourceType: "text",
      name: "PolicyDriftProbe",
      content: "drift",
    });
    assert.equal(created.ok, true, "资源操作必须成功（resource baseline 的播种触发器）：" + JSON.stringify(created));

    const rows = app.authStore.allPolicyProvisions().filter((r) => r.organization_id === orgId);
    const matrix = [];
    for (const principal of app.authStore.allApps()) {
      for (const policyKey of APP_POLICY_KEYS) {
        const record = app.authStore.policyProvisionByKey({ organizationId: orgId, appId: principal.app_id, policyKey });
        matrix.push({ appId: principal.app_id, policyKey, present: !!record, revokedAt: record ? record.revoked_at : null });
      }
    }
    return {
      orgId,
      afterLoginPairs: afterLogin.map((r) => r.app_id + "|" + r.policy_key).sort(),
      pairs: rows.map((r) => r.app_id + "|" + r.policy_key).sort(),
      appIds: app.authStore.allApps().map((a) => a.app_id).sort(),
      matrix,
    };
  } finally {
    app.store.close();
  }
}

const OBSERVED = (() => {
  let cached = null;
  return () => (cached = cached || observeSeededProvisions());
})();

/* ══════════════════════ ① 行为级 ══════════════════════ */

test("T1 · 行为级：真实装配播种出的 (appId, policyKey) 集合 == BASELINE_POLICY_PROVIDERS", async () => {
  const table = declaredTable(SOURCES());
  const observed = await OBSERVED();
  const declared = declaredPairs(table);
  assert.equal(declared.length > 0, true, "表不能是空的：" + JSON.stringify(table));
  comparePairs(observed.pairs, declared, "行为级播种集合");
  assert.equal(observed.pairs.length > 0, true, "播种必须真的发生过");
  const declaredFamiliesWithProviders = Object.entries(table).filter(([, appIds]) => appIds.length > 0).map(([policyKey]) => policyKey).sort();
  assert.equal(declaredFamiliesWithProviders.length > 0, true, "至少要有一族声明了提供者");
  assert.deepEqual([...new Set(observed.pairs.map((p) => p.split("|")[1]))].sort(), declaredFamiliesWithProviders, "声明了提供者的策略族必须真的有落点（tool 族声明为空，就不该有落点）");
});

test("T2 · 行为级反向：全部 App Principal × 全部策略键穷举，表里没写的一个记录都不许有", async () => {
  const table = declaredTable(SOURCES());
  const observed = await OBSERVED();
  const declared = new Set(declaredPairs(table));
  assert.equal(observed.matrix.length > 0, true, "App Principal 矩阵不能为空");
  assert.equal(observed.appIds.length > 0, true, "内置 App Principal 必须已播种");
  const offenders = observed.matrix
    .filter((cell) => cell.present !== declared.has(cell.appId + "|" + cell.policyKey))
    .map((cell) => cell.appId + "|" + cell.policyKey + " present=" + cell.present + " declared=" + declared.has(cell.appId + "|" + cell.policyKey));
  assert.deepEqual(offenders, [], "存在表外的政策提供记录（或表内记录缺失）：" + JSON.stringify(offenders));
  for (const cell of observed.matrix.filter((c) => !declared.has(c.appId + "|" + c.policyKey))) {
    assert.equal(cell.present, false, cell.appId + " 不是 " + cell.policyKey + " 族的提供点，不得有提供记录");
    assert.equal(cell.revokedAt, null, cell.appId + " 不得有该族撤销墓碑");
  }
  assert.equal(observed.afterLoginPairs.length > 0, true, "登录路径必须已经播种（否则资源操作前的状态没被观察到）");
});

/* ══════════════════════ ② 源码级兜底 ══════════════════════ */

test("T3 · 源码级：electron/** 的政策播种点全集 == 登记集（未登记文件 FAIL）", () => {
  const gated = collectSeedingSites(SOURCES());
  assert.deepEqual([...gated.keys()].sort(), [...Object.keys(REGISTERED_SEEDING_SITES), PROVISION_GATE_OWNER].sort());
});

test("T4 · 源码级：从播种点提取的提供者集合 == 表（表外 appId / 表外 policyKey 都 FAIL）", () => {
  const table = declaredTable(SOURCES());
  comparePairs(sourcePairs(SOURCES()), declaredPairs(table), "源码级提供者集合");
});

/* ══════════════════════ ③ 负向自证（内存注入，不碰产品文件） ══════════════════════ */

test("T5 · 负向自证：把漂移注入内存副本，守卫必须 FAIL（表外 appId / 表外提供点）", async () => {
  const table = declaredTable(SOURCES());
  const declared = declaredPairs(table);
  const observed = await OBSERVED();

  comparePairs(sourcePairs(SOURCES()), declared, "注入前源码级");
  comparePairs(observed.pairs, declared, "注入前行为级");

  const injected = new Map(SOURCES());
  const resourceSrc = injected.get("resource-service.cjs");
  injected.set("resource-service.cjs", resourceSrc.replace('  "skill-runtime": {', '  "rogue-app": { actions: [] },\n  "skill-runtime": {'));
  assert.notEqual(injected.get("resource-service.cjs"), resourceSrc, "注入锚点未命中，负向验证无效");
  assert.throws(() => comparePairs(sourcePairs(injected), declared, "注入后源码级"), /rogue-app/, "注入表外 appId 后源码级守卫必须 FAIL");

  const injectedModel = new Map(SOURCES());
  injectedModel.set("model-bootstrap.cjs", injectedModel.get("model-bootstrap.cjs").replace('seed("canvas",', 'seed("rogue-app", ["model.view"]),\n        seed("canvas",'));
  assert.throws(() => comparePairs(sourcePairs(injectedModel), declared, "注入后源码级"), /rogue-app/, "注入表外 model 提供点后源码级守卫必须 FAIL");

  const inflated = { ...table, resource: [...table.resource, "rogue-app"] };
  assert.throws(() => comparePairs(observed.pairs, declaredPairs(inflated), "注入后行为级"), /rogue-app/, "表里多写一个提供点后行为级守卫必须 FAIL");
});

test("T6 · 负向自证：新增未登记的播种点 / 锚点消失，一律 fail-closed", () => {
  const withNewSeeder = new Map(SOURCES());
  withNewSeeder.set("rogue-bootstrap.cjs", 'const x = authStore.policyProvisionByKey({ organizationId, appId: "rogue-app", policyKey: "mcp" });\n');
  assert.throws(() => collectSeedingSites(withNewSeeder), /未登记/, "新增未登记播种点必须 FAIL");

  const withoutGate = new Map(SOURCES());
  withoutGate.set("mcp-bootstrap.cjs", withoutGate.get("mcp-bootstrap.cjs").replace(/policyProvisionByKey/g, "policyProvisionByKeyRenamed"));
  assert.throws(() => collectSeedingSites(withoutGate), /不再引用 policyProvisionByKey/, "登记的播种点消失必须 FAIL");

  const brokenLiteral = new Map(SOURCES());
  brokenLiteral.set("resource-service.cjs", SOURCES().get("resource-service.cjs").replace("BUILTIN_APP_BASELINE = Object.freeze({", "BUILTIN_APP_BASELINE = Object.freeze(Object.assign({}, {"));
  assert.throws(() => sourcePairs(brokenLiteral), /找不到 .*BUILTIN_APP_BASELINE 锚点/, "锚点消失必须 FAIL");

  const noTable = new Map(SOURCES());
  noTable.delete("identity-store.cjs");
  assert.throws(() => declaredTable(noTable), /读不到 identity-store.cjs/, "读不到表声明必须 FAIL");
});
