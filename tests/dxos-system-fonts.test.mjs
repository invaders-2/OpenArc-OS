/**
 * DX OS 0.6.1「系统字体」域移植回归（全离线，node:test）。
 *
 * 覆盖任务验收四条：
 *   ① 真实字体目录可枚举（默认根目录 + 分页全量遍历）；
 *   ② 未知 id → 结构化 NOT_FOUND；非法 id → INVALID_INPUT；
 *   ③ 超限拒绝（64 MB 上限；扫描跳过超限文件；读取路径独立返回 TOO_LARGE）；
 *   ④ 不读非字体目录（扩展名白名单 / 无效 SFNT / symlink 逃逸 / realpath 越界 / 不存在的根）。
 * 另覆盖 IPC 命令面与 trusted 边界、base64url 字节出口、以及"列表阶段不读整字体字节"。
 *
 * 只读源：server/systemFonts.ts（行号见 electron/system-fonts-domain.cjs 顶部注释）+
 *          server/index.ts:2057 的路由接线。
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const domain = require("../electron/system-fonts-domain.cjs");
const { createSystemFontsService } = require("../electron/system-fonts-service.cjs");
const { createSystemFontsBundle, registerSystemFontsIpc, disposeSystemFontsIpc, SYSTEM_FONTS_NOT_READY } = require("../electron/system-fonts-bootstrap.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
after(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 最小可用 SFNT：offset table + 1 张 name 表，name 记录为 platform 3 / language 0x409 / nameID 16。 */
function buildMinimalTtf(family) {
  const nameBytes = Buffer.alloc(family.length * 2);
  for (let index = 0; index < family.length; index++) nameBytes.writeUInt16BE(family.charCodeAt(index), index * 2);
  const nameTable = Buffer.alloc(6 + 12 + nameBytes.length);
  nameTable.writeUInt16BE(0, 0);
  nameTable.writeUInt16BE(1, 2);
  nameTable.writeUInt16BE(6 + 12, 4);
  nameTable.writeUInt16BE(3, 6);
  nameTable.writeUInt16BE(1, 8);
  nameTable.writeUInt16BE(0x409, 10);
  nameTable.writeUInt16BE(16, 12);
  nameTable.writeUInt16BE(nameBytes.length, 14);
  nameTable.writeUInt16BE(0, 16);
  nameBytes.copy(nameTable, 18);
  const font = Buffer.alloc(12 + 16 + nameTable.length);
  font.writeUInt32BE(0x00010000, 0);
  font.writeUInt16BE(1, 4);
  font.writeUInt16BE(16, 6);
  font.write('name', 12, 4, 'ascii');
  font.writeUInt32BE(28, 20);
  font.writeUInt32BE(nameTable.length, 24);
  nameTable.copy(font, 28);
  return font;
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) { const fn = handlers.get(channel); if (!fn) throw new Error("没有 handler：" + channel); return fn(event, raw); },
  };
}

const TRUSTED = { sender: { id: "shell" }, senderFrame: { url: "file:///app/dist/index.html" } };
const trustedGate = (event) => !!event && event.sender === TRUSTED.sender && !!event.senderFrame && event.senderFrame.url === TRUSTED.senderFrame.url;

/** 受控 io：扫描/读取两阶段可返回不同 stat，用来钉死 64 MB 上限与 realpath 越界分支。 */
function makeVirtualFontIo(data, options = {}) {
  const root = "/virtual-fonts";
  const filePath = "/virtual-fonts/fake.ttf";
  const state = { readFileCalls: 0, readPhase: false, opened: 0, closed: 0 };
  const scanSize = options.scanSize == null ? data.length : options.scanSize;
  const readSize = options.readSize == null ? data.length : options.readSize;
  const mtime = options.mtime == null ? 111 : options.mtime;
  const escapePath = options.escapePath || null;
  const stat = () => ({ isFile: () => true, size: state.readPhase ? readSize : scanSize, mtimeMs: mtime });
  const io = {
    async realpath(target) { if (escapePath && target === filePath) return escapePath; return target; },
    async readdir(target) { return target === root ? [{ name: "fake.ttf", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }] : []; },
    async stat(target) { if (target !== filePath && target !== root) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return stat(); },
    async open(target) {
      if (target !== filePath) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      state.opened += 1;
      return {
        async read(buffer, offset, length, position) { const slice = data.subarray(position, position + length); slice.copy(buffer, offset); return { bytesRead: slice.length, buffer }; },
        async stat() { return stat(); },
        async readFile() { state.readFileCalls += 1; return Buffer.from(data); },
        async close() { state.closed += 1; },
      };
    },
  };
  return { io, state, roots: [root], filePath };
}

