/**
 * D5-03 第五批 · 安装重置（identity/reset-installation）后的授权数据一致性（测试即合同）。
 *
 * 背景：`resetInstallation` 原本只删身份五表（sessions / login_attempts / users / teams /
 * installations），授权状态一行不动。真机与 node 都已复现：重置后 app_policy_provisions
 * 残留 15 行、app_resource_grants 残留 15 行，全部指向已从 teams 删除的组织。
 *
 * 本文件把"重置 = 授权状态也归零，且与身份删除同一个事务"立成可执行的合同：
 *
 *   T1 同事务回滚：授权清理语句注入失败 / 身份最后一条语句注入失败 → 逐表逐行与重置前一致；
 *   T2 清理范围与审计保留：授权事实四表 0 行（= 全部指向已删组织的行）；28 张带
 *      organization_id 的表逐表盘点；audit_log / authorization_audit / device_audit 一行不删；
 *   T3 组织 id 复用不被旧墓碑压制：同一个 id 上的 A/B 对照（重置前播种被墓碑挡 → 重置后正常播种）；
 *   T4 反向：正常路径（未重置）墓碑仍在、不被重播种覆盖、撤权不复活；
 *   T5 判据（第六批订正）：取数与判定都按 organization_id —— 指向不存在组织的 app grant 不再授权；
 *   T5b 产品后果：新组织撤销 canvas 必须真 DENY（把旧组织残留行种回去也不得让它复活）；
 *   T6 范围守卫：重置要删的表集合恰好是登记的七张（授权事实四张 + 设备身份事实三张），
 *      不含审计表 / 内容表，且每条语句都是无 WHERE 的整表删除；
 *   T7 判据（第七批订正）：重置后**旧设备事实不再能恢复身份或权限** —— 旧配对密钥被拒、
 *      旧凭据不能认证，devices / device_credentials / device_pairing_credentials 归零。
 *
 * 重置删除集合的唯一权威是 electron/identity-store.cjs 的 RESET_AUTHORIZATION_DELETE_SQL；
 * 本文件不另立一份"应该删什么"的名单，只核对它的范围与后果。
 *
 * 第七批变更披露（旧期望 → 新期望，逐字）：
 *   · 文件头旧结论「devices / device_credentials / device_pairing_credentials —— 设备与凭据登记（配置类），
 *     设备访问权威是 device_access（已清），凭据本身不构成资源/应用授权」→ 订正为「这三张是**能恢复
 *     设备身份**的事实，随重置同事务清空」。理由：凭据按 fingerprint 取数、配对密钥按 secret_hash 取数，
 *     两条路径都不比对组织，且 heartbeat 的 Device Gate 用 role:"ADMIN" 的合成 actor —— 旧凭据 + 旧
 *     devices 行在重置后仍能拿到连接与心跳放行（第五批 T7 只证明了"不产生授权结论"，没证明"不恢复身份"）。
 *   · T7 旧期望「残留的配对凭据确实还能登记设备（已登记的残留，本批不清）」→ 新期望「PAIRING_TOKEN_UNKNOWN，
 *     0 台新设备 / 0 条新凭据」。理由：那正是"重置后还能用旧密钥登记设备"的缺陷本身。
 *   · T6 旧期望「恰好四张授权表」→ 新期望「七张（四张授权 + 三张设备身份）」。
 *   · T2 旧期望「授权事实四表 0 行」→ 新期望「七张全 0 行」。
 *
 * 28 张带 organization_id 的表的逐表结论（判据都是可复核的取数路径，不是"应该没事"）：
 *
 *   清（授权事实，四张）：
 *     app_policy_provisions   策略提供记录 + 撤销墓碑。取数 policyProvisionByKey(organization_id,…)；
 *                             组织 id 复用时旧墓碑会压住首次播种（T3 实测）。
 *     app_resource_grants     App 侧 ACL。取数 appGrantsForApp(app_id, organization_id) 按组织过滤，
 *                             判定 evaluateAppAuthorization 也逐条跳过异组织 grant（D5-03 第六批；
 *                             第五批以前两处都不看组织，T5 实测孤儿行仍能授权）。
 *     resource_grants         User / Department ACL。取数 grantsForOrganizationContext(user.team_id)。
 *     device_access           设备 ACL。取数 accessOfDevice(device_id)，ORGANIZATION 分支不比对
 *                             organization_id（device-service.cjs #accessAllows）。
 *
 *   清（能恢复设备身份/权限的设备事实，第七批新增三张）：
 *     devices                  Registry 行 = authorizeDevice 的组织来源，也是下面两条的落点。
 *     device_credentials       取数 credentialByFingerprint(fingerprint)（device-store.cjs:51）——
 *                             不比对组织；命中后 authenticateConnection 放行，heartbeat 再走
 *                             合成 ADMIN actor 的 Device Gate，于是旧凭据在重置后仍能拿到连接。
 *     device_pairing_credentials  取数 pairingBySecretHash(sha256(secret))（device-store.cjs:39/:43）——
 *                             同样不比对组织；未消费的密钥 = 一张"再登记一台设备"的门票（第五批 T7 实测）。
 *
 *   不清（用户内容 / 配置 / 审计）：
 *     departments / department_memberships —— 组织架构，不是 grant 事实（无 actions/权限列）。
 *        DEPARTMENT 授权生效必须同时命中 membershipsOfUser(活用户 id)，而用户 id 是
 *        24 字节随机（authorization-domain.newId）；重置后没有任何活用户，判定不可达。
 *        （它们若被清，collections / resource_registry 的 department_id 会变成悬空引用 ——
 *         那才是新造的不一致，故不在本批范围。第七批起 devices 本身随重置清空，不再是举例对象。）
 *     collections / resource_registry / content_objects / library_resources / resource_* /
 *       tags / projects / canvas_boards —— 用户内容，用户明令禁止整库扫删。
 *     mcp_connections / mcp_credentials —— 连接配置与凭据引用；mcp 授权权威是
 *       app_resource_grants(resource_type='mcp')（已清），连接自身按 organization_id 取。
 *     model_providers / model_configs / model_defaults / model_credentials —— 模型配置与凭据。
 *     cloud_installation_binding  DX 云侧安装绑定登记（本轮新增）。含 organization_id，但该列**可空**
 *       （TEXT，无 NOT NULL），且 installation_id 外键指向 DX 自身的 installation_identity，**不是** OpenArc
 *       的 installations —— 重置既不动该父表，本表也不指向任何本地授权事实；cloud 域本轮默认关闭，
 *       本表不产生本地授权结论，因此**不纳入** reset 删除集合（T6 的"整表删"语义要求 organization_id
 *       NOT NULL，本表本就不满足该前提）。
 *     resource_favorites / resource_recent / resource_relations / resource_tags /
 *       resource_import_jobs 等 —— 用户态数据。
 *     device_audit —— 审计，一行不删。
 *
 * 临时目录前缀 oa-d503e-reset-，与 d503d-retention- / d503b- 命名空间分开。
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
const { createIdentityService } = require(path.join(ROOT, "electron", "identity-bootstrap.cjs"));
const { RESET_AUTHORIZATION_DELETE_SQL } = require(path.join(ROOT, "electron", "identity-store.cjs"));
const { createModelBundle } = require(path.join(ROOT, "electron", "model-bootstrap.cjs"));
const { createMcpBundle } = require(path.join(ROOT, "electron", "mcp-bootstrap.cjs"));

const CONFIRM = "DELETE-ALL-IDENTITY-DATA";
const ID = "admin@d503e-reset.test";
const PW = "reset-password-1";
const SERVICE_IDENTITY = "svc_d503e_reset";
const GHOST_ORG = "team_ghost00000000000000000000";

/**
 * 重置必须清空的表：授权事实四张 + 能恢复设备身份/权限的设备事实三张。
 * 与源码登记的删除语句一一对应（T6 核对）；唯一权威仍是 RESET_AUTHORIZATION_DELETE_SQL。
 */
