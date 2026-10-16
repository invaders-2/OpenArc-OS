/**
 * 文件传输域移植回归测试（全离线：假 ipcMain / 假授权 / 临时 userData，不启动 Electron、不联网）。
 *
 * 覆盖任务书验收条目：
 *   ① 分片顺序写入（offset 推进）→ complete 后 sha256 校验通过
 *   ② 乱序 / 越界 / 超块 / 非法 offset 一律拒绝
 *   ③ 超过 8GiB 拒绝（含 0 / 非整型 / 8GiB+1）
 *   ④ complete 的 sha256 与本地 createHash 对照一致
 *   ⑤ 哈希不符拒绝（块哈希 / 整文件哈希 / 非法哈希形态）
 *   ⑥ TTL 过期后不可用（status / chunk / complete 全部 404）+ cleanup 回收
 *   ⑦ 路径穿越被拒（非 UUID id / '..' / 绝对路径）+ 落盘固定在 <userData>/dxos 之下
 *   附加：busy 互斥、配额、preview 16MiB、cancel、未认证、trusted fail-closed、
 *         孤儿暂存回收、scope 保留、use 内部消费。
 *
 * 只读源：server/fileTransfers.ts、server/fileTransferRoutes.ts。
 * 行号引用见 electron/file-transfer-{domain,service,bootstrap}.cjs 顶部注释。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const domain = require("../electron/file-transfer-domain.cjs");
const { createFileTransferBundle, DiskTransfers, resolveTransferRoot } = require("../electron/file-transfer-service.cjs");
const { registerFileTransferIpc, disposeFileTransferIpc, FILE_TRANSFER_CHANNEL, FILE_TRANSFER_NOT_READY } = require("../electron/file-transfer-bootstrap.cjs");

const {
  TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES, TRANSFER_TTL_MS, PREVIEW_MAX_BYTES,
  FILE_TRANSFER_ERR_INVALID_INPUT, FILE_TRANSFER_ERR_NOT_FOUND, FILE_TRANSFER_ERR_CONFLICT,
  FILE_TRANSFER_ERR_QUOTA_EXCEEDED, FILE_TRANSFER_ERR_PATH_ESCAPE, FILE_TRANSFER_ERR_UNAUTHENTICATED,
  FILE_TRANSFER_ERR_COMMAND_NOT_ALLOWED,
} = domain;

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tmpUserData(prefix = "dxos-file-transfer-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 假 ipcMain：与 Electron 同形（handle / removeHandler / invoke）。 */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error("重复注册 handler：" + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("没有 handler：" + channel);
      return fn(event, raw);
    },
  };
}

