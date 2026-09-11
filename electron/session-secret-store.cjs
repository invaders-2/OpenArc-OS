/**
 * D3-01 · Session Secret Store —— 「跨重启恢复身份用的那把钥匙」放哪。
 *
 * ## 威胁模型（§11）
 *
 *   要保护的不是口令（口令的 verifier 存在库里，是 salt+scrypt 的 digest，
 *   攻击者拿到库也还得逐个撞），而是 **session token**：
 *   拿到它 = 直接以该用户身份进入系统，无需任何计算。
 *
 *   谁是攻击者：
 *     A. 同机另一个**同 uid 进程** —— D1-05 实测：可读任意同 uid 文件、
 *        可连 127.0.0.1、可 `sysctl(KERN_PROCARGS2)` 读走 argv/env。
 *        ⇒ **文件权限不是安全边界**，0600 只能防"别人登进你电脑看"。
 *     B. 拿到磁盘镜像 / 备份的离线攻击者 —— 没有用户登录态，读不到 Keychain。
 *        ⇒ 这一类是 Keychain / DPAPI **真正能挡住**的。
 *     C. 渲染进程里的脚本 —— 必须拿不到 token，连密文都最好拿不到。
 *
 *   结论（冻结）：
 *     1. **token 永不进入渲染进程**，也永不进 localStorage。
 *        渲染进程只持有不透明的 sessionRef，且重启即失效。
 *     2. token 落盘时必须是 **OS 受保护存储加密后的密文**。
 *        macOS = Keychain，Windows = DPAPI —— 由 Electron `safeStorage` 统一提供，
 *        两端同一份调用代码，不需要 native 编译产物。
 *     3. 密文文件仍然 0600，但**明确记录它不是安全边界**，只是防呆与防误读。
 *     4. `safeStorage` 不可用时（Linux 无 keyring、macOS 无钥匙串等）
 *        降级为明文文件，并**在状态里显式标 `downgraded: true`** ——
 *        不静默降级，降级必须能被审计与探针看见。
 *
 * ## 为什么不用 /usr/bin/security
 *   D1-05 已否决：它的 -w/-p 把密钥放进 argv，同 uid 进程 `ps` 即可读。
 *   Electron safeStorage 是进程内调用 Security.framework / DPAPI，无 argv 面。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "session-secret.v1";

/**
 * 后端：Electron safeStorage。
 *
 * 密文由 OS 管理密钥（macOS Keychain / Windows DPAPI），
 * 因此同一个 blob 换一台机器、换一个用户就解不开 —— 这正是我们要的：
 * "把磁盘拷走"不等于"把身份带走"。
 */
function safeStorageBackend({ safeStorage, dir }) {
  const file = path.join(dir, FILE_NAME);
  return {
    kind: "electron-safe-storage",
    /** safeStorage 在 app ready 之前不可用；调用方必须先检查。 */
    available: () => !!safeStorage && safeStorage.isEncryptionAvailable() === true,
    async put(record) {
      const blob = safeStorage.encryptString(JSON.stringify(record));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, blob.toString("base64"), { mode: 0o600 });
      // 权限可能被既有文件覆盖，显式再收一次（umask 只影响新建）
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* 非本机文件系统（如某些网络盘）不支持 chmod */
      }
      return { kind: "electron-safe-storage", bytes: blob.length };
    },
    async get() {
      if (!fs.existsSync(file)) return null;
      try {
        const raw = fs.readFileSync(file, "utf8");
        const text = safeStorage.decryptString(Buffer.from(raw, "base64"));
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed.token !== "string") return null;
        return parsed;
      } catch {
        // 解不开（换了用户 / 钥匙串被重置）＝ 没有可用会话，而不是崩溃
        return null;
      }
    },
    async clear() {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 已删除 */
      }
    },
    file,
  };
}

/**
 * 降级后端：明文文件 0600。
 *
 * **只**在 safeStorage 不可用时使用，且调用方必须把 `downgraded` 报出去。
 * 它挡不住同 uid 进程（D1-05 实测），挡得住的只是"另一个用户账户"与"顺手 cat"。
 */
function plainFileBackend({ dir }) {
  const file = path.join(dir, FILE_NAME);
  return {
    kind: "plain-file-0600",
    downgraded: true,
    available: () => true,
    async put(record) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* 忽略 */
      }
      return { kind: "plain-file-0600", downgraded: true };
    },
    async get() {
      if (!fs.existsSync(file)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return parsed && typeof parsed.token === "string" ? parsed : null;
      } catch {
        return null;
      }
    },
    async clear() {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 已删除 */
      }
    },
    file,
  };
}

/** 内存后端：测试用，断言"不落盘"这类性质时最干净。 */
function memoryBackend() {
  let value = null;
  return {
    kind: "memory",
    available: () => true,
    async put(record) {
      value = record;
      return { kind: "memory" };
    },
    async get() {
      return value;
    },
    async clear() {
      value = null;
    },
  };
}

/**
 * Session Secret Store。
 *
 * 只存**一条**记录：当前这台机器上"最后成功登录的那个会话"。
 * 不存历史、不存多会话 —— 桌面本机登录本就是单会话语义。
 */
class SessionSecretStore {
  constructor(backend) {
    this.backend = backend;
  }

  get kind() {
    return this.backend.kind;
  }

  get downgraded() {
    return !!this.backend.downgraded;
  }

  available() {
    return this.backend.available();
  }

  async save({ sessionId, token }) {
    if (typeof token !== "string" || !token) throw new Error("token 缺失，拒绝写入");
    return this.backend.put({ sessionId, token, savedAt: Date.now() });
  }

  async read() {
    return this.backend.get();
  }

  async clear() {
    return this.backend.clear();
  }

  /** 供状态与探针读取的后端描述。不含任何明文。 */
  describe() {
    return { kind: this.kind, downgraded: this.downgraded, available: this.available(), file: this.backend.file ?? null };
  }
}

module.exports = {
  SessionSecretStore,
  safeStorageBackend,
  plainFileBackend,
  memoryBackend,
  FILE_NAME,
};
