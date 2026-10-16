/**
 * 文件传输域 · 服务层（唯一落盘实现 + 命令分发）。
 *
 * 逐段移植自只读源 server/fileTransfers.ts（行号为源行号）：
 *   · :19-45   DiskTransfers 构造 / owned 归属校验 / begin（预占先于首个 await、配额、wx 建文件）
 *   · :46-47   status / scope
 *   · :48-70   chunk（busy 互斥、块哈希、幂等重放、顺序偏移、循环写满）
 *   · :71-87   complete（未传满拒绝、stat 大小核对、fsync、整文件 sha256、预期哈希比对）
 *   · :88-98   use（去重、封存校验、消费者回调后删除暂存）
 *   · :99-103  cancel
 *   · :104-116 cleanup（内存过期回收 + 按 mtime 回收重启遗留的 UUID 暂存文件）
 *
 * 落盘位置（任务要求：必须在既有 dxos 数据根之下）：<userData>/dxos/file-transfers。
 * 为什么用 resolveDxosPaths 而不是自己拼 "<userData>/dxos"：dxos-foundation-paths.cjs:29-37
 * 是 DX 数据根的唯一定义处；但**不**把 file-transfers 加进 DXOS_LAYOUT.directories ——
 * dxos-foundation.test.mjs 精确断言该数组内容（见 dxos-foundation-paths.cjs:39-41 的同类取舍），
 * 首次写入时本模块自建目录即可。
 *
 * 为什么不把 transfers.use 暴露成 IPC 命令：源 fileTransfers.ts:16-17 明确规定"只有不透明
 * id 过 API，宿主路径绝不过桥"。use 的消费者需要真实 path，属于主进程内部协作，所以只保留
 * 类方法供同进程调用，不注册到 fileTransfer:command。
 */
"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { mkdir, open, rm, stat, readdir } = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const domain = require("./file-transfer-domain.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

/** <userData>/dxos/file-transfers（源 fileTransferRoutes.ts:7 dataPath('file-transfers')）。 */
const TRANSFER_DIR_NAME = "file-transfers";
const HOST_APP_ID = "file-transfer";
/** 源 fileTransfers.ts:111 的孤儿暂存文件名口径。 */
const ORPHAN_STAGING_RE = /^[0-9a-f-]{36}\.part$/;

const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);

/** 解析并围栏传输落盘根：必须严格落在 <userData>/dxos 之下。 */
function resolveTransferRoot(userDataDir) {
  const dxosRoot = resolveDxosPaths(userDataDir).root;
  const root = path.join(dxosRoot, TRANSFER_DIR_NAME);
  if (!domain.isContainedPath(dxosRoot, root)) throw domain.createFileTransferError(domain.FILE_TRANSFER_ERR_PATH_ESCAPE, "文件传输目录不在 dxos 数据根之下");
  return root;
}

class DiskTransfers {
  constructor({ root, clock = null, logger = null } = {}) {
    if (typeof root !== "string" || !root.trim()) throw new Error("DiskTransfers 需要 root");
    this.root = path.resolve(root);
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger || null;
    /** 源 fileTransfers.ts:20：会话只存内存，重启无法续传（cleanup 只回收 UUID 暂存文件）。 */
    this.sessions = new Map();
  }

  now() {
    return this.clock();
  }