const TRUSTED_EVENT = { sender: "shell", senderFrame: { url: "file:///app/dist/index.html" } };
const makeAuth = (actorId = "u1") => ({ resolveActor: () => ({ ok: true, user: { id: actorId, role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) });

function makeHarness({ userDataDir = tmpUserData(), authorization = makeAuth(), clock = null, actorId = null } = {}) {
  const dir = userDataDir;
  const bundle = createFileTransferBundle({ userDataDir: dir, authorization, clock });
  const ipcMain = fakeIpcMain();
  registerFileTransferIpc(ipcMain, { bundle, identity: { current: "session-1" }, isTrusted: (event) => !!event && event.sender === "shell" });
  const call = (command, payload) => ipcMain.invoke(FILE_TRANSFER_CHANNEL, TRUSTED_EVENT, { command, payload });
  return { dir, bundle, ipcMain, call, actorId: actorId || "u1" };
}

/** 生命周期：begin(scope) → 顺序写完整块 → 返回 { id, data, sha256 }。 */
async function beginAndUpload(call, data, scopeOverrides = {}) {
  const begin = await call("fileTransfer/begin", {
    projectId: "proj-1", revision: 7, kind: "source", name: "设计稿.psd",
    size: data.length, ...scopeOverrides,
  });
  assert.equal(begin.ok, true, JSON.stringify(begin));
  const id = begin.value.id;
  let offset = 0;
  const chunkSize = scopeOverrides.chunkSize || Math.max(1, Math.min(3, data.length));
  while (offset < data.length) {
    const bytes = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    const chunk = await call("fileTransfer/chunk", { id, offset, bytes });
    assert.equal(chunk.ok, true, JSON.stringify(chunk));
    offset += bytes.length;
  }
  return { id, data, sha256: createHash("sha256").update(data).digest("hex") };
}

const b = (...values) => Buffer.from(values.join(""));

// ---------------------------------------------------------------------------
// ① 分片顺序写入 → complete 后 sha256 校验通过
// ---------------------------------------------------------------------------

test("分片顺序写入：offset 逐块推进，complete 后 sha256 与本地 createHash 一致", async () => {
  const h = makeHarness();
  const data = Buffer.from("OpenArc file transfer 0.6.1");
  const { id, sha256 } = await beginAndUpload(h.call, data);

  const status = await h.call("fileTransfer/status", { id });
  assert.equal(status.ok, true);
  assert.equal(status.value.offset, data.length);
  assert.equal(status.value.size, data.length);
  assert.equal(status.value.chunkBytes, TRANSFER_CHUNK_BYTES);
  assert.equal(status.value.sha256, undefined, "未 complete 前不得有整文件哈希");

  const complete = await h.call("fileTransfer/complete", { id, sha256 });
  assert.equal(complete.ok, true, JSON.stringify(complete));
  assert.equal(complete.value.sha256, sha256);
  assert.equal(complete.value.offset, data.length);

  // 真实落盘：暂存文件内容 = 原始字节，且固定落在 <userData>/dxos/file-transfers。
  const onDisk = path.join(h.dir, "dxos", "file-transfers", id + ".part");
  assert.equal(fs.readFileSync(onDisk).equals(data), true);
  assert.equal(h.bundle.root, path.join(h.dir, "dxos", "file-transfers"));
});

test("chunk 幂等重放：同 offset/同字节不重复推进 offset", async () => {
  const h = makeHarness();
  const begin = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 8 });
  const id = begin.value.id;
  const first = await h.call("fileTransfer/chunk", { id, offset: 0, bytes: b("abcd") });
  assert.equal(first.value.offset, 4);
  const replay = await h.call("fileTransfer/chunk", { id, offset: 0, bytes: b("abcd") });
  assert.equal(replay.ok, true);
  assert.equal(replay.value.offset, 4, "重放不得推进 offset");
});

test("base64 通道：encoding=base64 的 data 与二进制 bytes 等价", async () => {
  const h = makeHarness();
  const data = Buffer.from("base64-payload");
  const begin = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: data.length });
  const id = begin.value.id;
  const chunk = await h.call("fileTransfer/chunk", { id, offset: 0, data: data.toString("base64"), encoding: "base64" });
  assert.equal(chunk.ok, true, JSON.stringify(chunk));
  const complete = await h.call("fileTransfer/complete", { id, sha256: createHash("sha256").update(data).digest("hex") });
  assert.equal(complete.ok, true);
  assert.equal(fs.readFileSync(path.join(h.bundle.root, id + ".part")).toString(), "base64-payload");
});

// ---------------------------------------------------------------------------
// ② 乱序 / 越界 / 超块 / 非法 offset
// ---------------------------------------------------------------------------

test("乱序拒绝：offset 不等于当前进度回 CONFLICT(409)", async () => {
  const h = makeHarness();
  const begin = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 10 });
  const id = begin.value.id;
  const outOfOrder = await h.call("fileTransfer/chunk", { id, offset: 4, bytes: b("456789") });
  assert.equal(outOfOrder.ok, false);
  assert.equal(outOfOrder.error, FILE_TRANSFER_ERR_CONFLICT);
  // 拒绝后进度不变，补上正确块即可继续（断线重连语义）。
  const ok = await h.call("fileTransfer/chunk", { id, offset: 0, bytes: b("0123") });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.offset, 4);
});

