/**
 * D3-01 凭据后端探针（在**真实 Electron 主进程**中运行）。
 *
 * 为什么要单独拉起 Electron：
 *   `safeStorage` 与 Electron 的 Node 运行时都只在主进程里有完整形态。
 *   在纯 Node 里"验证"它们等于什么都没验证 —— 这正是 D1-05 记录过的教训
 *   （Node API 名字相同不代表行为相同）。
 *
 * 安全红线（§35，继承 D1-05 / D1-06 Boss 决策）：
 *   · 只使用**假 secret**（openarc-d3-01-probe-fake-token-…）
 *   · 只使用**本探针自建的临时目录**作为落盘位置
 *   · 不 rename 真实 login keychain、不改 default keychain、不改 global search list
 *   · 收尾必须 delete 自建条目并清理临时目录
 */
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const { IdentityStore } = require(path.join(ROOT, "electron/identity-store.cjs"));
const { SessionSecretStore, safeStorageBackend, plainFileBackend } = require(path.join(ROOT, "electron/session-secret-store.cjs"));

const out = (line) => process.stdout.write(line + "\n");
const report = { checks: [], versions: {}, errors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
};

const FAKE_TOKEN = "openarc-d3-01-probe-fake-token-" + "a1b2c3d4e5f6";

app.whenReady().then(async () => {
  let dir = null;
  try {
    report.versions = {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform + "/" + process.arch,
    };
    out("VERSIONS " + JSON.stringify(report.versions));

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-01-cred-"));

    // ── 1. node:sqlite 在 Electron 主进程里是否可用 ───────────────────────
    let sqliteOk = false;
    let sqliteDetail = "";
    try {
      require("node:sqlite");
      sqliteOk = true;
      sqliteDetail = "require('node:sqlite') 成功";
    } catch (e) {
      sqliteDetail = String(e.message).slice(0, 160);
    }
    check("Electron 主进程可用 node:sqlite", sqliteOk, sqliteDetail);

    if (sqliteOk) {
      try {
        const store = new IdentityStore({ path: path.join(dir, "electron-identity.db") }).open();
        const init = await store.initialize({ identifier: "probe@openarc.local", password: "probe-password-1", displayName: "Probe" });
        const login = await store.login({ identifier: "probe@openarc.local", password: "probe-password-1" });
        check(
          "Electron 主进程内跑通 initialize → login（真实 SQLite 事务）",
          init.ok && login.ok && store.invariants().length === 0,
          `init=${init.ok}, login=${login.ok}, 不变量=${store.invariants().length}`,
        );
        store.close();
      } catch (e) {
        check("Electron 主进程内跑通 initialize → login（真实 SQLite 事务）", false, String(e.message).slice(0, 160));
      }
    }

    // ── 2. safeStorage 后端 ──────────────────────────────────────────────
    const available = safeStorage.isEncryptionAvailable();
    check("safeStorage.isEncryptionAvailable()", available, `platform=${process.platform}`);

    let backend;
    if (available) {
      backend = safeStorageBackend({ safeStorage, dir });
    } else {
      backend = plainFileBackend({ dir });
      report.errors.push("safeStorage 不可用，本轮按降级后端验证；降级状态必须被记录而非静默");
    }
    const store = new SessionSecretStore(backend);

    check("使用的后端", true, `${store.kind}${store.downgraded ? "（降级，已记录）" : ""}`);

    await store.save({ sessionId: "ses_probe_0001", token: FAKE_TOKEN });
    const back = await store.read();
    check("写入后能读回同一个 token（加解密往返）", back && back.token === FAKE_TOKEN, back ? "token 一致" : "read()=null");

    // 落盘内容不得含明文
    const file = path.join(dir, "session-secret.v1");
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    const plainOnDisk = onDisk.includes(Buffer.from(FAKE_TOKEN, "utf8"));
    check("磁盘上的内容不含 token 明文（是密文）", !plainOnDisk, `字节数=${onDisk.length}`);

    const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0;
    check("落盘文件权限为 0600", mode === 0o600, `mode=${mode.toString(8)}`);

    // 另一个目录（模拟"换一个数据目录"）读不到
    if (available) {
      const other = new SessionSecretStore(safeStorageBackend({ safeStorage, dir: path.join(dir, "other") }));
      check("换目录读不到已存的 token（目录隔离）", (await other.read()) === null, "null");
    }

    await store.clear();
    check("clear() 之后读不到 token", (await store.read()) === null, "null");
    check("clear() 之后文件不存在", !fs.existsSync(file), fs.existsSync(file) ? "仍存在" : "已删除");

    // ── 3. 平台口径 ─────────────────────────────────────────────────────
    if (process.platform === "darwin") {
      check(
        "macOS：后端为 OS 受保护存储（Keychain），已实测",
        available && store.kind === "electron-safe-storage",
        "已实测",
      );
    } else if (process.platform === "win32") {
      check("Windows：DPAPI 后端", available, "本平台实测");
    } else {
      check("非 macOS / Windows 平台：后端仅作参考", false, "NOT VERIFIED（非目标平台）");
    }
  } catch (e) {
    report.errors.push(String(e && e.stack ? e.stack : e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