// ---------------------------------------------------------------------------
// 1. 命令表 / 常量（源 :8、:11-15、:118、:115-120）
// ---------------------------------------------------------------------------

test("命令表：systemFonts/list 与 systemFonts/read 已登记，risk=read、credential=false、中文摘要", () => {
  assert.equal(domain.isSystemFontsCommand("systemFonts/list"), true);
  assert.equal(domain.isSystemFontsCommand("systemFonts/read"), true);
  assert.equal(domain.isSystemFontsCommand("systemFonts/delete"), false);
  assert.equal(domain.systemFontsCommandRisk("systemFonts/list"), "read");
  assert.equal(domain.systemFontsCommandRisk("systemFonts/read"), "read");
  assert.equal(domain.systemFontsCommandRequiresCredential("systemFonts/list"), false);
  assert.equal(domain.systemFontsCommandRequiresCredential("systemFonts/read"), false);
  const commands = domain.listSystemFontsCommands();
  assert.equal(commands.length, 2);
  for (const entry of commands) {
    assert.equal(entry.risk, "read");
    assert.equal(entry.needsCredential, false);
    assert.match(entry.summary, /[\u4e00-\u9fa5]/);
  }
  assert.equal(domain.SYSTEM_FONTS_COMMAND_CHANNEL, "systemFonts:command");
  assert.equal(domain.SYSTEM_FONTS_EVENT_CHANNEL, "systemFonts:event");
  // 源 :8 —— 上限必须恰为 64 MiB；源 :118 —— id 只认 64 位小写十六进制。
  assert.equal(domain.MAX_FONT_BYTES, 64 * 1024 * 1024);
  assert.equal(domain.isSystemFontId("a".repeat(64)), true);
  assert.equal(domain.isSystemFontId("A".repeat(64)), false);
  assert.equal(domain.isSystemFontId("a".repeat(63)), false);
  assert.equal(domain.isSystemFontId("0".repeat(64) + "/etc/passwd"), false);
});

test("源 :11-15 三平台字体根目录", () => {
  assert.deepEqual(domain.systemFontDirectories({ platform: "darwin", home: "/home/u" }), ["/System/Library/Fonts", "/Library/Fonts", "/home/u/Library/Fonts"]);
  assert.deepEqual(domain.systemFontDirectories({ platform: "win32", home: "/home/u", env: { WINDIR: "C:/Windows", LOCALAPPDATA: "C:/Users/u/AppData/Local" } }), ["C:/Windows/Fonts", "C:/Users/u/AppData/Local/Microsoft/Windows/Fonts"]);
  assert.deepEqual(domain.systemFontDirectories({ platform: "linux", home: "/home/u" }), ["/usr/share/fonts", "/usr/local/share/fonts", "/home/u/.local/share/fonts", "/home/u/.fonts"]);
});

// ---------------------------------------------------------------------------
// 2. SFNT 解析（源 :19-64）与边界（源 :23）
// ---------------------------------------------------------------------------

test("源 :19-64 SFNT name 表：最小 TTF 解析出字体族；非字体字节返回空数组", async () => {
  const ttf = buildMinimalTtf("OpenArc Test Family");
  const read = async (offset, length) => ttf.subarray(offset, offset + length);
  assert.deepEqual(await domain.fontFamilies(read), ["OpenArc Test Family"]);
  const zeros = Buffer.alloc(64);
  assert.deepEqual(await domain.fontFamilies(async (offset, length) => zeros.subarray(offset, offset + length)), []);
});