test("越界 / 超块 / 非法 offset 一律 INVALID_INPUT", async () => {
  const h = makeHarness();
  const begin = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 8 });
  const id = begin.value.id;

  const overflow = await h.call("fileTransfer/chunk", { id, offset: 4, bytes: b("12345") });
  assert.equal(overflow.error, FILE_TRANSFER_ERR_INVALID_INPUT, "offset+length 超过 size");

  const negative = await h.call("fileTransfer/chunk", { id, offset: -1, bytes: b("12") });
  assert.equal(negative.error, FILE_TRANSFER_ERR_INVALID_INPUT);

  const notInteger = await h.call("fileTransfer/chunk", { id, offset: 1.5, bytes: b("12") });
  assert.equal(notInteger.error, FILE_TRANSFER_ERR_INVALID_INPUT);

  const empty = await h.call("fileTransfer/chunk", { id, offset: 0, bytes: Buffer.alloc(0) });
  assert.equal(empty.error, FILE_TRANSFER_ERR_INVALID_INPUT);

  // 超单块上限：size 直接给 CHUNK+1，块长度 CHUNK+1 必须被拒（源 fileTransfers.ts:51）。
  const bigSize = TRANSFER_CHUNK_BYTES + 1;
  const bigBegin = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "big.psd", size: bigSize });
  assert.equal(bigBegin.ok, true);
  const tooBig = await h.call("fileTransfer/chunk", { id: bigBegin.value.id, offset: 0, bytes: Buffer.alloc(bigSize, 1) });
  assert.equal(tooBig.error, FILE_TRANSFER_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// ③ 大小上限
// ---------------------------------------------------------------------------

test("超过 8GiB / 0 / 非整型大小在 begin 即拒绝", async () => {
  const h = makeHarness();
  const scope = { projectId: "p", revision: 1, kind: "source", name: "a.psd" };

  const tooBig = await h.call("fileTransfer/begin", { ...scope, size: TRANSFER_MAX_BYTES + 1 });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error, FILE_TRANSFER_ERR_INVALID_INPUT, "必须拒绝 > 8GiB");

  const zero = await h.call("fileTransfer/begin", { ...scope, size: 0 });
  assert.equal(zero.error, FILE_TRANSFER_ERR_INVALID_INPUT);

  const fractional = await h.call("fileTransfer/begin", { ...scope, size: 1.5 });
  assert.equal(fractional.error, FILE_TRANSFER_ERR_INVALID_INPUT);

  const unsafe = await h.call("fileTransfer/begin", { ...scope, size: Number.MAX_SAFE_INTEGER + 2 });
  assert.equal(unsafe.error, FILE_TRANSFER_ERR_INVALID_INPUT);

  // 恰好 8GiB 是允许的（只是不真的传）。
  const exactly = await h.call("fileTransfer/begin", { ...scope, size: TRANSFER_MAX_BYTES });
  assert.equal(exactly.ok, true, JSON.stringify(exactly));
  assert.equal(exactly.value.size, TRANSFER_MAX_BYTES);
});

test("preview 用途：kind=preview 超过 16MiB 拒绝（源 fileTransferRoutes.ts:32-33）", async () => {
  const h = makeHarness();
  const tooBig = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "preview", name: "preview.png", size: PREVIEW_MAX_BYTES + 1 });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error, FILE_TRANSFER_ERR_INVALID_INPUT);
  const badKind = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "other", name: "x", size: 1 });
  assert.equal(badKind.error, FILE_TRANSFER_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// ⑤ 哈希不符 / 非法哈希形态
// ---------------------------------------------------------------------------

test("块哈希不符拒绝：expectedHash 与实测不一致回 INVALID_INPUT，且不推进 offset", async () => {
  const h = makeHarness();
  const begin = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 4 });
  const id = begin.value.id;
  const wrong = "0".repeat(64);
  const res = await h.call("fileTransfer/chunk", { id, offset: 0, bytes: b("abcd"), expectedHash: wrong });
  assert.equal(res.ok, false);
  assert.equal(res.error, FILE_TRANSFER_ERR_INVALID_INPUT);
  const status = await h.call("fileTransfer/status", { id });
  assert.equal(status.value.offset, 0, "校验失败不得推进进度");
});

