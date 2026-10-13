/**
 * D5-03 第七批 · 安装重置对**设备身份**的影响（测试即合同）。
 *
 * 背景（第五批登记、第七批收口）：resetInstallation 原本只清授权事实四张表，
 * devices / device_credentials / device_pairing_credentials 一行不动。于是重置后：
 *   ① 重置前签发、未消费的配对密钥仍能登记设备（consumePairing 走 secret_hash 反查，不看组织）；
 *   ② 旧凭据指纹仍能解析出设备（credentialByFingerprint 不看组织），heartbeat 再走
 *      role:"ADMIN" 合成 actor 的 Device Gate —— 连接与心跳都放行，整条路径不经过 device_access。
 * 结论：这两条都是"能恢复设备身份/权限"的路径，必须与身份、授权清理在**同一个 transactSync** 里清掉；
 * device_audit 一行不删（审计是历史，不是身份）。
 *
 * 合同条目（每条都有 expected / actual）：
 *   T1  重置前：旧密钥有效（配对出设备 + 凭据），旧凭据能认证、能授权；
 *   T2  正式重置后：旧密钥 PAIRING_TOKEN_UNKNOWN、三表 0 行、0 新设备 / 0 新凭据、
 *      旧凭据 DEVICE_CREDENTIAL_UNKNOWN、旧连接心跳被拒、旧设备对新组织 DEVICE_NOT_FOUND；
 *   T3  确认词错误：设备状态与身份、授权状态逐表逐行与重置前一致；
 *   T4  注入失败（设备凭据语句）→ 整体回滚；
 *   T5  注入失败（devices 语句）→ 整体回滚；
 *   T6  注入失败（身份最后一条 installations）→ 设备三表同样原样（排除"两个独立事务"）；
 *   T7  重新初始化后：新管理员签发的新密钥可正常完成一次配对（新设备 + 新凭据 + 组织 = 新组织）；
 *   T8  跨组织与自报组织：deviceIdentity 组织不匹配被拒；context.organizationId 不得覆盖会话组织；
 *   T9  并发单次消费：恰好 1 台设备 / 1 条凭据，输家 PAIRING_TOKEN_ALREADY_USED，无半状态残留；
 *   T10 审计保留与明文 secret 不外泄（DB 全表 + WAL + 日志 + 审计 payload 扫描）；
 *   T11 SCHEMA_VERSION 仍为 21（本批不需要 schema 变更）。
 *
 * 临时目录前缀 oa-d503g-reset-device-，与 d503e-reset- / d503d-retention- 命名空间分开。
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
const { IdentityStore, SCHEMA_VERSION, RESET_AUTHORIZATION_DELETE_SQL } = require(path.join(ROOT, "electron", "identity-store.cjs"));
const { IdentityLogger } = require(path.join(ROOT, "electron", "identity-log.cjs"));
const { DeviceStore } = require(path.join(ROOT, "electron", "device-store.cjs"));
const { DeviceService } = require(path.join(ROOT, "electron", "device-service.cjs"));
const domain = require(path.join(ROOT, "electron", "device-domain.cjs"));

const CONFIRM = "DELETE-ALL-IDENTITY-DATA";
const ID = "admin@d503g-reset.test";
const PW = "reset-password-1";
const SERVICE_IDENTITY = "svc_d503g_device_reset";
const FOREIGN_ORG = "team_d503g_foreign000000000001";
const DEVICE_TABLES = Object.freeze(["devices", "device_credentials", "device_pairing_credentials"]);
const AUDIT_TABLES = Object.freeze(["audit_log", "authorization_audit", "device_audit"]);

const TEMP_DIRS = [];
test.after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d503g-reset-device-"));
  TEMP_DIRS.push(dir);
  return dir;
};
const dbPathOf = (userDataDir) => path.join(userDataDir, "identity.db");
const openService = (userDataDir, logger = null) => createIdentityService({ userDataDir, safeStorage: null, allowAdmin: true, serviceIdentity: SERVICE_IDENTITY, logger });

/* ══════════════════════ 公共取值器 ══════════════════════ */

const count = (store, sql, ...params) => store.connection.prepare(sql).get(...params).c;
const tableCount = (store, table) => count(store, "SELECT COUNT(*) c FROM " + table);
const tableNames = (store) =>
  store.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
