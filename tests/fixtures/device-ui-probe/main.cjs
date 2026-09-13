/**
 * D3-03 设备 UI 探针（真实 Electron + 产品真实页面 / preload / 设备装配）。
 *
 * 与 tests/authorization-ui.mjs 同一手法：主进程自持窗口 + executeJavaScript，
 * 不依赖 Playwright（本环境 CDP 握手超时）。
 *
 * 覆盖：
 *   · 能力检测：无 preload 的浏览器预览形态 → 「当前环境无法访问设备域」，不伪造数据
 *   · 设备列表渲染：名称 / 平台+架构 / 状态 / 连接 / 最近在线 / credentialVersion
 *   · §6 两根轴：ACTIVE+OFFLINE 与 REVOKED / DISABLED / PENDING 各自独立显示，不塌缩
 *   · §49 开始配对：join code 只在生成时出现一次；倒计时 / 到期；可撤销
 *   · §51 Super Admin 入口：普通用户看不到管理按钮，且后端仍拒绝
 *   · 失败反馈：ok:false 必须显示 reasonCode（含未登记 code 的回退）
 *   · §48 不泄漏：配对 secret 只出现一次，不在库里明文，页面无证书 / 私钥原文
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "device-ui-admin@openarc.test";
const ADMIN_PW = "device-ui-admin-password-1";
const VIEWER = "device-ui-viewer@openarc.test";
const VIEWER_PW = "device-ui-viewer-password-1";
const SERVICE_IDENTITY = "svc_openarc-control-ui0001";

const report = { checks: [], notVerified: [], errors: [], versions: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok: !!ok, detail: String(detail) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const notVerified = (name, reason) => {
  report.notVerified.push({ name, reason });
  out("NOT VERIFIED " + name + " :: " + reason);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let winPreview = null;
let userData = null;

const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const jsp = (code) => winPreview.webContents.executeJavaScript("(async () => { " + code + " })()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const textp = (sel) => jsp("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const attr = (sel, name) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(name) + ") || null");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const hasp = (sel) => jsp("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const count = (sel) => js("return document.querySelectorAll(" + JSON.stringify(sel) + ").length");

async function waitGate(want, timeout = 30000) {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) {
    try {
      last = await gate();
      if (last === want) return last;
    } catch {
      /* 导航中 */
    }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}

async function waitSel(sel, timeout = 10000, scope = js) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await scope("return !!document.querySelector(" + JSON.stringify(sel) + ")")) return true;
    } catch {
      /* 导航中 */
    }
    await sleep(80);
  }
  return false;
}

async function waitAttr(sel, name, value, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await attr(sel, name)) === value) return true;
    await sleep(80);
  }
  return false;
}

async function waitText(sel, substr, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await text(sel)).includes(substr)) return true;
    await sleep(80);
  }
  return false;
}

/** 等某一配对行的 data-device-pairing-status 变成目标值。 */
async function waitPairingStatus(pairingId, status, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const raw = await js(
      "return JSON.stringify([...document.querySelectorAll('[data-device-pairing]')].map((r) => ({ id: r.getAttribute('data-device-pairing'), status: r.getAttribute('data-device-pairing-status') })))",
    );
    try {
      const row = JSON.parse(raw).find((r) => r.id === pairingId);
      if (row && row.status === status) return true;
    } catch {
      /* 忽略解析失败，继续等 */
    }
    await sleep(80);
  }
  return false;
}

const click = (sel) =>
  js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "if (el.disabled) return 'disabled';" +
      "el.click(); return 'ok';",
  );

const clickp = (sel) =>
  jsp(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "if (el.disabled) return 'disabled';" +
      "el.click(); return 'ok';",
  );

const setInput = (sel, value) =>
  js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;" +
      "setter.call(el, " + JSON.stringify(value) + ");" +
      "el.dispatchEvent(new Event('input', { bubbles: true }));" +
      "return 'ok';",
  );

async function loginUI(identifier, password) {
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', password);
  await sleep(100);
  await click('[data-d3-id="login-submit"]');
}

const deviceSel = (name) => "[data-device-name=" + JSON.stringify(name) + "]";