test("整文件哈希不符拒绝；非法哈希形态拒绝；complete 幂等", async () => {
  const h = makeHarness();
  const data = Buffer.from("hash-check");
  const { id, sha256 } = await beginAndUpload(h.call, data);

  const malformed = await h.call("fileTransfer/complete", { id, sha256: "xyz" });
  assert.equal(malformed.error, FILE_TRANSFER_ERR_INVALID_INPUT);

  const mismatched = await h.call("fileTransfer/complete", { id, sha256: "1".repeat(64) });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.error, FILE_TRANSFER_ERR_INVALID_INPUT);

  const good = await h.call("fileTransfer/complete", { id, sha256 });
  assert.equal(good.ok, true);
  const again = await h.call("fileTransfer/complete", { id, sha256 });
  assert.equal(again.ok, true, "complete 幂等");
  assert.equal(again.value.sha256, sha256);

  const afterComplete = await h.call("fileTransfer/chunk", { id, offset: data.length, bytes: b("x") });
  assert.equal(afterComplete.error, FILE_TRANSFER_ERR_INVALID_INPUT, "封存后不得再写块");
});

test("未传满即 complete 回 CONFLICT(409)", async () => {
  const h = makeHarness();
  const begin = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 8 });
  const id = begin.value.id;
  const partial = await h.call("fileTransfer/chunk", { id, offset: 0, bytes: b("abcd") });
  assert.equal(partial.value.offset, 4);
  const early = await h.call("fileTransfer/complete", { id });
  assert.equal(early.ok, false);
  assert.equal(early.error, FILE_TRANSFER_ERR_CONFLICT);
});

// ---------------------------------------------------------------------------
// ⑥ TTL 过期 + cleanup
// ---------------------------------------------------------------------------

test("TTL 过期后不可用（status/chunk/complete 全部 404），cleanup 回收暂存文件", async () => {
  const box = { now: 1_700_000_000_000 };
  const h = makeHarness({ clock: () => box.now });
  const data = Buffer.from("expires");
  const { id } = await beginAndUpload(h.call, data);
  const partPath = path.join(h.bundle.root, id + ".part");
  assert.equal(fs.existsSync(partPath), true);

  assert.equal((await h.call("fileTransfer/status", { id })).ok, true, "TTL 内可用");

  box.now += TRANSFER_TTL_MS + 1;
  const expiredStatus = await h.call("fileTransfer/status", { id });
  assert.equal(expiredStatus.ok, false);
  assert.equal(expiredStatus.error, FILE_TRANSFER_ERR_NOT_FOUND);
  const expiredChunk = await h.call("fileTransfer/chunk", { id, offset: 0, bytes: b("zz") });
  assert.equal(expiredChunk.error, FILE_TRANSFER_ERR_NOT_FOUND);
  const expiredComplete = await h.call("fileTransfer/complete", { id });
  assert.equal(expiredComplete.error, FILE_TRANSFER_ERR_NOT_FOUND);
  assert.equal(fs.existsSync(partPath), true, "仅查询过期不会顺手删文件");

  const cleanup = await h.call("fileTransfer/cleanup", {});
  assert.equal(cleanup.ok, true, JSON.stringify(cleanup));
  assert.equal(cleanup.value.removed, 1);
  assert.equal(cleanup.value.sessions, 0);
  assert.equal(fs.existsSync(partPath), false, "cleanup 必须回收过期暂存文件");
});

test("cleanup 不误删未过期会话；显式回收重启遗留的孤儿暂存（mtime 超 TTL）", async () => {
  const h = makeHarness();
  const data = Buffer.from("keep");
  const { id } = await beginAndUpload(h.call, data);

  const noop = await h.call("fileTransfer/cleanup", {});
  assert.equal(noop.value.removed, 0);
  assert.equal((await h.call("fileTransfer/status", { id })).ok, true);

  // 模拟上次进程遗留：UUID 命名 .part（源 fileTransfers.ts:108-115 只回收这种命名）。
  fs.mkdirSync(h.bundle.root, { recursive: true });
  const orphan = path.join(h.bundle.root, randomUUID() + ".part");
  fs.writeFileSync(orphan, "orphan");
  const old = (Date.now() - TRANSFER_TTL_MS - 60_000) / 1000;
  fs.utimesSync(orphan, old, old);
  const fresh = path.join(h.bundle.root, randomUUID() + ".part");
  fs.writeFileSync(fresh, "fresh");
  const notOurs = path.join(h.bundle.root, "notes.txt");
  fs.writeFileSync(notOurs, "keep me");
  fs.utimesSync(notOurs, old, old);

  const cleanup = await h.call("fileTransfer/cleanup", {});
  assert.equal(cleanup.value.removed, 1, "只回收超 TTL 的 UUID 暂存");
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(fresh), true, "未超 TTL 的孤儿保留");
  assert.equal(fs.existsSync(notOurs), true, "非本域命名一律不碰");
  assert.equal((await h.call("fileTransfer/status", { id })).ok, true, "活跃会话不受清理影响");
});