  /** 源 fileTransfers.ts:22-26：归属 + TTL 一起校验，缺失/他人/过期统一 404。 */
  #owned(id, owner) {
    const item = this.sessions.get(id);
    if (!item || item.owner !== owner || item.expires < this.now()) throw domain.transferFailure(404, "传输不存在或已过期");
    return item;
  }

  /** 源 fileTransfers.ts:30-45。 */
  async begin(owner, size, scope) {
    domain.assertTransferSize(size, scope && scope.kind);
    // 源 :32-33：预占发生在第一个 await 之前，并发请求无法绕过配额。
    const now = this.now();
    const sessions = [...this.sessions.values()];
    const own = sessions.filter((s) => s.owner === owner && s.expires >= now);
    const ownBytes = own.reduce((total, s) => total + s.size, size);
    const reservedBytes = sessions.reduce((total, s) => total + s.size, size);
    domain.assertTransferAdmission({ ownerCount: own.length, ownerBytes: ownBytes, reservedBytes, sessionCount: this.sessions.size });
    const id = randomUUID();
    const item = { id, owner, scope, size, offset: 0, path: domain.resolveStagingPath(this.root, id), expires: now + domain.TRANSFER_TTL_MS, busy: true };
    this.sessions.set(id, item);
    try {
      await mkdir(this.root, { recursive: true });
      const file = await open(item.path, "wx");
      await file.close();
      item.busy = false;
      return domain.transferView(item);
    } catch (error) {
      this.sessions.delete(id);
      await rm(item.path, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** 源 fileTransfers.ts:46。 */
  status(id, owner) {
    return domain.transferView(this.#owned(id, owner));
  }

  /** 源 fileTransfers.ts:47：scope 是只读投影，供主进程消费者核对归属。 */
  scope(id, owner) {
    return this.#owned(id, owner).scope;
  }

  /** 源 fileTransfers.ts:48-70。 */
  async chunk(id, owner, offset, bytes, expectedHash) {
    const item = this.#owned(id, owner);
    if (item.busy) throw domain.transferFailure(409, "传输忙，请重试");
    domain.assertChunkShape({ offset, length: bytes.length, size: item.size, sealed: !!item.sha256 });
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (expectedHash && expectedHash !== hash) throw domain.transferFailure(400, "文件块完整性校验失败");
    // 源 :54：同块重放直接回当前视图，不重复写、不推进 offset（断线重试的主路径）。
    if (item.last && item.last.offset === offset && item.last.size === bytes.length && item.last.hash === hash) return domain.transferView(item);
    if (offset !== item.offset) throw domain.transferFailure(409, "文件块偏移不匹配，请查询传输状态");
    item.busy = true;
    try {
      const file = await open(item.path, "r+");
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw domain.transferFailure(500, "磁盘写入未取得进展");
          written += result.bytesWritten;
        }
      } finally {
        await file.close();
      }
      item.last = { offset, size: bytes.length, hash };
      item.offset += bytes.length;
      item.expires = this.now() + domain.TRANSFER_TTL_MS;
      return domain.transferView(item);
    } finally {
      item.busy = false;
    }
  }

  /** 源 fileTransfers.ts:71-87。 */
  async complete(id, owner, expectedHash) {
    const item = this.#owned(id, owner);
    if (item.busy || item.offset !== item.size) throw domain.transferFailure(409, "文件尚未完整上传");
    domain.assertSha256(expectedHash);
    item.busy = true;
    try {
      if (!item.sha256) {
        if ((await stat(item.path)).size !== item.size) throw domain.transferFailure(400, "文件大小校验失败");
        const file = await open(item.path, "r+");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(item.path)) hash.update(chunk);
        item.sha256 = hash.digest("hex");
      }
      if (expectedHash && expectedHash !== item.sha256) throw domain.transferFailure(400, "文件完整性校验失败");
      return domain.transferView(item);
    } finally {
      item.busy = false;
    }
  }

  /**
   * 源 fileTransfers.ts:88-98：把已校验的传输交给同进程消费者，回调成功即删除暂存。
   * 不注册 IPC 命令（见文件头说明）；fn 收到 [{ ...item, path }]。
   */
  async use(ids, owner, fn) {
    if (new Set(ids).size !== ids.length) throw domain.transferFailure(400, "文件传输 ID 重复");
    const items = ids.map((id) => this.#owned(id, owner));
    if (items.some((item) => item.busy || !item.sha256)) throw domain.transferFailure(409, "文件未校验完成或正在使用");
    for (const item of items) item.busy = true;
    try {
      const result = await fn(items);
      for (const item of items) {
        this.sessions.delete(item.id);
        await rm(item.path, { force: true }).catch(() => {});
      }
      return result;
    } finally {
      for (const item of items) item.busy = false;
    }
  }

  /** 源 fileTransfers.ts:99-103。 */
  async cancel(id, owner) {
    const item = this.#owned(id, owner);
    if (item.busy) throw domain.transferFailure(409, "传输正在处理，请稍后取消");
    this.sessions.delete(id);
    await rm(item.path, { force: true });
    return { id, cancelled: true };
  }

  /** 源 fileTransfers.ts:104-116。返回 removed 便于显式命令复核。 */
  async cleanup() {
    const now = this.now();
    let removed = 0;
    for (const item of [...this.sessions.values()]) {
      if (item.busy || item.expires >= now) continue;
      this.sessions.delete(item.id);
      await rm(item.path, { force: true }).catch(() => {});
      removed += 1;
    }
    // 源 :108-115：重启后内存会话已丢，只能按 UUID 命名 + mtime 超 TTL 回收本域暂存，
    // 绝不碰目录里的其它内容。
    for (const name of await readdir(this.root).catch(() => [])) {
      if (!ORPHAN_STAGING_RE.test(name) || this.sessions.has(name.slice(0, -domain.TRANSFER_STAGING_SUFFIX.length))) continue;
      const candidate = path.join(this.root, name);
      if (!domain.isContainedPath(this.root, candidate)) continue;
      const file = await stat(candidate).catch(() => null);
      if (file && file.mtimeMs < now - domain.TRANSFER_TTL_MS) {
        await rm(candidate, { force: true }).catch(() => {});
        removed += 1;
      }
    }
    return { removed, sessions: this.sessions.size };
  }

  /** 只回计数，不回 root（源 :16-17：宿主路径不过桥）。 */
  snapshot() {
    const now = this.now();
    let bytes = 0;
    let inFlight = 0;
    let expired = 0;
    for (const item of this.sessions.values()) {
      bytes += item.size;
      if (item.busy) inFlight += 1;
      if (item.expires < now) expired += 1;
    }
    return { sessions: this.sessions.size, inFlight, expired, bytes };
  }
}

/** 渲染层二进制块解码：structured clone 过来可能是 Buffer / Uint8Array / ArrayBuffer / base64 串。 */
function decodeChunkBytes(payload) {
  const raw = payload.bytes !== undefined ? payload.bytes : payload.data;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (typeof raw === "string" && payload.encoding === "base64") return Buffer.from(raw, "base64");
  throw domain.createFileTransferError(domain.FILE_TRANSFER_ERR_INVALID_INPUT, "需要二进制文件块（bytes 或 encoding=base64 的 data）");
}

function requireTransferId(value) {
  if (typeof value !== "string" || !value) throw domain.createFileTransferError(domain.FILE_TRANSFER_ERR_INVALID_INPUT, "传输 ID 必填");
  return value;
}

/**
 * 装配文件传输域。
 * @param userDataDir   Electron app.getPath("userData")；落盘根固定为 <userData>/dxos/file-transfers
 * @param authorization 授权服务（与 media-service.cjs:1069-1078 同一形状）；缺省即结构化未认证
 * @param clock         可注入时钟（测试 TTL 用）；缺省 Date.now
 * @param logger        可选日志
 * @returns { execute, service, root, dependencies, dispose } —— execute 是唯一命令入口，root 仅供主进程内部/测试
 */
function createFileTransferBundle({ userDataDir, authorization = null, clock = null, logger = null } = {}) {
  if (typeof userDataDir !== "string" || !userDataDir.trim()) throw new Error("createFileTransferBundle 需要 userDataDir");
  const root = resolveTransferRoot(userDataDir);
  const service = new DiskTransfers({ root, clock, logger });

  /** sessionRef → actor；不可解析即 { ok:false }，绝不伪造身份（同 media-service.cjs:1068-1078）。 */
  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  function health() {
    const snapshot = service.snapshot();
    return {
      status: "ready",
      directory: "dxos/file-transfers",
      chunkBytes: domain.TRANSFER_CHUNK_BYTES,
      maxBytes: domain.TRANSFER_MAX_BYTES,
      ttlMs: domain.TRANSFER_TTL_MS,
      ...snapshot,
    };
  }

  async function dispatch(command, payload, context) {
    switch (command) {
      case "fileTransfer/begin": {
        const scope = domain.normalizeTransferScope(payload);
        return service.begin(context.userId, payload.size, scope);
      }
      case "fileTransfer/chunk": {
        const expectedHash = clip(payload.expectedHash, 64) || clip(payload.sha256, 64) || undefined;
        return service.chunk(requireTransferId(payload.id), context.userId, payload.offset, decodeChunkBytes(payload), expectedHash);
      }
      case "fileTransfer/complete": {
        const expectedHash = clip(payload.sha256, 64) || clip(payload.expectedHash, 64) || undefined;
        return service.complete(requireTransferId(payload.id), context.userId, expectedHash);
      }
      case "fileTransfer/status":
        return service.status(requireTransferId(payload.id), context.userId);
      case "fileTransfer/cancel":
        return service.cancel(requireTransferId(payload.id), context.userId);
      case "fileTransfer/cleanup":
        return service.cleanup();
      case "fileTransfer/health":
        return health();
      default:
        throw domain.fileTransferCommandNotAllowed(command);
    }
  }

  /** 唯一命令入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizeFileTransferError。 */
  async function execute(command, payload, ctx = {}) {
    if (!domain.isFileTransferCommand(command)) return domain.normalizeFileTransferError(domain.fileTransferCommandNotAllowed(command));
    const context = {
      sessionRef: clip(ctx && ctx.sessionRef, 160),
      appId: clip(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "file-transfer",
      requestId: clip(ctx && ctx.requestId, 100),
    };
    const actorResult = resolveActor(context);
    if (!actorResult.ok) {
      return domain.normalizeFileTransferError(domain.createFileTransferError(domain.FILE_TRANSFER_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，fileTransfer 命令被拒绝"));
    }
    context.userId = String(actorResult.user.id);
    const body = payload && typeof payload === "object" ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      return { ok: true, value: domain.redactFileTransferValue(value) };
    } catch (error) {
      return domain.normalizeFileTransferError(error);
    }
  }

  // 键名避开 isSecretKey 的子串（dxos-foundation-mask.cjs:12 命中 "authorization"），
  // 与 media-service.cjs:1124 的 identity 口径一致；值给布尔事实，缺失不降级成假成功。
  const dependencies = Object.freeze({ userDataDir: true, identity: !!authorization, root: !!root });

  return {
    execute,
    service,
    root,
    dependencies,
    /** 应用退出 / 显式维护：回收过期会话与孤儿暂存（不删未过期会话）。 */
    dispose: () => service.cleanup(),
  };
}

module.exports = {
  DiskTransfers,
  createFileTransferBundle,
  resolveTransferRoot,
  decodeChunkBytes,
  TRANSFER_DIR_NAME,
  HOST_APP_ID,
};