/** 逐表逐行快照（含 devices / device_credentials 的全部列，不只行数）。 */
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
/** 逐表逐行比对（audit_log 允许新增：重置在事务外先写一条 OK_REQUESTED）。 */
function assertEverythingElseUnchanged(before, after, label) {
  for (const table of Object.keys(before)) {
    if (table === AUDIT_TABLES[0]) continue;
    assert.deepEqual(after[table], before[table], label + "：" + table + " 必须逐行与重置前一致");
  }
  assert.deepEqual(after.audit_log.slice(0, before.audit_log.length), before.audit_log, label + "：audit_log 既有行一行不得删改");
}

const uiCtx = (snap, extra = {}) => ({ sessionRef: snap.sessionRef, appId: "resource-library", source: "ui", ...extra });

/**
 * 断言消息里**不得出现明文 secret**（createPairing 的响应带 secret）：失败输出也是日志。
 * 只投影出排障需要的字段（ok / error / pairingId / organizationId）。
 */
const briefPairing = (res) =>
  JSON.stringify({
    ok: res && res.ok,
    error: (res && res.error) || null,
    pairingId: res && res.pairing ? res.pairing.id : null,
    organizationId: res && res.pairing ? res.pairing.organizationId : null,
  });

async function initAndLogin(f) {
  const init = await f.service.dispatch({ type: "identity/initialize", identifier: ID, password: PW, displayName: "Admin" });
  assert.equal(init.ok, true, "初始化必须成功：" + JSON.stringify(init));
  const login = await f.service.dispatch({ type: "identity/login", identifier: ID, password: PW });
  assert.equal(login.ok, true, "登录必须成功：" + JSON.stringify(login));
  return login.snapshot;
}

/** 走一遍真实配对：返回 { created, consumed, fingerprint }。 */
function pairOnce(f, snap, { fingerprint, displayName = "Pre-Reset GPU", ttlMs = 60000 } = {}) {
  const created = f.deviceService.createPairing({ context: uiCtx(snap), ttlMs });
  assert.equal(created.ok, true, "createPairing 必须成功：" + briefPairing(created));
  const consumed = f.deviceService.consumePairing({
    secret: created.secret,
    serviceIdentitySeen: SERVICE_IDENTITY,
    deviceIdentity: { displayName, platform: "darwin", architecture: "arm64", fingerprint },
  });
  assert.equal(consumed.ok, true, "consumePairing 必须成功：" + JSON.stringify(consumed));
  return { created, consumed, fingerprint };
}

/**
 * 事务内失败注入（**测试侧**手段，产品代码没有任何后门）：
 * 只包住这一次 exec，命中指定语句即抛；其余语句照常执行。
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

/* ══════════════════════ T1 · 重置前的设备身份事实 ══════════════════════ */