const RESET_DELETED_TABLES = Object.freeze([
  "app_policy_provisions",
  "app_resource_grants",
  "resource_grants",
  "device_access",
  "device_credentials",
  "device_pairing_credentials",
  "devices",
]);
/** 审计表：一行都不许删。 */
const AUDIT_TABLES = Object.freeze(["audit_log", "authorization_audit", "device_audit"]);
/** 当前真实 schema 里带 organization_id 的表数量（逐表结论见文件头；cloud_installation_binding 已显式登记）。 */
const ORG_SCOPED_TABLE_COUNT = 28;

const TEMP_DIRS = [];
test.after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
const tmpDir = (prefix = "oa-d503e-reset-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
};
const openService = (userDataDir) => createIdentityService({ userDataDir, safeStorage: null, allowAdmin: true, serviceIdentity: SERVICE_IDENTITY });

/* ══════════════════════ 公共取值器 ══════════════════════ */

const count = (store, sql, ...params) => store.connection.prepare(sql).get(...params).c;
const tableCount = (store, table) => count(store, "SELECT COUNT(*) c FROM " + table);
const tableNames = (store) =>
  store.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const orgScopedTables = (store) =>
  tableNames(store).filter((t) => store.connection.prepare("PRAGMA table_info(" + t + ")").all().some((c) => c.name === "organization_id"));
const columnsOf = (store, table) => store.connection.prepare("PRAGMA table_info(" + table + ")").all();

/** 逐表逐行快照：临时库 68 张表都很小，直接全量对比（忽略 SQLite 内部表）。 */
function dumpTables(store) {
  const out = {};
  for (const table of tableNames(store)) {
    let rows;
    try { rows = store.connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all(); }
    catch { rows = store.connection.prepare("SELECT * FROM " + table).all(); }
    out[table] = rows.map((r) => JSON.stringify(r));
  }
  return out;
}

const pairList = (store, orgId) => store.allPolicyProvisions().filter((r) => r.organization_id === orgId).map((r) => r.app_id + "|" + r.policy_key).sort();
const provisionOf = (store, orgId, appId, policyKey) => store.policyProvisionByKey({ organizationId: orgId, appId, policyKey });
/** App grant 行的"组织无关形状"：同一安装的两次首次播种应当逐行同形（目标 id 全为空，不含随机 resource id）。 */
const grantShapes = (store, orgId) =>
  store.allAppGrants().filter((g) => g.organization_id === orgId)
    .map((g) => [g.app_id, g.resource_id, g.collection_id, g.resource_type, g.department_id, g.scope, String(g.actions)].join("|")).sort();
/** 某组织的 baseline 形状 grant（三个目标 id 全空 + 指定 resource_type）。 */
const baselineGrantOf = (store, orgId, appId, resourceType) =>
  store.appGrantsForApp(appId, orgId).find((g) => String(g.resource_type) === resourceType && !g.resource_id && !g.collection_id && !g.department_id && String(g.scope) === "") || null;

/** 重置后仍指向不存在组织的行 —— 目标二的"孤儿行"判据。 */
function orphanInventory(store) {
  const live = new Set(store.connection.prepare("SELECT id FROM teams").all().map((r) => r.id));
  return orgScopedTables(store).map((table) => {
    const rows = store.connection.prepare("SELECT organization_id FROM " + table).all();
    return { table, rows: rows.length, orphans: rows.filter((r) => !live.has(r.organization_id)).length };
  });
}

/**
 * 事务内失败注入（**测试侧**手段，产品代码没有任何后门）：
 * 只包住这一次 exec，命中指定语句即抛；其余语句照常执行。
 * transactSync 的语义是"体里抛错 → ROLLBACK 并原样上抛"，因此这等价于"某条语句失败"。
 */
function injectExecFailure(store, match, message = "INJECTED-FAILURE") {
  const db = store.connection;
  const real = db.exec.bind(db);
  let hits = 0;
  db.exec = (sql) => {
    if (String(sql).includes(match)) { hits += 1; throw new Error(message); }
    return real(sql);
  };
  return { hits: () => hits, restore: () => { delete db.exec; } };
}

/* ══════════════════════ 场景装配 ══════════════════════ */

const uiCtx = (snap, extra = {}) => ({ sessionRef: snap.sessionRef, appId: "resource-library", source: "ui", ...extra });

