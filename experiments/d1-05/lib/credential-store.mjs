// D1-05 §11 / §12：凭据封装原型（不是产品代码，只用于本轮技术验证）。
//
// 两条被验证的设计约束：
//   ① 明文只存在于「凭据后端」与「执行边界内的回调」两处；
//      面向 Renderer 的视图只暴露 credentialRef，永不暴露明文。
//   ② 后端进程用 **最小环境允许列表** 启动，密钥只经 stdin 管道进入，
//      不进 argv、不进 process.env、不进日志。
//
// 后端可换：本机用 macOS Keychain（Security.framework 辅助进程）。
// Windows 侧（DPAPI / Credential Manager）本轮无机器，未实现、未验证。

import { spawn } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";

const MINIMAL_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

/** 形如 `cred://<owner>/<name>#<8hex>`。指纹取自 service 名，不含密钥明文。 */
export function makeRef(owner, name, service) {
  const tag = crypto.createHash("sha256").update(service).digest("hex").slice(0, 8);
  return `cred://${owner}/${name}#${tag}`;
}

/**
 * macOS Keychain 后端：驱动 experiments/d1-05/native/keychain-helper。
 * 常驻一个子进程，父进程通过 stdin/stdout 行协议调用；子进程环境为最小允许列表。
 */
export function keychainBackend({ helperPath }) {
  const child = spawn(helperPath, [], { env: MINIMAL_ENV, stdio: ["pipe", "pipe", "pipe"] });
  const pending = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  readline.createInterface({ input: child.stdout }).on("line", (l) => {
    const resolve = pending.shift();
    if (resolve) resolve(l);
  });

  const call = (line) =>
    new Promise((resolve) => {
      pending.push(resolve);
      child.stdin.write(line + "\n");
    });

  return {
    kind: "macos-keychain-native-helper",
    helperPid: child.pid,
    childEnvKeys: Object.keys(MINIMAL_ENV),
    argvHasNoSecret: true,
    async put(service, value) {
      return call(`PUT ${service} ${value}`);
    },
    async get(service) {
      const r = await call(`GET ${service}`);
      if (r === "NONE") return null;
      if (r.startsWith("VALUE ")) return r.slice("VALUE ".length);
      throw new Error(`keychain get failed: ${r}`);
    },
    async del(service) {
      return call(`DEL ${service}`);
    },
    stderr: () => stderr,
    close() {
      try {
        child.stdin.end();
      } catch {
        /* 已关闭 */
      }
      child.kill();
    },
  };
}

export class CredentialStore {
  #backend;
  #namespace;
  #records = new Map();

  constructor({ backend, namespace = "openarc-d1-05" }) {
    this.#backend = backend;
    this.#namespace = namespace;
  }

  #service(owner, name) {
    return `${this.#namespace}.${owner}.${name}`;
  }

  /** 写入。返回值只含 ref，**不含明文**。 */
  async put({ owner, name, value }) {
    const service = this.#service(owner, name);
    const r = await this.#backend.put(service, value);
    if (r !== "OK") throw new Error(`credential put failed: ${r}`);
    const ref = makeRef(owner, name, service);
    this.#records.set(ref, { ref, owner, name, service });
    return { ref };
  }

  /** 取出明文。只允许执行边界内部调用；禁止把返回值交给 Renderer。 */
  async read(ref) {
    const rec = this.#records.get(ref);
    if (!rec) throw new Error("unknown credentialRef");
    const v = await this.#backend.get(rec.service);
    if (v === null) throw new Error("credential missing");
    return v;
  }

  /** 一次性使用：明文作为回调参数短暂存在，不返回给调用方。 */
  async use(ref, fn) {
    const value = await this.read(ref);
    try {
      return await fn(value);
    } finally {
      // JS 无法擦除字符串，这里只保证不再持有引用；真正的保障是"不跨界传递"。
      value.length; // noop，避免被优化成未使用
    }
  }

  async del(ref) {
    const rec = this.#records.get(ref);
    if (!rec) return "UNKNOWN_REF";
    const r = await this.#backend.del(rec.service);
    this.#records.delete(ref);
    return r;
  }

  /** 面向 Renderer 的视图：**只有 ref 与元数据**，没有任何明文。 */
  list() {
    return [...this.#records.values()].map(({ ref, owner, name }) => ({ ref, owner, name }));
  }

  get backendInfo() {
    const { kind, helperPid, childEnvKeys, argvHasNoSecret } = this.#backend;
    return { kind, helperPid, childEnvKeys, argvHasNoSecret };
  }

  close() {
    this.#backend.close();
  }
}

/** 深扫一个对象里有没有出现某个明文（含 JSON 序列化后的形态）。 */
export function leaksPlaintext(obj, secret) {
  const seen = new Set();
  const scan = (v, pathStr) => {
    if (typeof v === "string") return v.includes(secret) ? [pathStr] : [];
    if (v === null || typeof v !== "object") return [];
    if (seen.has(v)) return [];
    seen.add(v);
    const out = [];
    if (Array.isArray(v)) {
      v.forEach((x, i) => out.push(...scan(x, `${pathStr}[${i}]`)));
    } else {
      for (const [k, x] of Object.entries(v)) {
        if (k.includes(secret)) out.push(`${pathStr}.<key>`);
        out.push(...scan(x, `${pathStr}.${k}`));
      }
    }
    return out;
  };
  const direct = scan(obj, "$");
  const viaJson = JSON.stringify(obj ?? null)?.includes(secret) ? ["$.json"] : [];
  return [...new Set([...direct, ...viaJson])];
}