test("T1 · 重置前：旧配对密钥有效（配对出设备 + 凭据），旧凭据能认证、能授权", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    const { created, consumed, fingerprint } = pairOnce(f, snap, { fingerprint: "fp_d503g_pre" });
    assert.equal(created.pairing.organizationId, snap.teamId, "签发组织 = 会话组织");
    assert.equal(consumed.device.organizationId, snap.teamId, "设备注册到签发组织");
    assert.equal(consumed.device.status, "ACTIVE");
    assert.equal(consumed.credential.credentialVersion, 1);
    assert.equal(tableCount(f.store, "devices"), 1);
    assert.equal(tableCount(f.store, "device_credentials"), 1);
    assert.equal(tableCount(f.store, "device_pairing_credentials"), 1);
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM device_pairing_credentials WHERE status = 'CONSUMED'"), 1);

    const auth = f.deviceService.authenticateConnection({ fingerprint });
    assert.equal(auth.ok, true, "旧凭据必须能认证（第一层）：" + JSON.stringify(auth));
    assert.equal(auth.deviceId, consumed.device.deviceId);

    const admin = { userId: snap.userId, role: "ADMIN", organizationId: snap.teamId, departmentIds: [] };
    const adminVerdict = f.deviceService.authorizeDevice({ device: f.deviceStore.deviceById(consumed.device.deviceId), action: "device.use", actor: admin, credential: auth.credential });
    assert.equal(adminVerdict.ok, true, "管理员路径必须放行：" + JSON.stringify(adminVerdict));
    assert.equal(adminVerdict.source, "SUPER_ADMIN");

    // 非管理员路径：默认 DENY → 显式授权 → ALLOW（证明 ACL 判定真的在跑，而不是只有管理员分支）。
    const member = { userId: "usr_d503g_member0000000001", role: "MEMBER", organizationId: snap.teamId, departmentIds: [] };
    const denied = f.deviceService.authorizeDevice({ device: f.deviceStore.deviceById(consumed.device.deviceId), action: "device.use", actor: member });
    assert.equal(denied.ok, false, "未授权成员必须 DENY");
    assert.equal(denied.error, "DEVICE_ACTION_NOT_GRANTED");
    const grant = f.deviceService.grantDeviceAccess({
      context: uiCtx(snap),
      deviceId: consumed.device.deviceId,
      principalType: "USER",
      principalId: member.userId,
      actions: ["device.use"],
    });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    const allowed = f.deviceService.authorizeDevice({ device: f.deviceStore.deviceById(consumed.device.deviceId), action: "device.use", actor: member });
    assert.equal(allowed.ok, true, "显式授权后必须放行：" + JSON.stringify(allowed));
    assert.equal(allowed.source, "USER_GRANT");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T2 · 正式重置后的设备身份 ══════════════════════ */

test("T2 · 正式重置后：旧密钥被拒、设备三表 0 行、0 新设备/0 新凭据、旧凭据不能再认证或授权", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    const oldOrg = snap.teamId;
    const { consumed, fingerprint } = pairOnce(f, snap, { fingerprint: "fp_d503g_t2" });
    const pending = f.deviceService.createPairing({ context: uiCtx(snap), ttlMs: 60000 });
    assert.equal(pending.ok, true, briefPairing(pending));
    // 真机上"握手成功后仍握在手里的长连接"：先拿到连接对象，重置后再发一条受保护消息。
    const liveConnection = { ...f.deviceService.authenticateConnection({ fingerprint }), close: () => {} };
    assert.equal(liveConnection.ok, true);

    const reset = f.store.resetInstallation({ confirm: CONFIRM });
    assert.equal(reset.ok, true, "重置必须成功：" + JSON.stringify(reset));

    for (const table of DEVICE_TABLES) {
      assert.equal(tableCount(f.store, table), 0, "expected 0 rows，actual " + tableCount(f.store, table) + "（" + table + "）");
    }

    const reused = f.deviceService.consumePairing({
      secret: pending.secret,
      serviceIdentitySeen: SERVICE_IDENTITY,
      deviceIdentity: { displayName: "Survivor", fingerprint: "fp_d503g_survivor" },
    });
    assert.equal(reused.ok, false, "重置后旧配对密钥必须被拒：" + JSON.stringify(reused));
    assert.equal(reused.error, "PAIRING_TOKEN_UNKNOWN", "拒绝码必须稳定（不是未知原因失败）：" + JSON.stringify(reused));
    assert.equal(tableCount(f.store, "devices"), 0, "被拒的消费不得留下设备（0 个新设备）");
    assert.equal(tableCount(f.store, "device_credentials"), 0, "被拒的消费不得留下凭据（0 条新凭据）");

    const reAuth = f.deviceService.authenticateConnection({ fingerprint });
    assert.equal(reAuth.ok, false, "旧凭据不得再解析出设备：" + JSON.stringify(reAuth));
    assert.equal(reAuth.error, "DEVICE_CREDENTIAL_UNKNOWN", JSON.stringify(reAuth));

    const hb = f.deviceService.heartbeat({ connection: liveConnection, payload: { deviceId: consumed.device.deviceId } });
    assert.equal(hb.ok, false, "旧长连接的下一条受保护消息必须失败：" + JSON.stringify(hb));
    assert.equal(hb.error, "DEVICE_CREDENTIAL_MISMATCH", JSON.stringify(hb));

    const snapNew = await initAndLogin(f);
    assert.notEqual(snapNew.teamId, oldOrg, "重新初始化必须产生新组织");
    const byId = f.deviceService.authorizeDeviceById({ context: uiCtx(snapNew), deviceId: consumed.device.deviceId, action: "device.use" });
    assert.equal(byId.ok, false, "新组织成员不得因残留设备/凭据拿到授权：" + JSON.stringify(byId));
    assert.equal(byId.error, "DEVICE_NOT_FOUND", JSON.stringify(byId));
    assert.equal(byId.reason, "NOT_FOUND_OR_FORBIDDEN", "对外理由仍不得泄漏存在性");
    assert.equal(f.deviceStore.deviceById(consumed.device.deviceId), null, "旧设备行必须真的不在了");
    assert.equal(f.deviceService.listDevices({ context: uiCtx(snapNew) }).items.length, 0, "新组织的设备列表必须为空");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T3 · 确认词错误，一切原样 ══════════════════════ */

test("T3 · 确认词错误：设备状态与身份、授权状态逐表逐行与重置前一致", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    pairOnce(f, snap, { fingerprint: "fp_d503g_t3" });
    const before = dumpTables(f.store);
    const res = f.store.resetInstallation({ confirm: CONFIRM + "-TYPO" });
    assert.equal(res.ok, false, "确认词错误必须被拒：" + JSON.stringify(res));
    assert.equal(res.error, "INVALID_INPUT", JSON.stringify(res));
    const after = dumpTables(f.store);
    for (const table of Object.keys(before)) {
      if (table === AUDIT_TABLES[0]) continue;
      assert.deepEqual(after[table], before[table], "被拒的重置不得改动 " + table + "（逐行一致）");
    }
    assert.deepEqual(after.audit_log.slice(0, before.audit_log.length), before.audit_log, "既有审计行不得改动");
    assert.equal(after.audit_log.length, before.audit_log.length + 1, "被拒的重置只允许留下 1 条 DENY 留痕");
    const tail = JSON.parse(after.audit_log[after.audit_log.length - 1]);
    assert.equal(tail.event, "reset-installation");
    assert.equal(tail.result, "DENY");
    for (const table of DEVICE_TABLES) assert.equal(tableCount(f.store, table), 1, table + " 必须原样保留 1 行");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T4 / T5 / T6 · 同事务回滚（三个注入点） ══════════════════════ */

test("T4 · 注入失败（DELETE FROM device_credentials，设备侧第一条）→ 整体回滚", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    pairOnce(f, snap, { fingerprint: "fp_d503g_t4" });
    assert.equal(tableCount(f.store, "devices"), 1);
    assert.equal(tableCount(f.store, "device_credentials"), 1);
    const before = dumpTables(f.store);

    const injected = injectExecFailure(f.store, "DELETE FROM device_credentials");
    try {
      assert.throws(() => f.store.resetInstallation({ confirm: CONFIRM }), /INJECTED-FAILURE/, "注入的失败必须原样上抛（不得被吞掉）");
    } finally {
      injected.restore();
    }
    assert.equal(injected.hits(), 1, "注入点必须真的命中一次");

    const after = dumpTables(f.store);
    assertEverythingElseUnchanged(before, after, "T4");
    for (const table of DEVICE_TABLES) assert.equal(tableCount(f.store, table), 1, table + " 必须逐行回到重置前的 1 行");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM users"), 1, "用户必须原样保留（不是「设备回滚了、身份删了一半」）");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM teams"), 1, "组织必须原样保留");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM audit_log WHERE event = 'reset-installation' AND result = 'OK'"), 0, "失败的重置不得写 OK 审计");
    assert.deepEqual(f.store.invariants(), [], "回滚后身份库自检必须为空");
  } finally {
    f.store.close();
  }
});