test("源 :23 表读取边界：单次超过 1 MB 或越过 64 MB 直接 TOO_LARGE，不分配内存", () => {
  assert.throws(() => domain.assertFontTableRead(0, domain.MAX_FONT_TABLE_BYTES + 1), (err) => err.code === domain.SYSTEM_FONTS_ERR_TOO_LARGE);
  assert.throws(() => domain.assertFontTableRead(domain.MAX_FONT_BYTES, 12), (err) => err.code === domain.SYSTEM_FONTS_ERR_TOO_LARGE);
  assert.throws(() => domain.assertFontTableRead(-1, 12), (err) => err.code === domain.SYSTEM_FONTS_ERR_INVALID_INPUT);
  assert.deepEqual(domain.assertFontTableRead(0, 12), { offset: 0, length: 12 });
});

// ---------------------------------------------------------------------------
// 3. 真实字体目录可枚举（验收 ①）
// ---------------------------------------------------------------------------

let realService = null;
function getRealService() {
  if (!realService) realService = createSystemFontsService({});
  return realService;
}

test("验收①：默认真实字体目录可枚举，条目形状为 {id, families, bytes} 且分页可全量遍历", async () => {
  const service = getRealService();
  const first = await service.listFonts({ limit: 100 });
  assert.ok(first.total > 0, "真实系统字体目录应当至少枚举到 1 个字体");
  assert.equal(first.source, "host");
  assert.equal(first.limit, 100);
  assert.equal(first.offset, 0);
  assert.equal(first.fonts.length, Math.min(100, first.total));
  assert.equal(first.hasMore, first.total > first.fonts.length);
  for (const font of first.fonts) {
    assert.match(font.id, domain.FONT_ID_RE);
    assert.ok(Array.isArray(font.families) && font.families.length > 0, "字体族不能为空");
    assert.ok(font.families.every((family) => typeof family === "string" && family.length > 0 && family.length <= 200));
    assert.ok(Number.isSafeInteger(font.bytes) && font.bytes >= 12 && font.bytes <= domain.MAX_FONT_BYTES);
    assert.equal(Object.prototype.hasOwnProperty.call(font, "path"), false, "绝对路径不得出服务层");
  }

  // 分页上限被钉在 foundation redactValue 的数组截断值（100）。
  const clamped = await service.listFonts({ limit: 100000 });
  assert.equal(clamped.limit, 100);

  const seen = new Set();
  let offset = 0;
  for (let page = 0; page < 200; page++) {
    const listed = await service.listFonts({ limit: 100, offset });
    for (const font of listed.fonts) seen.add(font.id);
    if (!listed.hasMore) break;
    offset = listed.offset + listed.limit;
  }
  assert.equal(seen.size, first.total, "分页遍历必须覆盖全量且 id 唯一");
});

// ---------------------------------------------------------------------------
// 4. 未知 / 非法 id（验收 ②）
// ---------------------------------------------------------------------------