// ---------------------------------------------------------------------------
// ⑦ 路径穿越 + 落盘根围栏
// ---------------------------------------------------------------------------

test("路径穿越被拒：非 UUID id / '..' / 绝对路径在拼路径前就被拦", () => {
  const dir = tmpUserData();
  const root = resolveTransferRoot(dir);
  assert.equal(root, path.join(dir, "dxos", "file-transfers"));
  assert.equal(domain.isContainedPath(path.join(dir, "dxos"), root), true);

  for (const bad of ["../../evil", "..", "/etc/passwd", "C:\\Windows\\evil", "a/b", randomUUID() + "/../x"]) {
    assert.throws(() => domain.resolveStagingPath(root, bad), (error) => error.code === FILE_TRANSFER_ERR_PATH_ESCAPE, "必须拒绝：" + bad);
  }
  const good = domain.resolveStagingPath(root, randomUUID());
  assert.equal(domain.isContainedPath(root, good), true);
  assert.equal(path.dirname(good), root);

  // name 只做字符清洗、不进路径；额外要求清洗后没有路径段。
  assert.equal(domain.sanitizeTransferName("../../evil.psd"), ".._.._evil.psd");
  assert.throws(() => domain.sanitizeTransferName(".."), (error) => error.code === FILE_TRANSFER_ERR_INVALID_INPUT);
  assert.throws(() => domain.sanitizeTransferName(""), (error) => error.code === FILE_TRANSFER_ERR_INVALID_INPUT);
});

test("经 IPC 的越界 id 只回 NOT_FOUND，不产生任何越界落盘", async () => {
  const h = makeHarness();
  const outside = path.join(h.dir, "dxos", "evil");
  const chunk = await h.call("fileTransfer/chunk", { id: "../../evil", offset: 0, bytes: b("x") });
  assert.equal(chunk.ok, false);
  assert.equal(chunk.error, FILE_TRANSFER_ERR_NOT_FOUND);
  const status = await h.call("fileTransfer/status", { id: "/etc/passwd" });
  assert.equal(status.error, FILE_TRANSFER_ERR_NOT_FOUND);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.existsSync(path.join(h.dir, "evil")), false);
});

test("createFileTransferBundle 拒绝空 userDataDir（不猜测落盘位置）", () => {
  assert.throws(() => createFileTransferBundle({ userDataDir: "" }), /userDataDir/);
  assert.throws(() => createFileTransferBundle({}), /userDataDir/);
});

// ---------------------------------------------------------------------------
// 附加：busy 互斥 / 配额 / cancel / 未认证 / trusted / 未登记命令 / scope+use
// ---------------------------------------------------------------------------