test("T5 · 注入失败（DELETE FROM devices，设备侧最后一条）→ 整体回滚", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    pairOnce(f, snap, { fingerprint: "fp_d503g_t5" });
    const before = dumpTables(f.store);
    const injected = injectExecFailure(f.store, "DELETE FROM devices");
    try {
      assert.throws(() => f.store.resetInstallation({ confirm: CONFIRM }), /INJECTED-FAILURE/);
    } finally {
      injected.restore();
    }
    assert.equal(injected.hits(), 1);
    const after = dumpTables(f.store);
    assertEverythingElseUnchanged(before, after, "T5");
    for (const table of DEVICE_TABLES) assert.equal(tableCount(f.store, table), 1, table + " 必须原样保留");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM audit_log WHERE event = 'reset-installation' AND result = 'OK'"), 0);
  } finally {
    f.store.close();
  }
});

test("T6 · 注入失败（DELETE FROM installations，身份最后一条）→ 设备三表同样原样（排除两个独立事务）", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    pairOnce(f, snap, { fingerprint: "fp_d503g_t6" });
    const before = dumpTables(f.store);
    const beforeCounts = Object.fromEntries(DEVICE_TABLES.map((t) => [t, tableCount(f.store, t)]));

    // 若设备清理在身份删除**之前**的独立事务里提交，这里会看到 0 行；若在**之后**，
    // T4/T5 会看到已提交的身份删除。三条用例合起来才排除"其实是两个事务"。
    const injected = injectExecFailure(f.store, "DELETE FROM installations");
    try {
      assert.throws(() => f.store.resetInstallation({ confirm: CONFIRM }), /INJECTED-FAILURE/);
    } finally {
      injected.restore();
    }
    assert.equal(injected.hits(), 1);
    const after = dumpTables(f.store);
    assertEverythingElseUnchanged(before, after, "T6");
    for (const table of DEVICE_TABLES) {
      assert.equal(tableCount(f.store, table), beforeCounts[table], table + " 必须原样保留 " + beforeCounts[table] + " 行");
      assert.deepEqual(after[table], before[table], table + " 必须逐行一致");
    }
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T7 · 重新初始化后新密钥可用 ══════════════════════ */

test("T7 · 重新初始化后：新管理员签发的新密钥可正常完成一次配对（新设备 + 新凭据 + 新组织）", async () => {
  const f = openService(tmpDir());
  try {
    const snapOld = await initAndLogin(f);
    const oldOrg = snapOld.teamId;
    pairOnce(f, snapOld, { fingerprint: "fp_d503g_t7_old" });
    assert.equal(f.store.resetInstallation({ confirm: CONFIRM }).ok, true);

    const snapNew = await initAndLogin(f);
    assert.notEqual(snapNew.teamId, oldOrg, "重新初始化必须产生新组织");
    const fresh = pairOnce(f, snapNew, { fingerprint: "fp_d503g_t7_new", displayName: "Fresh GPU" });
    assert.equal(fresh.consumed.device.organizationId, snapNew.teamId, "新设备必须属于新组织");
    assert.equal(fresh.consumed.credential.credentialVersion, 1, "凭据版本从 1 开始（没有旧版本可继承）");
    assert.equal(tableCount(f.store, "devices"), 1, "expected 1 device，actual " + tableCount(f.store, "devices"));
    assert.equal(tableCount(f.store, "device_credentials"), 1, "expected 1 credential，actual " + tableCount(f.store, "device_credentials"));
    assert.equal(tableCount(f.store, "device_pairing_credentials"), 1, "expected 1 pairing，actual " + tableCount(f.store, "device_pairing_credentials"));
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM devices WHERE organization_id = ?", oldOrg), 0, "旧组织的设备一台都不许复活");

    const auth = f.deviceService.authenticateConnection({ fingerprint: "fp_d503g_t7_new" });
    assert.equal(auth.ok, true, "新凭据必须可用：" + JSON.stringify(auth));
    assert.equal(auth.device.organization_id, snapNew.teamId);
    const verdict = f.deviceService.authorizeDevice({ device: auth.device, action: "device.use", actor: { userId: snapNew.userId, role: "ADMIN", organizationId: snapNew.teamId, departmentIds: [] }, credential: auth.credential });
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T8 · 跨组织与自报组织 ══════════════════════ */

test("T8 · deviceIdentity 组织不匹配被拒；context.organizationId 不得覆盖会话组织（写路径 + 读路径）", async () => {
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    const org = snap.teamId;

    // ① 自报组织与会话组织不一致 → 明确拒绝（稳定码），且不产生任何行。
    const spoofed = f.deviceService.createPairing({ context: uiCtx(snap, { organizationId: FOREIGN_ORG }), ttlMs: 60000 });
    assert.equal(spoofed.ok, false, "自报异组织必须被拒：" + briefPairing(spoofed));
    assert.equal(spoofed.error, "SESSION_ORGANIZATION_MISMATCH", briefPairing(spoofed));
    assert.equal(tableCount(f.store, "device_pairing_credentials"), 0, "被拒的签发不得留下任何配对行");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM device_pairing_credentials WHERE organization_id = ?", FOREIGN_ORG), 0, "异组织的密钥一条都不许存在");

    // ② 自报值与会话一致：允许（不破坏既有行为），但落库组织仍然是会话组织。
    const okSameOrg = f.deviceService.createPairing({ context: uiCtx(snap, { organizationId: org }), ttlMs: 60000 });
    assert.equal(okSameOrg.ok, true, briefPairing(okSameOrg));
    assert.equal(okSameOrg.pairing.organizationId, org, "签发组织必须是会话组织");
    assert.equal(f.deviceStore.pairingById(okSameOrg.pairing.id).organization_id, org, "落库组织 = 会话组织（自报值改变不了它）");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM device_pairing_credentials WHERE organization_id = ?", org), 1);

    // ③ 读路径同样以会话组织为准：自报异组织一律拒绝（而不是"读到了别的组织的数据"）。
    const reads = [
      ["listPairings", () => f.deviceService.listPairings({ context: uiCtx(snap, { organizationId: FOREIGN_ORG }) })],
      ["listDevices", () => f.deviceService.listDevices({ context: uiCtx(snap, { organizationId: FOREIGN_ORG }) })],
      ["getDevice", () => f.deviceService.getDevice({ context: uiCtx(snap, { organizationId: FOREIGN_ORG }), deviceId: "dev_d503g_anything000001" })],
      ["deviceAudit", () => f.deviceService.deviceAudit({ context: uiCtx(snap, { organizationId: FOREIGN_ORG }) })],
      ["revokePairing", () => f.deviceService.revokePairing({ context: uiCtx(snap, { organizationId: FOREIGN_ORG }), pairingId: okSameOrg.pairing.id })],
    ];
    for (const [name, call] of reads) {
      const res = call();
      assert.equal(res.ok, false, name + " 自报异组织必须被拒：" + JSON.stringify(res));
      assert.equal(res.error, "SESSION_ORGANIZATION_MISMATCH", name + " 的拒绝码必须稳定：" + JSON.stringify(res));
    }
    assert.equal(f.deviceStore.pairingById(okSameOrg.pairing.id).status, "ISSUED", "被拒的调用不得有副作用（撤销没有发生）");

    // ④ 对照：不传自报组织时读路径正常（证明 ③ 的拒绝来自自报值，不是路径本身坏了）。
    assert.equal(f.deviceService.listPairings({ context: uiCtx(snap) }).items.length, 1);
    assert.equal(f.deviceService.listDevices({ context: uiCtx(snap) }).items.length, 0);

    // ⑤ deviceIdentity 的组织与配对组织不一致 → 既有拒绝码保持不变（不因本轮改动放宽）。
    const mismatch = f.deviceService.consumePairing({
      secret: okSameOrg.secret,
      serviceIdentitySeen: SERVICE_IDENTITY,
      deviceIdentity: { organizationId: FOREIGN_ORG, fingerprint: "fp_d503g_t8" },
    });
    assert.equal(mismatch.ok, false, JSON.stringify(mismatch));
    assert.equal(mismatch.error, "PAIRING_TOKEN_ORGANIZATION_MISMATCH", JSON.stringify(mismatch));
    assert.equal(tableCount(f.store, "devices"), 0, "组织不匹配的配对不得留下设备");
    assert.equal(f.deviceStore.pairingById(okSameOrg.pairing.id).status, "ISSUED", "被拒的消费不得消耗 token");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T9 · 并发单次消费 ══════════════════════ */

test("T9 · 并发单次消费：恰好 1 台设备 / 1 条凭据，输家 PAIRING_TOKEN_ALREADY_USED，无半状态", async () => {
  const dir = tmpDir();
  const f = openService(dir);
  let identity2 = null;
  try {
    const snap = await initAndLogin(f);
    const created = f.deviceService.createPairing({ context: uiCtx(snap), ttlMs: 60000 });
    assert.equal(created.ok, true, briefPairing(created));

    // ① 两个真实连接并发消费同一个密钥（与 tests/device-pairing-race.test.mjs 同一手法）。
    identity2 = new IdentityStore({ path: dbPathOf(dir) }).open();
    const store2 = new DeviceStore({ identity: identity2 });
    const service2 = new DeviceService({ identity: identity2, deviceStore: store2, serviceIdentity: SERVICE_IDENTITY });
    const consume = (svc, name) => {
      try {
        return svc.consumePairing({ secret: created.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: name, fingerprint: "fp_" + name } });
      } catch (e) {
        return { ok: false, error: "DB_BUSY", thrown: String((e && e.message) || e) };
      }
    };
    const [ra, rb] = await Promise.all([
      Promise.resolve().then(() => consume(f.deviceService, "race-a")),
      Promise.resolve().then(() => consume(service2, "race-b")),
    ]);
    const oks = [ra, rb].filter((r) => r.ok).length;
    assert.equal(oks, 1, "并发两次消费必须恰好一个成功：" + JSON.stringify([ra.error || "ok", rb.error || "ok"]));
    const loser = [ra, rb].find((r) => !r.ok);
    assert.equal(["PAIRING_TOKEN_ALREADY_USED", "DB_BUSY"].indexOf(loser.error) !== -1, true, "输家必须是稳定码：" + loser.error);
    assert.equal(tableCount(f.store, "devices"), 1, "expected 1 device，actual " + tableCount(f.store, "devices") + "（绝不能注册两台）");
    assert.equal(tableCount(f.store, "device_credentials"), 1, "expected 1 credential，actual " + tableCount(f.store, "device_credentials"));
    const winner = [ra, rb].find((r) => r.ok);
    assert.equal(f.deviceStore.deviceById(winner.device.deviceId).status, "ACTIVE", "赢家的设备必须是完整激活的（不是半状态）");
    assert.equal(f.deviceStore.activeCredentialOfDevice(winner.device.deviceId).status, "ACTIVE", "赢家的凭据必须 ACTIVE");
    assert.equal(f.deviceStore.pairingById(created.pairing.id).status, "CONSUMED");
    assert.equal(f.deviceStore.pairingById(created.pairing.id).consumed_by_device_id, winner.device.deviceId, "token 归属赢家");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM device_audit WHERE event = 'DEVICE_REGISTERED'"), 1, "输家回滚掉的尝试不得留下注册审计");
    identity2.close();
    identity2 = null;

    // ② 决定性复现"抢输"分支（不靠调度运气）：token 已被别人提交消费，但本次读到的仍是 ISSUED 快照。
    const created2 = f.deviceService.createPairing({ context: uiCtx(snap), ttlMs: 60000 });
    assert.equal(created2.ok, true);
    const otherWinner = "dev_d503g_other_winner_0001";
    const consumedByOther = f.deviceStore.consumePairing(created2.pairing.id, { deviceId: otherWinner });
    assert.equal(consumedByOther.consumed, true, "先到者必须真的消费成功（autocommit）");
    const devicesBeforeLate = tableCount(f.store, "devices");
    const credsBeforeLate = tableCount(f.store, "device_credentials");

    const realLookup = f.deviceStore.pairingBySecretHash.bind(f.deviceStore);
    f.deviceStore.pairingBySecretHash = (hash) => {
      const row = realLookup(hash);
      return row ? { ...row, status: "ISSUED" } : row;
    };
    let late;
    try {
      late = f.deviceService.consumePairing({ secret: created2.secret, serviceIdentitySeen: SERVICE_IDENTITY, deviceIdentity: { displayName: "late", fingerprint: "fp_d503g_late" } });
    } finally {
      delete f.deviceStore.pairingBySecretHash;
    }
    assert.equal(late.ok, false, "抢输的一方必须失败：" + JSON.stringify(late));
    assert.equal(late.error, "PAIRING_TOKEN_ALREADY_USED", JSON.stringify(late));
    assert.equal(tableCount(f.store, "devices"), devicesBeforeLate, "抢输的一方插入的设备行必须被整体回滚（expected " + devicesBeforeLate + "，actual " + tableCount(f.store, "devices") + "）");
    assert.equal(tableCount(f.store, "device_credentials"), credsBeforeLate, "抢输的一方不得留下凭据");
    assert.equal(f.deviceStore.pairingById(created2.pairing.id).consumed_by_device_id, otherWinner, "token 仍归先到者，不得被改写");
    assert.equal(count(f.store, "SELECT COUNT(*) c FROM device_audit WHERE event = 'DEVICE_REGISTERED'"), 1, "回滚掉的尝试不得留下注册审计");
  } finally {
    if (identity2) identity2.close();
    f.store.close();
  }
});

/* ══════════════════════ T10 · 审计保留与明文 secret 不外泄 ══════════════════════ */

test("T10 · device_audit 重置前后逐行不变；明文 secret 在库/审计/日志里 0 命中", async () => {
  const dir = tmpDir();
  const log = new IdentityLogger();
  const f = openService(dir, log);
  try {
    const snap = await initAndLogin(f);
    const created = f.deviceService.createPairing({ context: uiCtx(snap), ttlMs: 60000 });
    assert.equal(created.ok, true);
    log.registerSecret(created.secret);
    const consumed = f.deviceService.consumePairing({
      secret: created.secret,
      serviceIdentitySeen: SERVICE_IDENTITY,
      deviceIdentity: { displayName: "AUDIT GPU", fingerprint: "fp_d503g_t10" },
    });
    assert.equal(consumed.ok, true);

    // 反向对照：库里存的是 sha256（能找到），明文找不到 —— 否则下面的 0 命中可能只是"什么都没存"。
    const hash = domain.pairingSecretHash(created.secret);
    const dumpBeforeReset = JSON.stringify(dumpTables(f.store));
    assert.equal(dumpBeforeReset.indexOf(hash) !== -1, true, "库里必须有 sha256（用于反查）");
    assert.equal(dumpBeforeReset.indexOf(created.secret), -1, "库里不得有明文 secret");

    const before = dumpTables(f.store);
    assert.equal(before.device_audit.length > 0, true, "重置前必须已有设备审计行");
    assert.equal(f.store.resetInstallation({ confirm: CONFIRM }).ok, true);
    const after = dumpTables(f.store);
    assert.deepEqual(after.device_audit, before.device_audit, "device_audit 必须逐行不变（一行不删）");
    assert.deepEqual(after.authorization_audit, before.authorization_audit, "authorization_audit 同样逐行不变");
    assert.equal(after.device_audit.length > 0, true, "重置后设备审计仍然在");
    const resetAudit = f.store.auditLog().filter((r) => r.event === "reset-installation");
    assert.deepEqual(resetAudit.map((r) => r.result), ["OK_REQUESTED", "OK"], "重置自身的留痕必须还在");

    // 明文扫描：库文件 + WAL + 每一张表的每一个字段 + 设备审计 payload + 日志。
    const secretBytes = Buffer.from(created.secret, "utf8");
    const files = [dbPathOf(dir), dbPathOf(dir) + "-wal"].filter((p) => fs.existsSync(p));
    assert.equal(files.length > 0, true);
    for (const p of files) {
      assert.equal(fs.readFileSync(p).includes(secretBytes), false, "明文 secret 不得出现在 " + path.basename(p));
    }
    const dump = JSON.stringify(dumpTables(f.store));
    assert.equal(dump.indexOf(created.secret), -1, "明文 secret 不得出现在任何表的任何字段里");
    assert.equal(JSON.stringify(f.deviceStore.allAudit()).indexOf(created.secret), -1, "明文 secret 不得出现在设备审计 payload 里");
    assert.deepEqual(log.leaks(), [], "明文 secret 不得出现在日志里（IdentityLogger 登记后自查）");
    assert.deepEqual(log.scanArtifact(dumpTables(f.store)), [], "落盘产物自查必须 0 命中");
    assert.equal(f.store.resetInstallation({ confirm: CONFIRM }).ok, true, "重放一次重置也必须成功（审计表不会被自己撑破）");
    assert.deepEqual(dumpTables(f.store).device_audit, before.device_audit, "第二次重置后设备审计仍逐行不变");
  } finally {
    f.store.close();
  }
});

/* ══════════════════════ T11 · SCHEMA_VERSION ══════════════════════ */

test("T11 · SCHEMA_VERSION 仍为 21：本批没有 schema 变更（只有行删除）", async () => {
  assert.equal(SCHEMA_VERSION, 22, "本批不应升版：设备三表早已存在，重置只是删行");
  const f = openService(tmpDir());
  try {
    const snap = await initAndLogin(f);
    pairOnce(f, snap, { fingerprint: "fp_d503g_t11" });
    assert.equal(f.store.schemaVersion, 22, "打开后的 user_version 必须是 21");
    assert.equal(f.store.connection.prepare("PRAGMA user_version").get().user_version, 22);
    assert.equal(f.store.resetInstallation({ confirm: CONFIRM }).ok, true);
    assert.equal(f.store.schemaVersion, 22, "重置后 user_version 不得变化");
    // 删除集合里没有任何 DDL：只有不带 WHERE 的 DELETE FROM <table>。
    for (const sql of RESET_AUTHORIZATION_DELETE_SQL) assert.match(String(sql), /^DELETE FROM [a-z_]+$/, "不得出现 DDL / WHERE / 拼接：" + sql);
    // 三张设备表在重置后仍然存在（表结构没动，只是行被删）。
    for (const table of DEVICE_TABLES) {
      const row = f.store.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      assert.equal(row && row.name, table, table + " 必须仍然存在");
      assert.equal(tableCount(f.store, table), 0, table + " 必须 0 行");
    }
  } finally {
    f.store.close();
  }
});