async function initAndLogin(f) {
  const init = await f.service.dispatch({ type: "identity/initialize", identifier: ID, password: PW, displayName: "Admin" });
  assert.equal(init.ok, true, "初始化必须成功：" + JSON.stringify(init));
  const login = await f.service.dispatch({ type: "identity/login", identifier: ID, password: PW });
  assert.equal(login.ok, true, "登录必须成功：" + JSON.stringify(login));
  return login.snapshot;
}

const loginAgain = async (f) => {
  const login = await f.service.dispatch({ type: "identity/login", identifier: ID, password: PW });
  assert.equal(login.ok, true, "重新登录必须成功：" + JSON.stringify(login));
  return login.snapshot;
};

const resourceIdOf = (res) => String(res.resource.resourceId ?? res.resource.id ?? "");

/**
 * 播种入口（与 electron/identity-bootstrap.cjs 里接线的那两个实例同一份实现）。
 * createIdentityService 的返回值里没有把 seed* 暴露出来，这里按夹具的既有做法
 * （tests/app-policy-provisions-retention.test.mjs R1/R3）就地装配一份，复用同一条连接。
 */
function seedBundles(f, userDataDir) {
  const shared = { identityStore: f.store, authorization: f.authorization, authStore: f.authStore, userDataDir, safeStorage: null };
  const model = createModelBundle(shared);
  const mcp = createMcpBundle(shared);
  return { seedModel: (organizationId, grantedBy) => model.seedModelAppPolicy({ organizationId, grantedBy }), seedMcp: (organizationId, grantedBy) => mcp.seedMcpAppPolicy({ organizationId, grantedBy }) };
}

/** 首次使用播种：创建一个资源即触发 resource 族 baseline（model / mcp 由登录事件播种）。 */
async function seedFirstUse(f, snap) {
  const res = await f.resourceService.createResource({ context: uiCtx(snap), resourceType: "text", name: "SeedTrigger", content: "seed" });
  assert.equal(res.ok, true, "首次使用播种必须成功：" + JSON.stringify(res));
  return res;
}

/** 让四张授权事实表都真的有行：resource_grants 一行 + device_access 一行（app grant / provisions 由播种产生）。 */
function enrichAuthorizationState(f, snap) {
  const ctx = uiCtx(snap);
  const grant = f.authorization.grantResourcePermission({ context: ctx, principalType: "USER", principalId: snap.userId, resourceType: "text", actions: ["resource.read"] });
  assert.equal(grant.ok, true, "resource grant 必须成功：" + JSON.stringify(grant));
  const pairing = f.deviceService.createPairing({ context: ctx, ttlMs: 60000 });
  assert.equal(pairing.ok, true, "创建配对必须成功：" + JSON.stringify(pairing));
  const consumed = f.deviceService.consumePairing({
    secret: pairing.secret,
    serviceIdentitySeen: SERVICE_IDENTITY,
    deviceIdentity: { displayName: "Reset GPU", platform: "darwin", architecture: "arm64", fingerprint: "fp_d503e_reset" },
  });
  assert.equal(consumed.ok, true, "消费配对必须成功：" + JSON.stringify(consumed));
  const access = f.deviceService.grantDeviceAccess({ context: ctx, deviceId: consumed.device.deviceId, principalType: "ORGANIZATION", principalId: "", actions: ["device.use"] });
  assert.equal(access.ok, true, "device access 必须成功：" + JSON.stringify(access));
  return consumed.device.deviceId;
}

/* ══════════════════════ T1 · 同事务回滚 ══════════════════════ */

test("T1a · 授权清理语句失败 → 整个重置回滚：逐表逐行与重置前一致", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    await seedFirstUse(f, snap);
    enrichAuthorizationState(f, snap);
    for (const table of RESET_DELETED_TABLES) assert.equal(tableCount(f.store, table) > 0, true, "重置前 " + table + " 必须有行可回滚");

    const before = dumpTables(f.store);
    const injected = injectExecFailure(f.store, "DELETE FROM resource_grants");
    try {
      assert.throws(() => f.store.resetInstallation({ confirm: CONFIRM }), /INJECTED-FAILURE/, "注入的失败必须原样上抛（不得被吞掉）");
    } finally {
      injected.restore();
    }
    assert.equal(injected.hits(), 1, "注入点必须真的命中一次");

    const after = dumpTables(f.store);
    for (const table of Object.keys(before)) {
      if (table === AUDIT_TABLES[0]) continue;
      assert.deepEqual(after[table], before[table], "回滚后 " + table + " 必须逐行与重置前一致");
    }
    // audit_log 的唯一允许增量：重置开始时写的那条 OK_REQUESTED（按设计在事务外留痕）。
    assert.deepEqual(after.audit_log.slice(0, before.audit_log.length), before.audit_log, "回滚不得删改任何既有审计行");
    assert.equal(after.audit_log.length, before.audit_log.length + 1, "失败的重置只允许留下 1 条 OK_REQUESTED 审计");
    const tail = JSON.parse(after.audit_log[after.audit_log.length - 1]);
    assert.equal(tail.event, "reset-installation");
    assert.equal(tail.result, "OK_REQUESTED");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM audit_log WHERE event = 'reset-installation' AND result = 'OK'"), 0, "失败的重置不得写 OK 审计");

    // 身份也必须是完好的（不是"授权回滚了、身份删了一半"）
    const relogin = await loginAgain(f);
    assert.equal(relogin.teamId, snap.teamId, "回滚后组织必须还在");
    assert.deepEqual(f.store.invariants(), [], "回滚后身份库自检必须为空");
  } finally {
    f.store.close();
  }
});