async function openDevicePane() {
  await click('[aria-label="打开系统设置"]');
  await waitSel(".settings-content");
  await click('[data-settings-pane="devices"]');
  return waitSel('[data-device-pane="devices"]');
}

/** 在真实持久层里走一遍真实配对，返回设备元数据（不是 mock）。 */
function seedDevice(identity, adminCtx, { displayName, platform, architecture }) {
  const created = identity.deviceService.createPairing({ context: adminCtx, ttlMs: 120000 });
  if (!created.ok) throw new Error("createPairing failed: " + created.error);
  const res = identity.deviceService.consumePairing({
    secret: created.secret,
    serviceIdentitySeen: SERVICE_IDENTITY,
    deviceIdentity: {
      displayName,
      platform,
      architecture,
      fingerprint: "fp_" + displayName.replace(/\W+/g, "_"),
      subject: "CN=" + displayName,
    },
  });
  if (!res.ok) throw new Error("consumePairing failed: " + res.error);
  return res.device.deviceId;
}

app.whenReady().then(async () => {
  try {
    report.versions = {
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform + "/" + process.arch,
    };
    out("VERSIONS " + JSON.stringify(report.versions));

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-03-ui-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true, serviceIdentity: SERVICE_IDENTITY });

    // ── 播种：admin + viewer + 覆盖全部状态/连接组合的真实设备 ──────────────
    await identity.store.initialize({ identifier: ADMIN, password: ADMIN_PW, displayName: "Admin" });
    const adminLogin = await identity.store.login({ identifier: ADMIN, password: ADMIN_PW });
    const orgId = adminLogin.user.team_id;
    const adminCtx = { sessionRef: adminLogin.session.ref, appId: "resource-library", source: "ui" };
    const viewerRes = await identity.store.createUser({ identifier: VIEWER, password: VIEWER_PW, displayName: "Viewer", teamId: orgId });
    if (!viewerRes.ok) throw new Error("createUser viewer failed: " + viewerRes.error);

    const onlineId = seedDevice(identity, adminCtx, { displayName: "Studio Mac", platform: "darwin", architecture: "arm64" });
    identity.deviceStore.setConnectivity(onlineId, "ONLINE");

    const offlineId = seedDevice(identity, adminCtx, { displayName: "Render Node", platform: "linux", architecture: "x64" });
    identity.deviceService.markOffline(offlineId);

    const revokedId = seedDevice(identity, adminCtx, { displayName: "Retired Laptop", platform: "win32", architecture: "x64" });
    identity.deviceService.revokeDevice({ context: adminCtx, deviceId: revokedId });

    const disabledId = seedDevice(identity, adminCtx, { displayName: "Sleeping iMac", platform: "darwin", architecture: "x64" });
    identity.deviceService.disableDevice({ context: adminCtx, deviceId: disabledId });

    // PENDING：从未被激活的设备，走 store 直插（真实 schema，不是 UI 层 mock）
    const pending = identity.deviceStore.insertDevice({
      organizationId: orgId,
      displayName: "Pending Pad",
      platform: "ios",
      architecture: "arm64",
      status: "PENDING",
    });

    const makeWindow = (preload) =>
      new BrowserWindow({
        width: 1280,
        height: 860,
        show: false,
        webPreferences: {
          ...(preload ? { preload: path.join(ROOT, "electron/preload.cjs") } : {}),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

    winPreview = makeWindow(false);
    win = makeWindow(true);

    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));

    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      authorization: identity.authorization,
      device: identity.deviceService,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    // ── 0. 能力检测：无 preload（浏览器预览形态）──────────────────────────
    await winPreview.loadURL(uiURL);
    await sleep(700);
    await clickp('[aria-label="打开系统设置"]');
    const previewSettings = await waitSel(".settings-content", 8000, jsp);
    await clickp('[data-settings-pane="devices"]');
    const previewPane = await waitSel('[data-device-pane="devices"]', 8000, jsp);
    const previewUnavailable = await hasp('[data-device-available="false"]');
    const previewText = previewPane ? await textp('[data-device-pane="devices"]') : "";
    check(
      "C1 · 无设备桥（浏览器预览）→ 显示「当前环境无法访问设备域」且不展示设备",
      previewSettings && previewPane && previewUnavailable && previewText.includes("当前环境无法访问设备域") && (await jsp("return document.querySelectorAll('article[data-device-id]').length")) === 0,
      "unavailable=" + previewUnavailable,
    );
    winPreview.destroy();
    winPreview = null;

    // ── 1. 普通用户：入口隐藏 + 后端仍拒绝（§51）──────────────────────────
    await win.loadURL(uiURL);
    await sleep(500);
    let g = await waitGate("unauthenticated");
    await loginUI(VIEWER, VIEWER_PW);
    g = await waitGate("ready");
    check("V1 · Viewer 登录进入桌面", g === "ready", "gate=" + g);
    await openDevicePane();
    const viewerRows = await count("article[data-device-id]");
    check("V2 · Viewer 可查看设备列表（VIEW 允许）", viewerRows >= 5, "rows=" + viewerRows);
    check("V3 · Viewer 看不到任何 Super Admin 管理按钮", (await count('[data-device-action="pair"]')) === 0 && (await count('[data-device-action="disable"]')) === 0 && (await count('[data-device-action="revoke"]')) === 0 && (await count('[data-device-action="rename"]')) === 0, "admin buttons hidden");
    check("V4 · Viewer 看到权限说明（不是静默隐藏）", await has("[data-device-role-note]"), "role note");
    const viewerPair = await js("return await window.openarc.device.command({ type: 'device/pairing.create' })");
    check("V5 · 后端对 Viewer 的配对命令仍返回 NOT_SUPER_ADMIN（隐藏不是安全边界）", viewerPair && viewerPair.ok === false && viewerPair.error === "NOT_SUPER_ADMIN", JSON.stringify(viewerPair).slice(0, 120));

    // ── 2. Super Admin：设备列表与状态轴（§6）─────────────────────────────
    await click('[data-d3-id="topbar-logout"]');
    g = await waitGate("unauthenticated");
    check("A0 · Viewer 登出回登录页", g === "unauthenticated", "gate=" + g);
    await loginUI(ADMIN, ADMIN_PW);
    g = await waitGate("ready");
    check("A1 · Admin 登录进入桌面", g === "ready", "gate=" + g);
    await click('[aria-label="打开系统设置"]');
    await waitSel(".settings-content");
    check(
      "A1b · 既有「外观与交互」仍是默认 pane，材质选择器未被移出 DOM",
      (await attr("[data-settings-active]", "data-settings-active")) === "appearance" && (await has(".material-select")) && (await text(".settings-pane")).includes("外观与交互"),
      "active=" + (await attr("[data-settings-active]", "data-settings-active")),
    );
    await click('[data-settings-pane="model"]');
    check(
      "A1c · 既有「全局模型服务」pane 仍可切换且字段完整",
      (await attr("[data-settings-active]", "data-settings-active")) === "model" && (await text(".settings-pane")).includes("全局模型服务") && (await text(".settings-pane")).includes("API 地址") && (await text(".settings-pane")).includes("模型名称"),
      "active=" + (await attr("[data-settings-active]", "data-settings-active")),
    );
    await click('[data-settings-pane="devices"]');
    const opened = await waitSel("[data-device-pane=\"devices\"]");
    const readyRows = opened && (await waitSel("[data-device-list] [data-device-id]"));
    check("A2 · 设备 pane 渲染设备列表", !!readyRows && (await count("article[data-device-id]")) === 5, "rows=" + (await count("article[data-device-id]")));

    check(
      "A3 · ACTIVE + ONLINE 独立显示",
      (await attr(deviceSel("Studio Mac"), "data-device-status")) === "ACTIVE" &&
        (await attr(deviceSel("Studio Mac"), "data-device-connectivity")) === "ONLINE" &&
        (await text(deviceSel("Studio Mac"))).includes("已授权 ACTIVE") &&
        (await text(deviceSel("Studio Mac"))).includes("在线 ONLINE"),
      "status=" + (await attr(deviceSel("Studio Mac"), "data-device-status")) + ", conn=" + (await attr(deviceSel("Studio Mac"), "data-device-connectivity")),
    );
    check(
      "A4 · §6 ACTIVE 但 OFFLINE：连接轴独立，不塌缩成 Unavailable",
      (await attr(deviceSel("Render Node"), "data-device-status")) === "ACTIVE" &&
        (await attr(deviceSel("Render Node"), "data-device-connectivity")) === "OFFLINE" &&
        (await text(deviceSel("Render Node"))).includes("离线 OFFLINE") &&
        (await text(deviceSel("Render Node"))).includes("已授权 ACTIVE"),
      "status=" + (await attr(deviceSel("Render Node"), "data-device-status")) + ", conn=" + (await attr(deviceSel("Render Node"), "data-device-connectivity")),
    );
    check("A5 · REVOKED 与 DISABLED 文案区分显示", (await attr(deviceSel("Retired Laptop"), "data-device-status")) === "REVOKED" && (await text(deviceSel("Retired Laptop"))).includes("已撤销 REVOKED") && (await attr(deviceSel("Sleeping iMac"), "data-device-status")) === "DISABLED" && (await text(deviceSel("Sleeping iMac"))).includes("已禁用 DISABLED"), "revoked/disabled");
    check("A6 · PENDING 独立显示", (await attr(deviceSel("Pending Pad"), "data-device-status")) === "PENDING" && (await text(deviceSel("Pending Pad"))).includes("待激活 PENDING"), "pending");
    check("A7 · 平台 + 架构 + credentialVersion + 最近在线 均渲染", (await text(deviceSel("Studio Mac"))).includes("darwin") && (await text(deviceSel("Studio Mac"))).includes("arm64") && (await text(deviceSel("Studio Mac"))).includes("凭据 v1") && (await text(deviceSel("Studio Mac"))).includes("最近在线"), "meta");

    // ── 3. 开始配对：join code 只出现一次 + 倒计时 + 单次状态 ──────────────
    await click('[data-device-action="pair"]');
    const secretShown = await waitSel("[data-device-pairing-secret]");
    const secretValue = secretShown ? (await text("[data-device-pairing-secret]")).trim() : "";
    check("A8 · 发起配对后出现 join code", secretShown && secretValue.length >= 20, "len=" + secretValue.length);
    // 注意：detail 里**不打印** join code 本体，避免探针日志成为 secret 的第二落点（§47）。
    const oneTimeNote = (await text("[data-device-pairing-panel]")).includes("只显示这一次");
    check("A9 · 明确标注只显示一次", oneTimeNote, "one-time-note=" + oneTimeNote);
    const expires1 = await text("[data-device-pairing-expires]");
    check("A10 · 显示有效期倒计时 / 到期时间", expires1.includes("剩余") && expires1.includes("到期"), expires1);
    await sleep(1600);
    const expires2 = await text("[data-device-pairing-expires]");
    check("A11 · 倒计时在走（不是静态文案）", expires2 !== expires1, expires1 + " -> " + expires2);
    const firstPairingStatus = await attr("[data-device-pairing-status]", "data-device-pairing-status");
    check("A12 · 单次使用状态可见", firstPairingStatus === "ISSUED" && (await text("[data-device-pairings]")).includes("未使用（单次有效）"), "first=" + firstPairingStatus);

    const pairingRows = identity.deviceStore.allPairings();
    const dump = JSON.stringify(pairingRows);
    check("A13 · §47 pairing secret 明文不落库（真实库 0 命中）", secretValue && !dump.includes(secretValue), "pairings=" + pairingRows.length);
    const svcList = identity.deviceService.listPairings({ context: adminCtx });
    check("A14 · bridge 的 pairing.list 不含 secret 字段", svcList.ok && svcList.items.length >= 1 && !JSON.stringify(svcList.items).includes(secretValue), "items=" + (svcList.items || []).length);

    // ── 4. 撤销未使用配对 → 状态文案变化 ──────────────────────────────────
    const pairingId = await attr("[data-device-pairing-status]", "data-device-pairing");
    const revokedPairingBtn = "[data-device-pairing-revoke]";
    await click(revokedPairingBtn);
    const pairingRevoked = await waitPairingStatus(pairingId, "REVOKED");
    check("A15 · 撤销未使用配对 → 状态文案变为已撤销", pairingRevoked && (await text("[data-device-pairings]")).includes("已撤销"), await text("[data-device-pairings]"));
    check("A16 · 撤销后 join code 不再展示", !(await has("[data-device-pairing-secret]")), "secret cleared");

    // ── 5. 禁用设备 → 状态文案变化 ────────────────────────────────────────
    await click(deviceSel("Studio Mac") + ' [data-device-action="disable"]');
    const disabledOk = await waitAttr(deviceSel("Studio Mac"), "data-device-status", "DISABLED");
    check("A17 · 禁用后状态变为 DISABLED 文案", disabledOk && (await text(deviceSel("Studio Mac"))).includes("已禁用 DISABLED"), "status=" + (await attr(deviceSel("Studio Mac"), "data-device-status")));
    const dbDisabled = identity.deviceService.getDevice({ context: adminCtx, deviceId: onlineId });
    check("A18 · 主进程状态与 UI 一致（DISABLED）", dbDisabled.ok && dbDisabled.device.status === "DISABLED", "db=" + (dbDisabled.device && dbDisabled.device.status));

    // ── 6. 未知 reasonCode 的可见回退（§51：失败不能没反应）────────────────
    await click(deviceSel("Render Node") + ' [data-device-action="rename"]');
    const renameOpen = await waitSel("[data-device-rename-input]");
    await setInput("[data-device-rename-input]", "");
    await click("[data-device-rename-confirm]");
    const errShown = await waitSel("[data-device-error]");
    const errCode = errShown ? await attr("[data-device-error]", "data-device-reason") : null;
    const errText = errShown ? await text("[data-device-error]") : "";
    check("A19 · 未登记的 reasonCode 有可见回退提示（含原始 code）", errShown && errCode === "INVALID_INPUT" && errText.includes("INVALID_INPUT"), "reason=" + errCode + " text=" + errText);
    check("A20 · 错误同时点明操作上下文", errText.includes("重命名设备"), errText);

    // ── 7. 审计只读展示 + §48 页面无证书 / 私钥原文 ───────────────────────
    const auditRows = await count("[data-device-audit] [data-device-audit-event]");
    check("A21 · 审计列表只读展示事件（actor/event/reason/time）", auditRows >= 1 && (await has("[data-device-audit]")), "auditRows=" + auditRows);
    const bodyText = await js("return document.body.textContent || ''");
    check("A22 · §48 页面不含私钥 / 证书原文", !/PRIVATE KEY|BEGIN CERTIFICATE|privateKey|certificatePem/.test(bodyText), "no secret material");

    // 证书过期轴：publicDevice 不暴露 notAfter，UI 不伪造 → 明确 NOT VERIFIED
    notVerified(
      "§6 证书过期（CERT_EXPIRED）状态显示",
      "冻结的 device bridge 返回的 publicDevice 不含凭据 not_after / credential status，渲染层无法在不伪造数据的前提下显示该状态；需要后端在 §48 白名单里补一个凭据到期字段才能验证。",
    );
    // Windows 平台行为：本机为 macOS，不做平台断言
    if (process.platform !== "win32") {
      notVerified("Windows/macOS 平台特定的设备连接行为", "本轮探针在 " + process.platform + " 上运行，未覆盖 Windows 侧真实 TLS / 凭据行为。");
    }

    // 收尾交叉核对：主进程审计确实记录了本次 UI 操作
    const audit = identity.deviceStore.allAudit().map((a) => a.event);
    check("A23 · 真实审计里出现 UI 触发的 DEVICE_DISABLED / PAIRING_CREATED", audit.includes("DEVICE_DISABLED") && audit.includes("PAIRING_CREATED"), "events=" + JSON.stringify([...new Set(audit)].slice(0, 12)));

    void pending;
    void revokedId;
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try {
      win?.destroy();
    } catch {
      /* ignore */
    }
    try {
      winPreview?.destroy();
    } catch {
      /* ignore */
    }
    if (userData) {
      try {
        fs.rmSync(userData, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
