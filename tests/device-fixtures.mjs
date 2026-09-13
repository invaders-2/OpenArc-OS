/**
 * D3-03 测试夹具。
 *
 * 所有 device-*.test.mjs 共用这一份场景，保证"测的这条线"就是同一套
 * IdentityStore + AuthorizationStore + AuthorizationService + DeviceStore + DeviceService。
 *
 * 场景：
 *   Organization A（D3-01 root team，admin 即 Super Admin）
 *   ├── Department A「Design」：alice(member)、dana(department-admin)
 *   └── alice 的会话用于"普通用户"用例
 *   Organization B（另一个 team）：bob —— cross-organization 用例
 *
 * 时钟：**注入的可控时钟**（§37）。所有过期/心跳/离线语义都必须用 advance() 推进，
 * 不允许任何测试依赖 wall clock。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const { DeviceStore } = require("../electron/device-store.cjs");
const { DeviceService } = require("../electron/device-service.cjs");

export const deviceDomain = require("../electron/device-domain.cjs");
export const pw = (name) => name + "-password-1";

const START = 1700000000000;

/** 每个测试独立的临时库路径（迁移/回滚用例需要真实文件）。 */
export function tempDbPath(name = "openarc-d3-03") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name + "-"));
  return path.join(dir, "identity.sqlite");
}

export const SERVICE_IDENTITY = "svc_openarc-control-test0001";

/**
 * 建立一个完整场景。
 * @returns { identity, store, authService, deviceStore, deviceService, sessions, users,
 *            orgId, foreignOrgId, serviceIdentity, now, advance, ctx, adminCtx }
 */
export async function createDeviceFixture({ dbPath = ":memory:", serviceIdentity = SERVICE_IDENTITY, deviceServiceFactory = null } = {}) {
  let current = START;
  const clock = () => current;

  const identity = new IdentityStore({ path: dbPath, clock }).open();
  const store = new AuthorizationStore({ identity, clock });
  const authService = new AuthorizationService({ identity, authStore: store });
  const deviceStore = new DeviceStore({ identity, clock });
  const deviceService =
    typeof deviceServiceFactory === "function"
      ? deviceServiceFactory({ identity, deviceStore, authService, clock, serviceIdentity })
      : new DeviceService({ identity, deviceStore, authService, clock, serviceIdentity });

  await identity.initialize({ identifier: "admin@openarc.test", password: pw("admin"), displayName: "Admin" });
  const adminLogin = await identity.login({ identifier: "admin@openarc.test", password: pw("admin") });
  const admin = adminLogin.user;
  const orgId = admin.team_id;

  const created = {};
  for (const key of ["alice", "dana"]) {
    const res = await identity.createUser({ identifier: key + "@openarc.test", password: pw(key), displayName: key, teamId: orgId });
    if (!res.ok) throw new Error("createUser " + key + " failed: " + res.error);
    created[key] = res.userId;
  }

  // 另一个组织（D3-01 用 teams 承载 organizationId）
  const foreignOrgId = "team_foreign0000000000001";
  identity.connection.prepare("INSERT INTO teams (id, name, root, created_at) VALUES (?, 'Foreign Workspace', 0, ?)").run(foreignOrgId, current);
  const bobRes = await identity.createUser({ identifier: "bob@foreign.test", password: pw("bob"), displayName: "bob", teamId: foreignOrgId });
  if (!bobRes.ok) throw new Error("createUser bob failed: " + bobRes.error);
  created.bob = bobRes.userId;

  created.admin = admin.id;
  const sessions = { admin: adminLogin.session.ref };
  for (const key of ["alice", "dana", "bob"]) {
    const login = await identity.login({ identifier: (key === "bob" ? "bob@foreign.test" : key + "@openarc.test"), password: pw(key) });
    if (!login.ok) throw new Error("login " + key + " failed: " + login.error);
    sessions[key] = login.session.ref;
  }

  const deptA = authService.createDepartment({ context: { sessionRef: sessions.admin, appId: "resource-library" }, name: "Design" });
  if (!deptA.ok) throw new Error("createDepartment failed");
  authService.addDepartmentMember({ context: { sessionRef: sessions.admin, appId: "resource-library" }, departmentId: deptA.department.id, userId: created.alice, membershipRole: "member" });
  authService.addDepartmentMember({ context: { sessionRef: sessions.admin, appId: "resource-library" }, departmentId: deptA.department.id, userId: created.dana, membershipRole: "department-admin" });

  const ctx = (key, extra = {}) => ({ sessionRef: sessions[key], appId: "resource-library", source: "ui", ...extra });
  const adminCtx = (extra = {}) => ctx("admin", extra);

  return {
    identity,
    store,
    authService,
    deviceStore,
    deviceService,
    sessions,
    users: created,
    orgId,
    foreignOrgId,
    departmentId: deptA.department.id,
    serviceIdentity,
    clock,
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
    ctx,
    adminCtx,
  };
}

/** 走一遍真实配对，返回注册好的设备 + 凭据元数据。 */
export async function pairDevice(fx, { displayName = "Design GPU 1", platform = "darwin", architecture = "arm64", fingerprint = null, ttlMs = 60000, departmentId = null, identityExtra = {} } = {}) {
  const created = fx.deviceService.createPairing({ context: fx.adminCtx(), ttlMs, departmentId });
  if (!created.ok) throw new Error("createPairing failed: " + created.error);
  const fp = fingerprint || "fp_" + fx.deviceStore.allDevices().length + "_" + Math.random().toString(36).slice(2, 10);
  const res = fx.deviceService.consumePairing({
    secret: created.secret,
    serviceIdentitySeen: fx.serviceIdentity,
    deviceIdentity: {
      displayName,
      platform,
      architecture,
      fingerprint: fp,
      subject: "CN=" + displayName,
      notAfter: fx.now() + 90 * 24 * 3600 * 1000,
      ...identityExtra,
    },
  });
  if (!res.ok) throw new Error("consumePairing failed: " + res.error);
  return { ...res, fingerprint: fp, secret: created.secret, pairingId: created.pairing.id };
}