test("T1b · 身份最后一条语句失败 → 授权清理同样回滚（同事务的等价证明）", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    await seedFirstUse(f, snap);
    enrichAuthorizationState(f, snap);
    const beforeCounts = Object.fromEntries(RESET_DELETED_TABLES.map((t) => [t, tableCount(f.store, t)]));
    assert.equal(beforeCounts.app_policy_provisions > 0, true);

    // T1a + T1b 合起来才排除"两个独立事务"：若清理在身份删除**之前**的独立事务里提交，
    // T1b 会看到 0 行；若在**之后**的独立事务里，T1a 会看到已提交的身份删除。
    const injected = injectExecFailure(f.store, "DELETE FROM installations");
    try {
      assert.throws(() => f.store.resetInstallation({ confirm: CONFIRM }), /INJECTED-FAILURE/);
    } finally {
      injected.restore();
    }
    for (const table of RESET_DELETED_TABLES) {
      assert.equal(tableCount(f.store, table), beforeCounts[table], "身份语句失败时 " + table + " 必须原样保留");
    }
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM users"), 1, "用户必须原样保留");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM teams"), 1, "组织必须原样保留");
    assert.deepEqual(f.store.invariants(), [], "回滚后身份库自检必须为空");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T2 · 范围与审计保留 ══════════════════════ */