test("busy 互斥：同一传输在途块未落盘时，第二个块回 CONFLICT", async () => {
  const h = makeHarness();
  const begin = await h.call("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 8 });
  const id = begin.value.id;
  const inFlight = h.call("fileTransfer/chunk", { id, offset: 0, bytes: b("abcd") });
  const contended = await h.call("fileTransfer/chunk", { id, offset: 4, bytes: b("efgh") });
  assert.equal(contended.ok, false);
  assert.equal(contended.error, FILE_TRANSFER_ERR_CONFLICT);
  const first = await inFlight;
  assert.equal(first.ok, true);
  assert.equal(first.value.offset, 4);
});

test("配额：同一 owner 第 5 个活跃传输回 QUOTA_EXCEEDED(429)（源 fileTransfers.ts:35）", async () => {
  const h = makeHarness();
  const scope = { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 1 };
  for (let index = 0; index < domain.TRANSFER_MAX_OWNED; index += 1) {
    const res = await h.call("fileTransfer/begin", scope);
    assert.equal(res.ok, true, JSON.stringify(res));
  }
  const fifth = await h.call("fileTransfer/begin", scope);
  assert.equal(fifth.ok, false);
  assert.equal(fifth.error, FILE_TRANSFER_ERR_QUOTA_EXCEEDED);
  assert.equal(fifth.status, 429);
});

test("cancel 删除暂存文件；重复 cancel 回 NOT_FOUND", async () => {
  const h = makeHarness();
  const data = Buffer.from("cancel me");
  const { id } = await beginAndUpload(h.call, data);
  const partPath = path.join(h.bundle.root, id + ".part");
  const cancelled = await h.call("fileTransfer/cancel", { id });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.value.cancelled, true);
  assert.equal(fs.existsSync(partPath), false);
  const again = await h.call("fileTransfer/cancel", { id });
  assert.equal(again.error, FILE_TRANSFER_ERR_NOT_FOUND);
});