test("验收②：未知 id → 结构化 NOT_FOUND；非法 id → INVALID_INPUT", async () => {
  const service = createSystemFontsService({ roots: [tempDir("dxos-fonts-empty-")], cacheTtlMs: 0 });
  const unknownId = "0".repeat(64);
  await assert.rejects(() => service.readFont(unknownId), (err) => err.code === domain.SYSTEM_FONTS_ERR_NOT_FOUND);
  await assert.rejects(() => service.readFont("../../etc/passwd"), (err) => err.code === domain.SYSTEM_FONTS_ERR_INVALID_INPUT);
  await assert.rejects(() => service.readFont(null), (err) => err.code === domain.SYSTEM_FONTS_ERR_INVALID_INPUT);

  // 同一判据经 IPC 出口：结构化 { ok:false, error } 而不是异常串。
  const ipcMain = fakeIpcMain();
  const bundle = createSystemFontsBundle({ roots: [tempDir("dxos-fonts-ipc-empty-")] });
  registerSystemFontsIpc({ ipcMain, bundle, isTrusted: () => true });
  const notFound = await ipcMain.invoke("systemFonts:command", TRUSTED, { command: "systemFonts/read", payload: { id: unknownId } });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error, domain.SYSTEM_FONTS_ERR_NOT_FOUND);
  const invalid = await ipcMain.invoke("systemFonts:command", TRUSTED, { command: "systemFonts/read", payload: { id: "not-an-id" } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, domain.SYSTEM_FONTS_ERR_INVALID_INPUT);
  disposeSystemFontsIpc({ ipcMain });
});

test("验收②：字体在列表后被删除 → NOT_FOUND（源 :119 把读取期失败收敛成 404）", async () => {
  const dir = tempDir("dxos-fonts-vanish-");
  const fontPath = path.join(dir, "vanish.ttf");
  fs.writeFileSync(fontPath, buildMinimalTtf("Vanish Family"));
  const service = createSystemFontsService({ roots: [dir] });
  const listed = await service.listFonts({});
  assert.equal(listed.total, 1);
  fs.rmSync(fontPath);
  await assert.rejects(() => service.readFont(listed.fonts[0].id), (err) => err.code === domain.SYSTEM_FONTS_ERR_NOT_FOUND);
});

// ---------------------------------------------------------------------------
// 5. 超限拒绝（验收 ③）与"列表不读整字体字节"
// ---------------------------------------------------------------------------

test("验收③：assertFontSize 对 >64 MB 返回 TOO_LARGE", () => {
  assert.throws(() => domain.assertFontSize(domain.MAX_FONT_BYTES + 1), (err) => err.code === domain.SYSTEM_FONTS_ERR_TOO_LARGE);
  assert.throws(() => domain.assertFontSize(11), (err) => err.code === domain.SYSTEM_FONTS_ERR_INVALID_INPUT);
  assert.equal(domain.assertFontSize(domain.MAX_FONT_BYTES), domain.MAX_FONT_BYTES);
});

test("验收③：扫描跳过超过注入上限的真实字体文件（不读它的字节）", async () => {
  const dir = tempDir("dxos-fonts-overlimit-");
  const ttf = buildMinimalTtf("Too Big Family");
  fs.writeFileSync(path.join(dir, "big.ttf"), Buffer.concat([ttf, Buffer.alloc(2048)]));
  fs.writeFileSync(path.join(dir, "small.ttf"), ttf);
  const service = createSystemFontsService({ roots: [dir], maxBytes: 1024, cacheTtlMs: 0 });
  const listed = await service.listFonts({});
  assert.equal(listed.total, 1);
  assert.equal(listed.fonts[0].bytes, ttf.length);
  assert.deepEqual(listed.fonts[0].families, ["Too Big Family"]);
});

test("验收③：读取路径的 64 MB 上限有独立失败码 SYSTEM_FONTS_TOO_LARGE（在'已变更'之前判定）", async () => {
  const ttf = buildMinimalTtf("Over Limit At Read");
  const { io, state, roots } = makeVirtualFontIo(ttf, { readSize: domain.MAX_FONT_BYTES + 1 });
  const service = createSystemFontsService({ roots, io });
  const listed = await service.listFonts({});
  assert.equal(listed.total, 1);
  state.readPhase = true;
  await assert.rejects(() => service.readFont(listed.fonts[0].id), (err) => err.code === domain.SYSTEM_FONTS_ERR_TOO_LARGE);
  assert.equal(state.readFileCalls, 0, "超限时必须先拒绝，不能把字节读进内存");
});