test("T2 · 重置后授权事实四表 + 设备身份三表 0 行；28 张 org 表逐表盘点；审计三表一行不删", async (t) => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    const oldOrg = snap.teamId;
    await seedFirstUse(f, snap);
    enrichAuthorizationState(f, snap);

    // 判据前提：重置前这七张表里的每一行都指向一个**当时存在**的组织。
    for (const table of RESET_DELETED_TABLES) {
      assert.equal(count(f.store, "SELECT COUNT(*) c FROM " + table + " WHERE organization_id NOT IN (SELECT id FROM teams)"), 0, table + " 重置前不得有孤儿行");
    }
    const dumpedBefore = dumpTables(f.store);
    const auditBefore = Object.fromEntries(AUDIT_TABLES.map((t) => [t, dumpedBefore[t]]));

    const reset = f.store.resetInstallation({ confirm: CONFIRM });
    assert.equal(reset.ok, true, "resetInstallation 必须成功：" + JSON.stringify(reset));

    for (const table of RESET_DELETED_TABLES) {
      assert.equal(tableCount(f.store, table), 0, table + " 重置后必须 0 行（旧组织 " + oldOrg + " 的授权状态 / 设备身份不得残留）");
    }
    assert.equal(f.authStore.allPolicyProvisions().length, 0);
    assert.equal(f.authStore.allAppGrants().length, 0);

    // 审计：authorization_audit / device_audit 逐行不变；audit_log 既有行全在 + 恰好 2 条重置自身的记录。
    const auditAfter = dumpTables(f.store);
    for (const table of ["authorization_audit", "device_audit"]) {
      assert.deepEqual(auditAfter[table], auditBefore[table], table + " 一行都不许删");
    }
    assert.deepEqual(auditAfter.audit_log.slice(0, auditBefore.audit_log.length), auditBefore.audit_log, "audit_log 既有行一行不删");
    assert.equal(auditAfter.audit_log.length, auditBefore.audit_log.length + 2, "audit_log 只允许新增 OK_REQUESTED / OK 两条");
    const resetAudit = f.store.auditLog().filter((r) => r.event === "reset-installation");
    assert.deepEqual(resetAudit.map((r) => r.result), ["OK_REQUESTED", "OK"], "reset-installation 的审计记录必须还在（谁重置了要查得到）");

    assert.deepEqual(f.store.invariants(), [], "重置后身份库自检仍为空");

    // 目标二：28 张带 organization_id 的表逐表盘点（这张清单就是交付说明里的判据表）。
    const inventory = orphanInventory(f.store);
    assert.equal(inventory.length, ORG_SCOPED_TABLE_COUNT, "带 organization_id 的表集合变了 → 必须重新逐表判定清理范围：" + JSON.stringify(inventory.map((r) => r.table)));
    const byTable = Object.fromEntries(inventory.map((r) => [r.table, r]));
    for (const table of RESET_DELETED_TABLES) {
      assert.equal(byTable[table].orphans, 0, table + " 不得留下指向已删组织的孤儿行");
      assert.equal(byTable[table].rows, 0, table + " 不得留下任何行");
    }
    // 审计表按设计保留：设备审计行继续带着已删组织的 id（那是历史，不是授权状态），
    // 它的行数与内容在上面已逐行比对过。
    assert.equal(byTable.device_audit.rows, auditBefore.device_audit.length, "设备审计必须按行数原样保留");
    // 按设计保留的内容/配置表：重置后必然有孤儿行（否则说明清理范围失控到内容表）。
    const residue = inventory.filter((r) => r.orphans > 0 && !AUDIT_TABLES.includes(r.table)).map((r) => r.table);
    assert.equal(residue.length > 0, true, "用户内容/配置表按设计不清，重置后必须仍能看到它们的孤儿行");
    t.diagnostic("重置后 28 张 org 表孤儿行盘点：" + inventory.map((r) => r.table + "=" + r.orphans + "/" + r.rows).join(", "));
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T3 · 组织 id 复用 ══════════════════════ */

test("T3 · 组织 id 复用不被旧墓碑压制：同一个 id 上的重置前/后 A-B 对照", async (t) => {
  const dir = tmpDir("oa-d503e-reset-reuse-");
  const a = openService(dir);
  const seedsA = seedBundles(a, dir);
  let oldOrg = null;
  let beforePairs = null;
  let beforeShapes = null;
  try {
    const snap = await initAndLogin(a);
    oldOrg = snap.teamId;
    await seedFirstUse(a, snap);
    beforePairs = pairList(a.authStore, oldOrg);
    beforeShapes = grantShapes(a.authStore, oldOrg);
    assert.equal(beforePairs.length, 15, "首次使用必须播满 10 resource + 4 model + 1 mcp：" + JSON.stringify(beforePairs));

    const mcpGrant = a.authStore.appGrantsForApp("mcp-center", oldOrg).find((g) => g.resource_type === "mcp");
    assert.ok(mcpGrant, "mcp baseline 必须先存在");
    assert.equal(a.governanceService.revokeAppAccess({ context: uiCtx(snap), grantId: mcpGrant.id }).changed, true);
    const tombstone = provisionOf(a.authStore, oldOrg, "mcp-center", "mcp");
    assert.equal(typeof tombstone.revoked_at, "number", "撤销必须写墓碑");

    // A 侧（重置前，同一个 id）：墓碑挡住建播种 —— 这就是第四批登记的"唯一真实风险"。
    assert.deepEqual(seedsA.seedMcp(oldOrg, snap.userId), { ok: true, seeded: false }, "重置前：墓碑必须挡住首次播种");
    assert.deepEqual(seedsA.seedModel(oldOrg, snap.userId), { ok: true, seeded: false }, "重置前：墓碑必须挡住首次播种");

    const reset = a.store.resetInstallation({ confirm: CONFIRM });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(provisionOf(a.authStore, oldOrg, "mcp-center", "mcp"), null, "重置后旧墓碑必须不存在");
    assert.equal(a.authStore.allPolicyProvisions().filter((r) => r.organization_id === oldOrg).length, 0);
    assert.equal(a.authStore.appGrantsForApp("mcp-center", oldOrg).length, 0);
  } finally {
    a.store.close();
  }

  const b = openService(dir);
  const seedsB = seedBundles(b, dir);
  try {
    const snapNew = await initAndLogin(b);
    const newOrg = snapNew.teamId;
    assert.notEqual(newOrg, oldOrg, "正常路径：重新初始化产生新的组织 id");

    // 受控构造"组织 id 复用"：把新组织的 id 改成旧组织的 id（只改 id，其它一切不动）。
    b.store.transactSync(() => {
      b.store.connection.exec("PRAGMA defer_foreign_keys = ON");
      b.store.connection.prepare("UPDATE users SET team_id = ? WHERE team_id = ?").run(oldOrg, newOrg);
      b.store.connection.prepare("UPDATE teams SET id = ? WHERE id = ?").run(oldOrg, newOrg);
    });
    assert.equal(count(b.store, "SELECT COUNT(*) c FROM teams WHERE id = ?", oldOrg), 1, "受控构造：组织 id 已复用");
    assert.equal(count(b.store, "SELECT COUNT(*) c FROM users WHERE team_id = ?", oldOrg), 1, "受控构造：用户也指向复用的 id");
    assert.deepEqual(b.store.invariants(), [], "复用 id 后身份库自检必须为空");
    // 刻意不重登：登录事件会顺带播种，会把"播种到底有没有被墓碑挡住"的观察点搅浑。
    // 会话也不必更新 —— snapshot 与授权都按 DB 里的 user 行现算组织（§35：不信 Renderer 输入），
    // 所以同一个 sessionRef 现在就属于复用后的组织 id。
    assert.equal(b.service.snapshot.teamId, oldOrg, "会话的组织必须现算自 DB（改 id 后立刻生效）");

    // B 侧（重置后，同一个 id）：不被压制，首次播种真的发生。
    assert.deepEqual(seedsB.seedMcp(oldOrg, snapNew.userId), { ok: true, seeded: true }, "同一个 id：旧墓碑必须已消失，首次 mcp 播种必须真的发生");
    assert.deepEqual(seedsB.seedModel(oldOrg, snapNew.userId), { ok: true, seeded: true }, "同一个 id：首次 model 播种必须真的发生");
    await seedFirstUse(b, snapNew);

    const reusePairs = pairList(b.authStore, oldOrg);
    assert.deepEqual(reusePairs, beforePairs, "复用 id 的新组织必须拿到与重置前同一套完整授权");
    assert.deepEqual(grantShapes(b.authStore, oldOrg), beforeShapes, "复用 id 的新组织必须拿到与重置前同一套 app grant");
    const reuseProvisions = b.authStore.allPolicyProvisions().filter((r) => r.organization_id === oldOrg);
    assert.equal(reuseProvisions.length, 15, "复用 id 的新组织必须有完整 15 条提供记录");
    assert.deepEqual(reuseProvisions.filter((r) => r.revoked_at != null), [], "复用 id 的新组织不得继承任何墓碑");
    assert.equal(provisionOf(b.authStore, oldOrg, "mcp-center", "mcp").revoked_at, null, "新组织的 mcp 是首次使用，不是旧撤销的复活");

    // 与"未重置的全新安装"同形：另开一个干净目录走同一路径，逐行比对组织无关形状。
    const fresh = openService(tmpDir("oa-d503e-reset-fresh-"));
    try {
      const snapFresh = await initAndLogin(fresh);
      await seedFirstUse(fresh, snapFresh);
      assert.deepEqual(grantShapes(b.authStore, oldOrg), grantShapes(fresh.authStore, snapFresh.teamId), "复用 id 的新组织必须与全新安装同形");
      assert.deepEqual(pairList(b.authStore, oldOrg), pairList(fresh.authStore, snapFresh.teamId), "复用 id 的新组织必须与全新安装同形");
    } finally {
      fresh.store.close();
    }
    t.diagnostic("同一个组织 id " + oldOrg + "：重置前播种被墓碑挡住（seeded:false），重置后首次播种正常发生（seeded:true），与全新安装逐行同形（16 条 app grant / 15 条提供记录）");
  } finally {
    b.store.close();
  }
});

/* ══════════════════════ T4 · 反向：正常路径墓碑仍在 ══════════════════════ */

test("T4 · 反向：未重置时墓碑仍在，重播种/重试都不覆盖、撤权不复活", async () => {
  const dir = tmpDir();
  const f = openService(dir);
  const seeds = seedBundles(f, dir);
  try {
    const snap = await initAndLogin(f);
    const org = snap.teamId;
    await seedFirstUse(f, snap);
    const mcpGrant = f.authStore.appGrantsForApp("mcp-center", org).find((g) => g.resource_type === "mcp");
    assert.ok(mcpGrant);
    assert.equal(f.governanceService.revokeAppAccess({ context: uiCtx(snap), grantId: mcpGrant.id }).changed, true);
    const tombstone = provisionOf(f.authStore, org, "mcp-center", "mcp");
    assert.equal(typeof tombstone.revoked_at, "number");

    for (let round = 1; round <= 2; round += 1) {
      assert.deepEqual(seeds.seedMcp(org, snap.userId), { ok: true, seeded: false }, "第 " + round + " 轮重播种必须跳过");
      await seedFirstUse(f, snap);
      assert.deepEqual(provisionOf(f.authStore, org, "mcp-center", "mcp"), tombstone, "墓碑必须逐字段不变");
      assert.equal(baselineGrantOf(f.authStore, org, "mcp-center", "mcp"), null, "撤权不得复活");
    }
    assert.equal(f.authStore.allPolicyProvisions().filter((r) => r.organization_id === org && r.app_id === "mcp-center" && r.policy_key === "mcp").length, 1, "撤权记录必须恰好一行");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T5 · 判据：App 侧取数与判定都读 organization_id ══════════════════════ */

test("T5 · 判据：指向不存在组织的 app grant 不再授权（旧行为 ALLOW，第六批修复为 DENY）", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    const org = snap.teamId;
    const created = await seedFirstUse(f, snap);
    const resourceId = resourceIdOf(created);
    assert.equal(resourceId.startsWith("res_"), true, "必须拿到真实 resource id：" + resourceId);

    const authorize = () => f.authorization.authorize({ context: uiCtx(snap), application: { appId: "canvas" }, action: "resource.read", resource: { resourceId } });
    assert.equal(authorize().decision, "ALLOW", "canvas 的 baseline 全局授权必须先成立");

    // 正常撤权：删 grant 行 + 写墓碑 → DENY。
    const canvasGrant = baselineGrantOf(f.authStore, org, "canvas", "");
    assert.ok(canvasGrant, "canvas baseline 必须先存在");
    assert.equal(f.governanceService.revokeAppAccess({ context: uiCtx(snap), grantId: canvasGrant.id }).changed, true);
    const revoked = authorize();
    assert.equal(revoked.decision, "DENY");
    assert.equal(revoked.reasonCode, "APP_ACTION_NOT_GRANTED");

    // 受控构造：往一个**不存在任何组织**的 organization_id 上写一条同形 app grant。
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM teams WHERE id = ?", GHOST_ORG), 0, "受控构造的前提：这个组织不存在");
    f.authStore.upsertAppGrant({ appId: "canvas", resourceType: "text", actions: ["resource.view", "resource.read"], grantedBy: snap.userId, organizationId: GHOST_ORG });
    const ghostRow = f.authStore.appGrantsForApp("canvas", GHOST_ORG)[0] || null;
    assert.ok(ghostRow, "受控构造：孤儿 app grant 已写入");
    assert.equal(provisionOf(f.authStore, GHOST_ORG, "canvas", "resource"), null, "定向形状不写提供记录（这行纯粹是孤儿授权）");
    assert.equal(orphanInventory(f.store).find((r) => r.table === "app_resource_grants").orphans, 1, "这行必须被孤儿行判据认出来");

    // 第六批修复后的期望：孤儿行**不能**授权。
    // 【期望值订正】旧期望 = ALLOW（allowSources 含 APP_GRANT）；新期望 = DENY + APP_ACTION_NOT_GRANTED。
    // 理由：取数层 appGrantsForApp 现在按 (app_id, organization_id) 过滤，判权层 evaluateAppAuthorization
    // 再逐条跳过异组织 grant —— 指向已删组织的行不再是"跨组织通配"。
    const notRevived = authorize();
    assert.equal(notRevived.decision, "DENY", "指向已删除组织的 app grant 不得再授权（旧期望 ALLOW，那正是本批修掉的漏洞）");
    assert.equal(notRevived.reasonCode, "APP_ACTION_NOT_GRANTED");
    assert.equal(notRevived.allowSources.includes("APP_GRANT"), false, JSON.stringify(notRevived.allowSources));

    // 阳性对照：同形授予落在**本组织**时立刻 ALLOW —— 证明上面那条 DENY 来自组织隔离本身，
    // 而不是"形状不被识别"或别的闸门。
    const inOrg = f.authStore.upsertAppGrant({ appId: "canvas", resourceType: "text", actions: ["resource.view", "resource.read"], grantedBy: snap.userId, organizationId: org });
    assert.equal(authorize().decision, "ALLOW", "同形授予落在本组织必须放行：" + JSON.stringify(authorize()));
    assert.equal(f.governanceService.revokeAppAccess({ context: uiCtx(snap), grantId: inOrg.grant.id }).changed, true);
    assert.equal(authorize().decision, "DENY", "本组织的正式撤销必须立刻生效");

    // 清掉孤儿行 → 仍然 DENY（孤儿行从来不是那次撤销的复活来源）。
    f.store.connection.prepare("DELETE FROM app_resource_grants WHERE organization_id = ?").run(GHOST_ORG);
    assert.equal(authorize().decision, "DENY");

    // 重置把这行一起带走。
    f.authStore.upsertAppGrant({ appId: "canvas", resourceType: "text", actions: ["resource.view", "resource.read"], grantedBy: snap.userId, organizationId: GHOST_ORG });
    assert.equal(f.store.resetInstallation({ confirm: CONFIRM }).ok, true);
    assert.equal(tableCount(f.store, "app_resource_grants"), 0, "重置后孤儿 app grant 必须被清掉");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T5b · 重置残留的实际后果（产品级） ══════════════════════ */

/**
 * 第四批的文档把孤儿判定为"不可达、不致权限复活"；第五批实测证明该判定对 app_resource_grants
 * 不成立（旧残留行能让新组织的撤销失效）。这条用例给出**产品级后果**的对照：
 *   旧残留（app_id=canvas、目标全空、organization_id 指向已删组织）当时在新组织里等价于一条
 *   "永久有效"的 canvas 全局授权 —— 新组织里再撤销 canvas，App 侧照样能命中旧残留行 → ALLOW。
 * 第五批让重置把旧组织的行一起清掉；第六批再把取数与判定都按组织过滤，**两层**保证
 * 撤销是真 DENY（残留行即使被种回来也不放行）。
 */
test("T5b · 产品后果：重置后新组织撤销 canvas 必须真 DENY（旧残留若在会继续 ALLOW）", async () => {
  const dir = tmpDir("oa-d503e-reset-consequence-");
  const a = openService(dir);
  let oldOrg = null;
  try {
    const snapA = await initAndLogin(a);
    oldOrg = snapA.teamId;
    await seedFirstUse(a, snapA);
    assert.ok(baselineGrantOf(a.authStore, oldOrg, "canvas", ""), "旧组织的 canvas baseline 必须先存在");
    assert.equal(a.store.resetInstallation({ confirm: CONFIRM }).ok, true);
    assert.equal(a.authStore.allAppGrants().filter((g) => g.app_id === "canvas").length, 0, "重置后 canvas 的授权行必须全部消失");
  } finally {
    a.store.close();
  }

  const b = openService(dir);
  try {
    const snapB = await initAndLogin(b);
    const newOrg = snapB.teamId;
    assert.notEqual(newOrg, oldOrg);
    const created = await seedFirstUse(b, snapB);
    const resourceId = resourceIdOf(created);
    const authorize = () => b.authorization.authorize({ context: uiCtx(snapB), application: { appId: "canvas" }, action: "resource.read", resource: { resourceId } });
    assert.equal(authorize().decision, "ALLOW", "新组织自己的 canvas baseline 必须先成立");

    const canvasGrant = baselineGrantOf(b.authStore, newOrg, "canvas", "");
    assert.equal(b.governanceService.revokeAppAccess({ context: uiCtx(snapB), grantId: canvasGrant.id }).changed, true);
    const afterRevoke = authorize();
    assert.equal(afterRevoke.decision, "DENY", "新组织撤销 canvas 之后必须 DENY（旧组织的残留行不得再让它 ALLOW）");
    assert.equal(afterRevoke.reasonCode, "APP_ACTION_NOT_GRANTED");

    // 反事实对照：把旧组织那条残留行原样种回去（同一个形状，organization_id 指向已删组织）。
    // 【期望值订正】旧期望 = ALLOW（"残留行会让新组织的撤销失效"）；新期望 = DENY。
    // 理由：取数按组织过滤 + 判权层逐条跳过异组织 grant，残留行不再是跨组织通配。
    const ghost = b.authStore.upsertAppGrant({ appId: "canvas", actions: ["resource.view", "resource.search", "resource.preview", "resource.read"], grantedBy: "system:model-baseline", organizationId: oldOrg });
    assert.ok(ghost.grant, "受控构造：旧组织的同形残留行已种回");
    assert.equal(count(b.store, "SELECT COUNT(*) c FROM teams WHERE id = ?", oldOrg), 0, "它指向的组织确实不存在");
    const afterGhost = authorize();
    assert.equal(afterGhost.decision, "DENY", "旧组织的残留行不得让新组织的撤销失效（旧期望 ALLOW）");
    assert.equal(afterGhost.reasonCode, "APP_ACTION_NOT_GRANTED");
    assert.equal(afterGhost.allowSources.includes("APP_GRANT"), false, JSON.stringify(afterGhost.allowSources));

    // 阳性对照：同一形状落在**新组织**时立刻 ALLOW —— 本组织的正式重授是真授权，与残留行无关。
    const regrant = b.authStore.upsertAppGrant({ appId: "canvas", actions: ["resource.view", "resource.search", "resource.preview", "resource.read"], grantedBy: "system:model-baseline", organizationId: newOrg });
    assert.equal(authorize().decision, "ALLOW", "本组织的同形授予必须放行");
    assert.equal(b.governanceService.revokeAppAccess({ context: uiCtx(snapB), grantId: regrant.grant.id }).changed, true);
    assert.equal(authorize().decision, "DENY", "本组织撤销后立刻回到 DENY");

    // 清掉旧组织的残留行 → 仍然是 DENY。
    b.store.connection.prepare("DELETE FROM app_resource_grants WHERE id = ?").run(ghost.grant.id);
    assert.equal(authorize().decision, "DENY", "清掉残留行后仍是 DENY");
  } finally {
    b.store.close();
  }
});

/* ══════════════════════ T7 · 设备身份事实随重置归零（第七批订正） ══════════════════════ */

/**
 * 第五批把 devices / device_credentials / device_pairing_credentials 登记为**不清**，只在 T7 里证明
 * "残留配对凭据不产生授权结论"。第七批把这条结论订正掉：**不产生授权结论 ≠ 不能恢复设备身份**。
 *   · 旧期望（逐字）："残留的配对凭据确实还能登记设备（已登记的残留，本批不清）"，且断言
 *     device_pairing_credentials 在重置后仍有 1 行；
 *   · 新期望：重置后旧密钥被拒（PAIRING_TOKEN_UNKNOWN），三张设备表 0 行，0 台新设备 / 0 条新凭据。
 * 理由（可复核的代码路径）：credentialByFingerprint（device-store.cjs:51）与 pairingBySecretHash
 * （device-store.cjs:39/:43）两条取数路径**都不比对组织**，且 heartbeat 的 Device Gate 用
 * role:"ADMIN" 的合成 actor（device-service.cjs:601）—— 于是"旧凭据 + 旧 devices 行"在重置后
 * 仍能拿到连接与心跳放行，这条路径根本不经过 device_access。
 * 设备侧的完整证据（含旧→新逐条 expected/actual）见 tests/d5-03-reset-device-identity.test.mjs。
 */
test("T7 · 重置后旧设备事实不再可用：旧配对密钥被拒、三张设备表 0 行、旧设备查不到", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    const oldOrg = snap.teamId;
    const pairing = f.deviceService.createPairing({ context: uiCtx(snap), ttlMs: 60000 });
    assert.equal(pairing.ok, true, JSON.stringify(pairing));
    // 重置前先真的配一台设备：这样 devices / device_credentials 都有行，"清空"才是 1 → 0 的证据。
    const consumedBefore = f.deviceService.consumePairing({
      secret: pairing.secret,
      serviceIdentitySeen: SERVICE_IDENTITY,
      deviceIdentity: { displayName: "Pre-Reset GPU", platform: "darwin", architecture: "arm64", fingerprint: "fp_d503e_pre_reset" },
    });
    assert.equal(consumedBefore.ok, true, "重置前必须能配对成功：" + JSON.stringify(consumedBefore));
    const survivorFingerprint = "fp_d503e_pre_reset";

    // 重置前再签发一条**未消费**的密钥：这是第五批登记为"残留能力"的那条路径。
    const pending = f.deviceService.createPairing({ context: uiCtx(snap), ttlMs: 60000 });
    assert.equal(pending.ok, true, JSON.stringify(pending));
    assert.equal(tableCount(f.store, "devices"), 1, "重置前恰好 1 台设备");
    assert.equal(tableCount(f.store, "device_credentials"), 1, "重置前恰好 1 条凭据");
    assert.equal(tableCount(f.store, "device_pairing_credentials"), 2, "重置前 1 条已消费 + 1 条未消费");

    assert.equal(f.store.resetInstallation({ confirm: CONFIRM }).ok, true);
    for (const table of ["devices", "device_credentials", "device_pairing_credentials"]) {
      assert.equal(tableCount(f.store, table), 0, table + " 重置后必须 0 行（旧设备身份不得残留）");
    }
    assert.equal(tableCount(f.store, "device_access"), 0, "设备访问授权同样被清空");

    // ① 旧凭据不能再认证：指纹反查不到任何凭据行。
    const auth = f.deviceService.authenticateConnection({ fingerprint: survivorFingerprint });
    assert.equal(auth.ok, false, "旧设备凭据不得再解析出设备：" + JSON.stringify(auth));
    assert.equal(auth.error, "DEVICE_CREDENTIAL_UNKNOWN", JSON.stringify(auth));

    // ② 未消费的旧密钥不能再登记设备（第五批的行为在这里被堵死）。
    const reused = f.deviceService.consumePairing({
      secret: pending.secret,
      serviceIdentitySeen: SERVICE_IDENTITY,
      deviceIdentity: { displayName: "Survivor", platform: "darwin", architecture: "arm64", fingerprint: "fp_d503e_survivor" },
    });
    assert.equal(reused.ok, false, "重置后旧配对密钥必须被拒：" + JSON.stringify(reused));
    assert.equal(reused.error, "PAIRING_TOKEN_UNKNOWN", JSON.stringify(reused));

    // ③ 重新初始化后，旧设备对新组织来说根本不存在（不是"存在但被拒"）。
    const snapNew = await initAndLogin(f);
    assert.notEqual(snapNew.teamId, oldOrg);
    const byId = f.deviceService.authorizeDeviceById({ context: uiCtx(snapNew), deviceId: consumedBefore.device.deviceId, action: "device.use" });
    assert.equal(byId.ok, false, "新组织成员不得因残留设备/凭据拿到授权");
    assert.equal(byId.error, "DEVICE_NOT_FOUND", JSON.stringify(byId));
    assert.equal(byId.reason, "NOT_FOUND_OR_FORBIDDEN", "对外理由必须仍然不泄漏设备是否存在：" + JSON.stringify(byId));
    assert.equal(f.deviceService.listDevices({ context: uiCtx(snapNew) }).items.length, 0, "新组织的设备列表必须为空");
    assert.equal(tableCount(f.store, "devices"), 0, "失败的重放不得留下新设备");
    assert.equal(tableCount(f.store, "device_credentials"), 0, "失败的重放不得留下新凭据");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T6 · 范围守卫 ══════════════════════ */

test("T6 · 范围守卫：重置删除集合恰好是登记的七张表（授权事实 + 设备身份），无 WHERE、不含审计/内容表", () => {
  const tables = RESET_AUTHORIZATION_DELETE_SQL.map((sql) => {
    const m = /^DELETE FROM ([a-z_]+)$/.exec(String(sql).trim());
    assert.ok(m, "每条重置删除语句都必须是纯 DELETE FROM <table>（不得带 WHERE / 子查询 / 拼接）：" + sql);
    return m[1];
  });
  assert.deepEqual(tables.slice().sort(), RESET_DELETED_TABLES.slice().sort(), "重置要删的表集合必须恰好是登记的七张表（四张授权事实 + 三张设备身份）");
  for (const table of AUDIT_TABLES) assert.equal(tables.includes(table), false, "审计表不得进入重置删除集合：" + table);
  // 顺序约束：device_credentials.device_id REFERENCES devices(id) 且 PRAGMA foreign_keys = ON，
  // 先删父表会直接抛外键错误 —— 顺序是"能不能重置成功"的一部分，不是风格问题。
  assert.equal(
    tables.indexOf("device_credentials") < tables.indexOf("devices"),
    true,
    "device_credentials 必须在 devices 之前删（否则外键违约，重置整体回滚）：" + JSON.stringify(tables),
  );
  assert.equal(
    tables.indexOf("device_access") < tables.indexOf("devices"),
    true,
    "device_access 也引用 devices(id)，同样必须先删：" + JSON.stringify(tables),
  );

  const f = openService(tmpDir());
  try {
    for (const table of tables) {
      const cols = columnsOf(f.store, table);
      assert.equal(cols.length > 0, true, table + " 必须在真实 schema 里存在");
      const org = cols.find((c) => c.name === "organization_id");
      assert.ok(org, table + " 必须组织作用域（整表删 = 删指向已删组织的授权状态 / 设备身份）");
      assert.equal(org.notnull, 1, table + ".organization_id 必须是 NOT NULL：整表删的语义依赖它");
    }
    const inventory = orphanInventory(f.store).map((r) => r.table);
    assert.equal(inventory.length, ORG_SCOPED_TABLE_COUNT);
    // 显式登记 cloud_installation_binding：含 organization_id，故在 org 作用域清单里；但**不在**重置删除
    // 集合里 —— 外键指向 DX 自身的 installation_identity（不是 OpenArc 的 installations），且 cloud 域
    // 本轮默认关闭，不产生本地授权结论。逐表理由见文件头结论。
    assert.equal(inventory.includes("cloud_installation_binding"), true, "cloud_installation_binding 必须仍在 org 作用域清单里（含 organization_id）");
    assert.equal(tables.includes("cloud_installation_binding"), false, "cloud_installation_binding 不得进入重置删除集合");
    for (const table of tables) assert.equal(inventory.includes(table), true, table + " 必须在 28 张 org 作用域表清单里");
  } finally {
    f.store.close();
  }
});