test("未认证：缺授权服务 / resolveActor 失败一律 UNAUTHENTICATED，不落盘", async () => {
  const dir = tmpUserData();
  const noAuth = createFileTransferBundle({ userDataDir: dir });
  const denied = await noAuth.execute("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 1 }, { sessionRef: "s" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, FILE_TRANSFER_ERR_UNAUTHENTICATED);

  const failing = createFileTransferBundle({ userDataDir: dir, authorization: { resolveActor: () => ({ ok: false, error: "SESSION_REVOKED" }) } });
  const revoked = await failing.execute("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 1 }, { sessionRef: "s" });
  assert.equal(revoked.error, FILE_TRANSFER_ERR_UNAUTHENTICATED);
  assert.equal(fs.existsSync(path.join(dir, "dxos", "file-transfers")), false, "未认证不得创建落盘目录");
});

test("trusted fail-closed：缺 isTrusted / 事件不信任一律 Forbidden；未登记命令被拒", async () => {
  const dir = tmpUserData();
  const bundle = createFileTransferBundle({ userDataDir: dir, authorization: makeAuth() });

  const noTrust = fakeIpcMain();
  registerFileTransferIpc(noTrust, { bundle });
  await assert.rejects(() => noTrust.invoke(FILE_TRANSFER_CHANNEL, TRUSTED_EVENT, { command: "fileTransfer/health" }), /Forbidden/);

  const strict = fakeIpcMain();
  registerFileTransferIpc(strict, { bundle, isTrusted: () => false });
  await assert.rejects(() => strict.invoke(FILE_TRANSFER_CHANNEL, TRUSTED_EVENT, { command: "fileTransfer/health" }), /Forbidden/);

  const h = makeHarness({ userDataDir: dir });
  const unknown = await h.call("fileTransfer/nope", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, FILE_TRANSFER_ERR_COMMAND_NOT_ALLOWED);

  const notObject = await h.ipcMain.invoke(FILE_TRANSFER_CHANNEL, TRUSTED_EVENT, null);
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error, FILE_TRANSFER_ERR_INVALID_INPUT);
});

test("未装配 bundle 回 FILE_TRANSFER_NOT_READY；可重复注册与 dispose", async () => {
  const ipcMain = fakeIpcMain();
  const registered = registerFileTransferIpc(ipcMain, { bundle: null, isTrusted: () => true });
  const notReady = await ipcMain.invoke(FILE_TRANSFER_CHANNEL, TRUSTED_EVENT, { command: "fileTransfer/health" });
  assert.deepEqual(notReady, { ok: false, error: FILE_TRANSFER_NOT_READY, message: "文件传输域尚未装配" });
  assert.equal(registered.channel, FILE_TRANSFER_CHANNEL);

  const dir = tmpUserData();
  const bundle = createFileTransferBundle({ userDataDir: dir, authorization: makeAuth() });
  registerFileTransferIpc(ipcMain, { bundle, isTrusted: () => true }); // 重复注册必须成功
  const health = await ipcMain.invoke(FILE_TRANSFER_CHANNEL, TRUSTED_EVENT, { command: "fileTransfer/health" });
  assert.equal(health.ok, true);
  assert.equal(health.value.directory, "dxos/file-transfers");
  assert.equal("root" in health.value, false, "健康投影不得回宿主路径");

  disposeFileTransferIpc(ipcMain);
  assert.throws(() => ipcMain.invoke(FILE_TRANSFER_CHANNEL, TRUSTED_EVENT, { command: "fileTransfer/health" }), /没有 handler/);
});

test("scope 原样保留（projectId/revision/kind/name/mime）；use 交主进程消费后删除暂存", async () => {
  const h = makeHarness();
  const source = Buffer.from("source-bytes");
  const first = await beginAndUpload(h.call, source, { projectId: "proj-42", revision: 9, name: "主图.psd" });
  const scope = h.bundle.service.scope(first.id, "u1");
  assert.deepEqual(scope, { projectId: "proj-42", revision: 9, kind: "source", name: "主图.psd", mime: "image/vnd.adobe.photoshop" });

  const preview = Buffer.from("preview-bytes");
  const second = await beginAndUpload(h.call, preview, { projectId: "proj-42", revision: 9, kind: "preview", name: "预览.png" });
  assert.equal(h.bundle.service.scope(second.id, "u1").mime, "image/png");

  await h.call("fileTransfer/complete", { id: first.id, sha256: first.sha256 });
  await h.call("fileTransfer/complete", { id: second.id, sha256: second.sha256 });

  const used = await h.bundle.service.use([first.id, second.id], "u1", async (files) => files.map((file) => ({ name: file.scope.name, size: file.size, hasPath: typeof file.path === "string" })));
  assert.deepEqual(used, [{ name: "主图.psd", size: source.length, hasPath: true }, { name: "预览.png", size: preview.length, hasPath: true }]);
  assert.equal(fs.existsSync(path.join(h.bundle.root, first.id + ".part")), false, "use 后删除暂存");
  assert.equal((await h.call("fileTransfer/status", { id: first.id })).error, FILE_TRANSFER_ERR_NOT_FOUND);

  // use 的去重与封存前置条件（源 fileTransfers.ts:89-91）。
  await assert.rejects(() => h.bundle.service.use([first.id, first.id], "u1", async () => null), (error) => error.code === FILE_TRANSFER_ERR_INVALID_INPUT);
});

test("归属隔离：他人 owner 看不到、也取消不了别人的传输", async () => {
  const dir = tmpUserData();
  const first = createFileTransferBundle({ userDataDir: dir, authorization: makeAuth("u1") });
  const second = createFileTransferBundle({ userDataDir: dir, authorization: makeAuth("u2") });
  const begin = await first.execute("fileTransfer/begin", { projectId: "p", revision: 1, kind: "source", name: "a.psd", size: 4 }, { sessionRef: "s1" });
  assert.equal(begin.ok, true);
  const id = begin.value.id;
  const foreignStatus = await second.execute("fileTransfer/status", { id }, { sessionRef: "s2" });
  assert.equal(foreignStatus.ok, false);
  assert.equal(foreignStatus.error, FILE_TRANSFER_ERR_NOT_FOUND);
  const foreignCancel = await second.execute("fileTransfer/cancel", { id }, { sessionRef: "s2" });
  assert.equal(foreignCancel.error, FILE_TRANSFER_ERR_NOT_FOUND);
  assert.equal(fs.existsSync(path.join(first.root, id + ".part")), true);
});

test("DiskTransfers 可直接构造（测试/主进程内部用），root 必填", () => {
  assert.throws(() => new DiskTransfers({}), /root/);
  const service = new DiskTransfers({ root: path.join(tmpUserData(), "nested", "parts") });
  assert.equal(service.snapshot().sessions, 0);
  assert.equal(domain.listFileTransferCommands().length, 7);
  for (const entry of domain.listFileTransferCommands()) assert.ok(["read", "manage", "destructive"].includes(entry.risk));
});