test("列表阶段只读 name 表，不调用整文件读取；read 才读一次整文件", async () => {
  const ttf = buildMinimalTtf("Lazy Bytes");
  const { io, state, roots } = makeVirtualFontIo(ttf);
  const service = createSystemFontsService({ roots, io });
  const listed = await service.listFonts({});
  assert.equal(listed.total, 1);
  assert.equal(state.readFileCalls, 0);
  const read = await service.readFont(listed.fonts[0].id);
  assert.equal(state.readFileCalls, 1);
  assert.equal(read.bytes, ttf.length);
  assert.equal(state.closed, state.opened, "每个打开的句柄都必须关闭");
});

// ---------------------------------------------------------------------------
// 6. 不读非字体目录（验收 ④）
// ---------------------------------------------------------------------------

test("验收④：非字体文件 / 无效 SFNT / 嵌套目录 / symlink 逃逸 全部不入目录", async () => {
  const root = tempDir("dxos-fonts-nonfont-");
  const outside = tempDir("dxos-fonts-outside-");
  const valid = buildMinimalTtf("Outside Family");
  fs.writeFileSync(path.join(outside, "outside.ttf"), valid);
  fs.writeFileSync(path.join(root, "notes.txt"), "just text");
  fs.writeFileSync(path.join(root, "image.png"), Buffer.alloc(64, 7));
  fs.writeFileSync(path.join(root, "broken.ttf"), Buffer.from("this is not a real sfnt font file at all"));
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "data.bin"), Buffer.alloc(32));
  try { fs.symlinkSync(path.join(outside, "outside.ttf"), path.join(root, "escaped.ttf")); } catch { /* 无权限创建 symlink 时跳过该子项 */ }
  try { fs.symlinkSync(outside, path.join(root, "escaped-dir")); } catch { /* 同上 */ }

  const service = createSystemFontsService({ roots: [root], cacheTtlMs: 0 });
  const listed = await service.listFonts({});
  assert.equal(listed.total, 0, "非字体目录不得产出任何字体条目");
});

test("验收④：realpath 落到根之外的文件被丢弃（源 :87 归属判定）", async () => {
  const ttf = buildMinimalTtf("Escaping Family");
  const { io, roots } = makeVirtualFontIo(ttf, { escapePath: "/outside/fake.ttf" });
  const service = createSystemFontsService({ roots, io });
  const listed = await service.listFonts({});
  assert.equal(listed.total, 0);
});

test("验收④：不存在的根目录静默跳过，不抛异常", async () => {
  const service = createSystemFontsService({ roots: [path.join(os.tmpdir(), "dxos-fonts-does-not-exist-" + Date.now())], cacheTtlMs: 0 });
  const listed = await service.listFonts({});
  assert.equal(listed.total, 0);
  assert.equal(listed.source, "host");
});

// ---------------------------------------------------------------------------
// 7. IPC 命令面 + trusted 边界 + base64url 出口
// ---------------------------------------------------------------------------

test("IPC：trusted fail closed（缺 isTrusted / 伪造 sender 一律 Forbidden），且先于 bundle 判空", async () => {
  const ipcMain = fakeIpcMain();
  registerSystemFontsIpc(ipcMain, { bundle: null, isTrusted: null });
  await assert.rejects(() => ipcMain.invoke("systemFonts:command", TRUSTED, { command: "systemFonts/list" }), /Forbidden/);
  disposeSystemFontsIpc(ipcMain);

  const ipcMain2 = fakeIpcMain();
  const bundle = createSystemFontsBundle({ roots: [] });
  registerSystemFontsIpc(ipcMain2, { bundle, isTrusted: trustedGate });
  await assert.rejects(() => ipcMain2.invoke("systemFonts:command", { sender: { id: "evil" }, senderFrame: { url: "https://evil.example/" } }, { command: "systemFonts/list" }), /Forbidden/);
  disposeSystemFontsIpc(ipcMain2);
});

test("IPC：未装配 → SYSTEM_FONTS_NOT_READY；非对象载荷 / 未白名单命令 → 结构化错误；dispose 后可重复注册", async () => {
  const ipcMain = fakeIpcMain();
  const first = registerSystemFontsIpc(ipcMain, { bundle: null, isTrusted: () => true });
  assert.equal(first.channel, "systemFonts:command");
  assert.equal(first.eventChannel, "systemFonts:event");
  const notReady = await ipcMain.invoke("systemFonts:command", TRUSTED, { command: "systemFonts/list" });
  assert.equal(notReady.error, SYSTEM_FONTS_NOT_READY);
  disposeSystemFontsIpc({ ipcMain });
  assert.equal(ipcMain.handlers.has("systemFonts:command"), false, "dispose 必须移除 handler");

  const bundle = createSystemFontsBundle({ roots: [tempDir("dxos-fonts-ipc-")] });
  registerSystemFontsIpc({ ipcMain, bundle, isTrusted: () => true });
  const bad = await ipcMain.invoke("systemFonts:command", TRUSTED, null);
  assert.equal(bad.error, domain.SYSTEM_FONTS_ERR_INVALID_INPUT);
  const unknown = await ipcMain.invoke("systemFonts:command", TRUSTED, { type: "systemFonts/delete" });
  assert.equal(unknown.error, domain.SYSTEM_FONTS_ERR_COMMAND_NOT_ALLOWED);
  disposeSystemFontsIpc({ ipcMain });
});

test("IPC：command / type 两种写法都可用；refresh 触发 progress 事件；payload.userId 被忽略", async () => {
  const dir = tempDir("dxos-fonts-ipc-event-");
  const ttf = buildMinimalTtf("Ipc Family");
  fs.writeFileSync(path.join(dir, "ipc.ttf"), ttf);
  const ipcMain = fakeIpcMain();
  const events = [];
  const bundle = createSystemFontsBundle({ roots: [dir] });
  registerSystemFontsIpc(ipcMain, { bundle, isTrusted: () => true, identity: { current: "session-1" }, send: (event) => events.push(event) });

  const listed = await ipcMain.invoke("systemFonts:command", TRUSTED, { command: "systemFonts/list", payload: { refresh: true, userId: "spoofed", role: "ADMIN" } });
  assert.equal(listed.ok, true);
  assert.equal(listed.value.total, 1);
  assert.equal(listed.value.fonts[0].families[0], "Ipc Family");
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, "systemFonts:event");
  assert.equal(events[0].domain, "systemFonts");
  assert.equal(events[0].kind, "progress");
  assert.equal(events[0].sequence, 1);
  assert.equal(events[0].payload.phase, "refreshed");

  const byType = await ipcMain.invoke("systemFonts:command", TRUSTED, { type: "systemFonts/read", payload: { id: listed.value.fonts[0].id } });
  assert.equal(byType.ok, true);
  assert.equal(byType.value.encoding, "base64url");
  assert.equal(byType.value.bytes, ttf.length);
  assert.equal(Buffer.from(byType.value.data, "base64url").equals(ttf), true, "base64url 解码必须还原原始字体字节");
  assert.equal(/[+/=]/.test(byType.value.data), false, "base64url 不得含 + / =（否则会被路径/密钥脱敏误伤）");
  disposeSystemFontsIpc({ ipcMain });
});

test("IPC：路径式调用签名 registerSystemFontsIpc(ipcMain, deps) 同样可用", async () => {
  const dir = tempDir("dxos-fonts-ipc-positional-");
  fs.writeFileSync(path.join(dir, "p.ttf"), buildMinimalTtf("Positional Family"));
  const ipcMain = fakeIpcMain();
  const bundle = createSystemFontsBundle({ roots: [dir] });
  const handle = registerSystemFontsIpc(ipcMain, { bundle, isTrusted: () => true });
  const listed = await ipcMain.invoke(handle.channel, TRUSTED, { command: "systemFonts/list", payload: { limit: 1 } });
  assert.equal(listed.ok, true);
  assert.equal(listed.value.total, 1);
  disposeSystemFontsIpc(ipcMain);
});
