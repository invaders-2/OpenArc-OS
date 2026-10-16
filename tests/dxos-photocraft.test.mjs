/**
 * PhotoCraft（图像工坊）域移植回归测试（全离线：真 IdentityStore + 假授权 + 临时 userData；
 * 不启动 Electron、不联网、不跑 GUI）。
 *
 * 覆盖任务书验收条目：
 *   ① 创建 / 改名校验（标题清洗、截断、默认标题、非法 id 形态）
 *   ② visibility 三态（private / public / restricted + 成员可读、非成员不可见）
 *   ③ 非 owner 不可编辑（update / writeSource / export / trash 一律 FORBIDDEN）
 *   ④ 成员可读（restricted 成员可 get / readSource）
 *   ⑤ 回收站 → 恢复 → 彻底删除（dxos-fs 虚拟树同级语义）
 *   ⑥ 导出产物（写入 导出/，图片刷新预览）
 *   ⑦ 剪贴板临时（同名覆盖、异名新建）
 *   ⑧ save-bundle 结构化不支持（两条命令名）
 *   ⑨ 未知 id NOT_FOUND
 *   附加：分组增删与项目回退、命令白名单、trusted fail-closed、未认证、fs 根级联、runtime 纯工具。
 *
 * 只读源：server/photocraftProjects.ts、server/photocraftRuntime.ts、server/index.ts:5748-5843。
 * 行号引用见 electron/photocraft-{domain,store,service,bootstrap}.cjs 顶部注释。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const domain = require("../electron/photocraft-domain.cjs");
const { createPhotocraftBundle, PhotocraftService } = require("../electron/photocraft-service.cjs");
const { PhotocraftStore } = require("../electron/photocraft-store.cjs");
const { registerPhotocraftIpc, disposePhotocraftIpc, PHOTOCRAFT_CHANNEL, PHOTOCRAFT_NOT_READY } = require("../electron/photocraft-bootstrap.cjs");
const { IdentityStore } = require("../electron/identity-store.cjs");

const ERR = domain;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tmpUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-photocraft-"));
  tmpDirs.push(dir);
  return dir;
}

const START = 1800000000000;
const USERS = {
  owner: "usr_owner0000000000000000000000000",
  member: "usr_member000000000000000000000000",
  stranger: "usr_stranger000000000000000000000",
  other: "usr_other0000000000000000000000000",
};
const SESSIONS = { owner: "sref_owner", member: "sref_member", stranger: "sref_stranger", other: "sref_other" };

function makeAuthorization() {
  const bySession = {
    [SESSIONS.owner]: USERS.owner,
    [SESSIONS.member]: USERS.member,
    [SESSIONS.stranger]: USERS.stranger,
    [SESSIONS.other]: USERS.other,
  };
  return {
    resolveActor: ({ context }) => {
      const id = bySession[context && context.sessionRef];
      return id ? { ok: true, user: { id, role: "MEMBER" } } : { ok: false, error: "SESSION_INVALID" };
    },
  };
}

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

function makeHarness(options = {}) {
  const dir = tmpUserData();
  let current = START;
  const clock = typeof options.clock === "function" ? options.clock : () => current;
  const identity = new IdentityStore({ path: ":memory:", clock }).open();
  const bundle = createPhotocraftBundle({ userDataDir: dir, identity, authorization: makeAuthorization(), clock });
  const identityRef = { current: SESSIONS.owner };
  const ipcMain = fakeIpcMain();
  registerPhotocraftIpc(ipcMain, { bundle, identity: identityRef, isTrusted: (event) => !!event && event.sender === "shell" });
  const call = (command, payload, sessionRef = SESSIONS.owner) => {
    identityRef.current = sessionRef;
    return ipcMain.invoke(PHOTOCRAFT_CHANNEL, TRUSTED_EVENT, { command, payload });
  };
  return {
    dir, identity, bundle, ipcMain, identityRef, call,
    now: () => current,
    advance: (ms) => { current += ms; return current; },
    cacheFolderOf(ownerId, projectId) { return bundle.store.existingCacheFolder(ownerId, projectId); },
    async createProject(overrides = {}, sessionRef = SESSIONS.owner) {
      const res = await call("photocraft/projects/create", Object.assign({ title: "测试项目" }, overrides), sessionRef);
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.value.project;
    },
  };
}

const b64 = (value) => Buffer.from(value).toString("base64");

// ---------------------------------------------------------------------------
// 命令表（冻结名逐条核对）
// ---------------------------------------------------------------------------
test("命令白名单：14 条冻结名 + saveBundle 两条别名；每条有 risk/summary", () => {
  const frozen = [
    "photocraft/projects/list", "photocraft/projects/create", "photocraft/projects/get",
    "photocraft/projects/update", "photocraft/projects/trash", "photocraft/projects/restore",
    "photocraft/projects/purge", "photocraft/projects/readSource", "photocraft/projects/writeSource",
    "photocraft/projects/export", "photocraft/projects/saveClipboardTemp",
    "photocraft/trash/list", "photocraft/groups/create", "photocraft/groups/remove",
  ];
  for (const command of frozen) assert.equal(domain.isPhotocraftCommand(command), true, "缺少冻结命令：" + command);
  assert.equal(domain.isPhotocraftCommand("photocraft/projects/saveBundle"), true, "save-bundle 必须登记为结构化不支持");
  assert.equal(domain.isPhotocraftCommand("photocraft/projects/save-bundle"), true, "连字符别名必须登记");
  for (const entry of domain.listPhotocraftCommands()) {
    assert.ok(["read", "write", "delete"].includes(entry.risk), "非法 risk：" + entry.command);
    assert.ok(typeof entry.summary === "string" && entry.summary.length >= 6, "summary 过短：" + entry.command);
    assert.equal(domain.PHOTOCRAFT_CHANNEL, "photocraft:command");
  }
  assert.equal(domain.isPhotocraftCommand("photocraft/projects/evil"), false);
});

// ---------------------------------------------------------------------------
// ① 创建 / 改名校验
// ---------------------------------------------------------------------------
test("创建：默认分组 + private；标题清洗非法字符；无标题回退默认", async () => {
  const h = makeHarness();
  const list0 = await h.call("photocraft/projects/list", {});
  assert.equal(list0.ok, true, JSON.stringify(list0));
  assert.equal(list0.value.projects.length, 0);
  const groups = list0.value.groups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "默认分组");
  assert.equal(groups[0].isDefault, true);

  const created = await h.call("photocraft/projects/create", { title: "a/b:c*?d" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.project.title, "a_b_c__d");
  assert.equal(created.value.project.visibility, "private");
  assert.equal(created.value.project.mine, true);
  assert.equal(created.value.project.access, "owner");
  assert.equal(created.value.project.groupId, groups[0].id);

  const untitled = await h.call("photocraft/projects/create", {});
  assert.equal(untitled.value.project.title, "未命名项目");

  // 改名 + 超长标题截断到 120
  const long = "长".repeat(400);
  const updated = await h.call("photocraft/projects/update", { id: created.value.project.id, title: long });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.value.project.title.length, 120);

  // 非法 id 形态 → INVALID_INPUT；未知 id → NOT_FOUND
  const badId = await h.call("photocraft/projects/get", { id: "a/b" });
  assert.equal(badId.ok, false);
  assert.equal(badId.error, ERR.PHOTOCRAFT_ERR_INVALID_INPUT);
  const missing = await h.call("photocraft/projects/get", { id: "00000000-0000-4000-8000-000000000000" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, ERR.PHOTOCRAFT_ERR_NOT_FOUND);
  const noId = await h.call("photocraft/projects/get", {});
  assert.equal(noId.error, ERR.PHOTOCRAFT_ERR_INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// ② visibility 三态 + ④ 成员可读 + ③ 非 owner 不可编辑
// ---------------------------------------------------------------------------
test("visibility 三态：private 陌生人不可见；public 可见；restricted 仅成员可见", async () => {
  const h = makeHarness();
  const project = await h.createProject({ title: "共享测试" });

  // private：陌生人 get → FORBIDDEN，列表看不到
  const strangerPrivate = await h.call("photocraft/projects/get", { id: project.id }, SESSIONS.stranger);
  assert.equal(strangerPrivate.ok, false);
  assert.equal(strangerPrivate.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);
  const strangerList0 = await h.call("photocraft/projects/list", {}, SESSIONS.stranger);
  assert.equal(strangerList0.value.projects.length, 0);

  // public：陌生人可见
  const toPublic = await h.call("photocraft/projects/update", { id: project.id, visibility: "public" });
  assert.equal(toPublic.value.project.visibility, "public");
  const strangerPublic = await h.call("photocraft/projects/get", { id: project.id }, SESSIONS.stranger);
  assert.equal(strangerPublic.ok, true, JSON.stringify(strangerPublic));
  assert.equal(strangerPublic.value.project.access, "read");
  const strangerList1 = await h.call("photocraft/projects/list", {}, SESSIONS.stranger);
  assert.equal(strangerList1.value.projects.length, 1);

  // restricted + 成员：成员可读，非成员不可见
  const toRestricted = await h.call("photocraft/projects/update", { id: project.id, visibility: "restricted", members: [USERS.member, USERS.member] });
  assert.equal(toRestricted.value.project.visibility, "restricted");
  assert.deepEqual(toRestricted.value.project.members, [USERS.member], "成员去重");
  const memberGet = await h.call("photocraft/projects/get", { id: project.id }, SESSIONS.member);
  assert.equal(memberGet.ok, true, JSON.stringify(memberGet));
  assert.equal(memberGet.value.project.mine, false);
  const otherGet = await h.call("photocraft/projects/get", { id: project.id }, SESSIONS.other);
  assert.equal(otherGet.ok, false);
  assert.equal(otherGet.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);

  // private：成员也不可见，且成员表被清空（源 :163 逐字对齐）
  const backPrivate = await h.call("photocraft/projects/update", { id: project.id, visibility: "private" });
  assert.deepEqual(backPrivate.value.project.members, []);
  const memberAfter = await h.call("photocraft/projects/get", { id: project.id }, SESSIONS.member);
  assert.equal(memberAfter.ok, false);
  assert.equal(memberAfter.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);

  // 成员 id 非法 → INVALID_INPUT
  const badMember = await h.call("photocraft/projects/update", { id: project.id, visibility: "restricted", members: ["bad/member"] });
  assert.equal(badMember.ok, false);
  assert.equal(badMember.error, ERR.PHOTOCRAFT_ERR_INVALID_INPUT);
});

test("非 owner 不可编辑：update / writeSource / export / trash / purge 一律 FORBIDDEN", async () => {
  const h = makeHarness();
  const project = await h.createProject({ title: "仅 owner" });
  await h.call("photocraft/projects/update", { id: project.id, visibility: "restricted", members: [USERS.member] });

  const update = await h.call("photocraft/projects/update", { id: project.id, title: "篡改" }, SESSIONS.member);
  assert.equal(update.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);
  const write = await h.call("photocraft/projects/writeSource", { id: project.id, name: "x.bin", content: b64("x") }, SESSIONS.member);
  assert.equal(write.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);
  const exported = await h.call("photocraft/projects/export", { id: project.id, name: "x.png", mime: "image/png", content: b64("x") }, SESSIONS.member);
  assert.equal(exported.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);
  const clipboard = await h.call("photocraft/projects/saveClipboardTemp", { id: project.id, content: b64("x") }, SESSIONS.member);
  assert.equal(clipboard.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);
  const trashed = await h.call("photocraft/projects/trash", { id: project.id }, SESSIONS.stranger);
  assert.equal(trashed.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);

  // owner 仍然能改
  const owned = await h.call("photocraft/projects/update", { id: project.id, title: "owner 改名" });
  assert.equal(owned.ok, true);
});

test("成员可读源文件：restricted 成员 readSource 成功，非成员 FORBIDDEN", async () => {
  const h = makeHarness();
  const bytes = Buffer.from("photoshop-bytes");
  const project = await h.createProject({ title: "源文件", name: "稿.psd", mime: "image/vnd.adobe.photoshop", content: bytes.toString("base64") });
  await h.call("photocraft/projects/update", { id: project.id, visibility: "restricted", members: [USERS.member] });

  const memberRead = await h.call("photocraft/projects/readSource", { id: project.id }, SESSIONS.member);
  assert.equal(memberRead.ok, true, JSON.stringify(memberRead));
  assert.equal(memberRead.value.name, "稿.psd");
  assert.equal(memberRead.value.mime, "image/vnd.adobe.photoshop");
  assert.equal(memberRead.value.size, bytes.length);
  assert.equal(memberRead.value.base64, bytes.toString("base64"));
  assert.equal(memberRead.value.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal("path" in memberRead.value, false, "不得回宿主路径");

  const outsiderRead = await h.call("photocraft/projects/readSource", { id: project.id }, SESSIONS.stranger);
  assert.equal(outsiderRead.error, ERR.PHOTOCRAFT_ERR_FORBIDDEN);
});

// ---------------------------------------------------------------------------
// ⑤ 回收站 → 恢复 → 彻底删除
// ---------------------------------------------------------------------------
test("回收站：trash → 列表隐藏/回收站可见 → restore 恢复文件 → purge 彻底删除", async () => {
  const h = makeHarness();
  const bytes = Buffer.from("keep-me");
  const project = await h.createProject({ title: "回收站项目", name: "a.bin", content: bytes.toString("base64") });
  const diskFolder = h.cacheFolderOf(USERS.owner, project.id);
  assert.ok(diskFolder, "缓存目录应已建立");
  assert.equal(h.bundle.store.fs.isInTrash(diskFolder.id), false);

  // purge 前必须先入回收站
  const early = await h.call("photocraft/projects/purge", { id: project.id });
  assert.equal(early.ok, false);
  assert.equal(early.error, ERR.PHOTOCRAFT_ERR_CONFLICT);

  const trashed = await h.call("photocraft/projects/trash", { id: project.id });
  assert.equal(trashed.ok, true, JSON.stringify(trashed));
  assert.deepEqual(trashed.value, {});
  const afterTrash = await h.call("photocraft/projects/list", {});
  assert.equal(afterTrash.value.projects.length, 0, "回收站项目不出现在正常列表");
  const trashList = await h.call("photocraft/trash/list", {});
  assert.equal(trashList.value.projects.length, 1);
  assert.equal(trashList.value.projects[0].visibility, "private");
  const getTrashed = await h.call("photocraft/projects/get", { id: project.id });
  assert.equal(getTrashed.error, ERR.PHOTOCRAFT_ERR_NOT_FOUND);

  const restored = await h.call("photocraft/projects/restore", { id: project.id });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const readBack = await h.call("photocraft/projects/readSource", { id: project.id });
  assert.equal(readBack.value.base64, bytes.toString("base64"), "恢复后源文件内容不变");
  const afterRestore = await h.call("photocraft/projects/list", {});
  assert.equal(afterRestore.value.projects.length, 1);

  // 再入回收站 → purge
  await h.call("photocraft/projects/trash", { id: project.id });
  const purged = await h.call("photocraft/projects/purge", { id: project.id });
  assert.equal(purged.ok, true, JSON.stringify(purged));
  assert.deepEqual(purged.value, {});
  const afterPurge = await h.call("photocraft/projects/get", { id: project.id });
  assert.equal(afterPurge.error, ERR.PHOTOCRAFT_ERR_NOT_FOUND);
  const purgedFolder = h.bundle.store.readNodesSnapshot().find((node) => node.id === diskFolder.id);
  assert.equal(purgedFolder, undefined, "缓存目录连同子树被彻底删除");
  assert.equal(h.bundle.store.membersOf(project.id).length, 0, "members 随 CASCADE 清空");
  // 幂等：再次 purge 回 NOT_FOUND（行已不存在）
  const again = await h.call("photocraft/projects/purge", { id: project.id });
  assert.equal(again.error, ERR.PHOTOCRAFT_ERR_NOT_FOUND);
});

// ---------------------------------------------------------------------------
// ⑥ 导出产物
// ---------------------------------------------------------------------------
test("导出：产物写入 导出/ 且图片刷新预览；非图片不改预览", async () => {
  const h = makeHarness();
  const project = await h.createProject({ title: "导出测试" });
  const png = Buffer.from("png-bytes");
  const exported = await h.call("photocraft/projects/export", { id: project.id, name: "成品.png", mime: "image/png", content: png.toString("base64") });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.value.node.name, "成品.png");
  const projectAfter = exported.value.project;
  assert.equal(projectAfter.previewSha256, exported.value.node.blobSha256 || projectAfter.previewSha256);
  const previewId = h.bundle.store.getProject(project.id).preview_node_id;
  assert.equal(previewId, exported.value.node.id, "图片导出成为预览节点");

  const blob = Buffer.from("zip-bytes");
  const exported2 = await h.call("photocraft/projects/export", { id: project.id, name: "打包.zip", mime: "application/zip", content: blob.toString("base64") });
  assert.equal(exported2.ok, true, JSON.stringify(exported2));
  const previewId2 = h.bundle.store.getProject(project.id).preview_node_id;
  assert.equal(previewId2, previewId, "非图片导出不得覆盖既有预览");

  // 导出节点确实落在 <缓存>/<项目 id>/导出/<名字>
  const folder = h.cacheFolderOf(USERS.owner, project.id);
  const exportFolder = h.bundle.store.fs.listChildren(folder.id).nodes.find((node) => node.type === "folder" && node.name === "导出");
  assert.ok(exportFolder, "导出目录必须存在");
  const names = h.bundle.store.fs.listChildren(exportFolder.id).nodes.map((node) => node.name).sort();
  assert.deepEqual(names, ["成品.png", "打包.zip"]);
});

// ---------------------------------------------------------------------------
// ⑦ 剪贴板临时
// ---------------------------------------------------------------------------
test("剪贴板临时：默认名同名覆盖（同一节点），异名新建", async () => {
  const h = makeHarness();
  const project = await h.createProject({ title: "剪贴板" });
  const first = await h.call("photocraft/projects/saveClipboardTemp", { id: project.id, content: b64("AAAA") });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.node.name, "剪贴板粘贴.png");
  const second = await h.call("photocraft/projects/saveClipboardTemp", { id: project.id, content: b64("BBBBBB") });
  assert.equal(second.value.node.id, first.value.node.id, "同名必须覆盖同一节点");
  assert.equal(second.value.node.size, 6);
  const third = await h.call("photocraft/projects/saveClipboardTemp", { id: project.id, name: "另一张.png", content: b64("CC") });
  assert.notEqual(third.value.node.id, first.value.node.id);
  const folder = h.cacheFolderOf(USERS.owner, project.id);
  const tempFolder = h.bundle.store.fs.listChildren(folder.id).nodes.find((node) => node.type === "folder" && node.name === "临时");
  assert.equal(h.bundle.store.fs.listChildren(tempFolder.id).nodes.length, 2);
});

// ---------------------------------------------------------------------------
// ⑧ save-bundle 结构化不支持
// ---------------------------------------------------------------------------
test("save-bundle：两条命令名都回结构化 UNSUPPORTED，指向 file-transfer", async () => {
  const h = makeHarness();
  for (const command of ["photocraft/projects/saveBundle", "photocraft/projects/save-bundle"]) {
    const res = await h.call(command, { id: "00000000-0000-4000-8000-000000000000" });
    assert.equal(res.ok, false, command);
    assert.equal(res.error, ERR.PHOTOCRAFT_ERR_UNSUPPORTED, command);
    assert.equal(res.detail.delegate, "fileTransfer");
    assert.deepEqual(res.detail.commands, ["fileTransfer/begin", "fileTransfer/chunk", "fileTransfer/complete"]);
  }
});

// ---------------------------------------------------------------------------
// ⑨ 未知 id NOT_FOUND（各命令）
// ---------------------------------------------------------------------------
test("未知 id：get/update/trash/restore/purge/readSource/writeSource 全部 NOT_FOUND", async () => {
  const h = makeHarness();
  const missingId = "11111111-1111-4111-8111-111111111111";
  const cases = [
    ["photocraft/projects/get", { id: missingId }],
    ["photocraft/projects/update", { id: missingId, title: "x" }],
    ["photocraft/projects/trash", { id: missingId }],
    ["photocraft/projects/restore", { id: missingId }],
    ["photocraft/projects/purge", { id: missingId }],
    ["photocraft/projects/readSource", { id: missingId }],
    ["photocraft/projects/writeSource", { id: missingId, content: b64("x") }],
    ["photocraft/projects/export", { id: missingId, content: b64("x") }],
    ["photocraft/projects/saveClipboardTemp", { id: missingId, content: b64("x") }],
  ];
  for (const [command, payload] of cases) {
    const res = await h.call(command, payload);
    assert.equal(res.ok, false, command);
    assert.equal(res.error, ERR.PHOTOCRAFT_ERR_NOT_FOUND, command);
  }
  const badGroup = await h.call("photocraft/groups/remove", { id: missingId });
  assert.equal(badGroup.error, ERR.PHOTOCRAFT_ERR_NOT_FOUND);
});

// ---------------------------------------------------------------------------
// 分组：增删 + 项目回退
// ---------------------------------------------------------------------------
test("分组：新建同名复用；删除分组把项目移回默认分组；默认分组不可删", async () => {
  const h = makeHarness();
  const created = await h.call("photocraft/groups/create", { name: "设计/稿" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.group.name, "设计_稿");
  const again = await h.call("photocraft/groups/create", { name: "设计/稿" });
  assert.equal(again.value.group.id, created.value.group.id, "同名复用");

  const project = await h.createProject({ title: "在分组里", groupId: created.value.group.id });
  assert.equal(project.groupId, created.value.group.id);
  const list = await h.call("photocraft/projects/list", {});
  assert.equal(list.value.groups.some((group) => group.id === created.value.group.id && group.mine === true), true);

  const removed = await h.call("photocraft/groups/remove", { id: created.value.group.id });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.value.deleted, created.value.group.id);
  assert.equal(removed.value.moved, 1);
  const fallback = h.bundle.store.getProject(project.id).group_id;
  assert.equal(fallback, removed.value.fallbackGroupId);
  const afterMove = await h.call("photocraft/projects/get", { id: project.id });
  assert.equal(afterMove.value.project.groupId, removed.value.fallbackGroupId);

  const defaultGroupId = h.bundle.store.defaultGroup(USERS.owner);
  const deny = await h.call("photocraft/groups/remove", { id: defaultGroupId });
  assert.equal(deny.ok, false);
  assert.equal(deny.error, ERR.PHOTOCRAFT_ERR_CONFLICT);
});

// ---------------------------------------------------------------------------
// 写源文件 / 覆盖
// ---------------------------------------------------------------------------
test("writeSource：无源文件时新建；已有源文件时覆盖同一节点并改名", async () => {
  const h = makeHarness();
  const project = await h.createProject({ title: "写源" });
  const first = await h.call("photocraft/projects/writeSource", { id: project.id, name: "v1.txt", mime: "text/plain", content: b64("hello") });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.node.name, "v1.txt");
  const firstId = first.value.node.id;
  const second = await h.call("photocraft/projects/writeSource", { id: project.id, name: "v2.txt", mime: "text/plain", content: b64("world!") });
  assert.equal(second.value.node.id, firstId, "覆盖既有源文件节点");
  assert.equal(second.value.node.name, "v2.txt");
  const readBack = await h.call("photocraft/projects/readSource", { id: project.id });
  assert.equal(Buffer.from(readBack.value.base64, "base64").toString(), "world!");
  const empty = await h.call("photocraft/projects/writeSource", { id: project.id, name: "x.txt" });
  assert.equal(empty.error, ERR.PHOTOCRAFT_ERR_INVALID_INPUT);
});

test("内容上限：base64 非法 / 超 24MiB 拒绝", async () => {
  const h = makeHarness();
  const project = await h.createProject({ title: "上限" });
  const bad = await h.call("photocraft/projects/writeSource", { id: project.id, content: "!!!not-base64!!!" });
  assert.equal(bad.error, ERR.PHOTOCRAFT_ERR_INVALID_INPUT);
  const tooBig = await h.call("photocraft/projects/writeSource", { id: project.id, content: Buffer.alloc(domain.PHOTOCRAFT_MAX_INLINE_BYTES + 1).toString("base64") });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error, ERR.PHOTOCRAFT_ERR_TOO_LARGE);
});

// ---------------------------------------------------------------------------
// fs 根级联（源 :267-312）
// ---------------------------------------------------------------------------
test("fs 根级联：trashForFsRoot / restoreForFsRoot / deleteForFsRoot 联动项目行", async () => {
  const h = makeHarness();
  // 缓存目录只在项目真正有文件时才建立（源 :112-127），所以这里带内容建项目。
  const project = await h.createProject({ title: "级联", name: "a.bin", content: b64("cascade") });
  const cacheRoot = h.bundle.store.cacheRoot(USERS.owner);
  assert.equal(h.bundle.service.projectIdsWithinFsRoot(cacheRoot).includes(project.id), true);
  assert.equal(h.bundle.cascade.trashForFsRoot(cacheRoot), 1);
  assert.notEqual(h.bundle.store.getProject(project.id).deleted_at, null);
  assert.equal(h.bundle.cascade.restoreForFsRoot(cacheRoot), 1);
  assert.equal(h.bundle.store.getProject(project.id).deleted_at, null);
  assert.equal(h.bundle.cascade.deleteForFsRoot(cacheRoot), 1);
  assert.equal(h.bundle.store.getProject(project.id), null);
  assert.equal(h.bundle.cascade.deleteForFsRoot(cacheRoot), 0);
});

// ---------------------------------------------------------------------------
// bootstrap：trusted / 未装配 / 未登记 / 未认证 / dispose
// ---------------------------------------------------------------------------
test("bootstrap：trusted fail-closed、未装配 NOT_READY、未登记/未认证、可重复注册与 dispose", async () => {
  const h = makeHarness();

  const noTrust = fakeIpcMain();
  registerPhotocraftIpc(noTrust, { bundle: h.bundle });
  await assert.rejects(() => noTrust.invoke(PHOTOCRAFT_CHANNEL, TRUSTED_EVENT, { command: "photocraft/projects/list" }), /Forbidden/);
  const strict = fakeIpcMain();
  registerPhotocraftIpc(strict, { bundle: h.bundle, isTrusted: () => false });
  await assert.rejects(() => strict.invoke(PHOTOCRAFT_CHANNEL, TRUSTED_EVENT, { command: "photocraft/projects/list" }), /Forbidden/);

  const notReadyIpc = fakeIpcMain();
  const registered = registerPhotocraftIpc(notReadyIpc, { bundle: null, isTrusted: () => true });
  const notReady = await notReadyIpc.invoke(PHOTOCRAFT_CHANNEL, TRUSTED_EVENT, { command: "photocraft/projects/list" });
  assert.deepEqual(notReady, { ok: false, error: PHOTOCRAFT_NOT_READY, message: "PhotoCraft 域尚未装配" });
  assert.equal(registered.channel, PHOTOCRAFT_CHANNEL);

  const unknown = await h.call("photocraft/nope", {});
  assert.equal(unknown.error, ERR.PHOTOCRAFT_ERR_COMMAND_NOT_ALLOWED);
  const notObject = await h.ipcMain.invoke(PHOTOCRAFT_CHANNEL, TRUSTED_EVENT, null);
  assert.equal(notObject.error, ERR.PHOTOCRAFT_ERR_INVALID_INPUT);

  const noAuth = createPhotocraftBundle({ userDataDir: tmpUserData(), identity: h.identity, authorization: null, clock: h.now });
  const denied = await noAuth.execute("photocraft/projects/list", {}, { sessionRef: "sref_x" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, ERR.PHOTOCRAFT_ERR_UNAUTHENTICATED);

  const revoked = await h.call("photocraft/projects/list", {}, "sref_unknown");
  assert.equal(revoked.error, ERR.PHOTOCRAFT_ERR_UNAUTHENTICATED);

  // 可重复注册（先 removeHandler 再 handle）
  const ipcMain = fakeIpcMain();
  registerPhotocraftIpc(ipcMain, { bundle: h.bundle, isTrusted: () => true });
  registerPhotocraftIpc(ipcMain, { bundle: h.bundle, isTrusted: () => true });
  disposePhotocraftIpc(ipcMain);
  assert.throws(() => ipcMain.invoke(PHOTOCRAFT_CHANNEL, TRUSTED_EVENT, { command: "photocraft/projects/list" }), /没有 handler/);
});

test("createPhotocraftBundle 拒绝缺 IdentityStore / 缺 fsAdapter 与 userDataDir", () => {
  assert.throws(() => createPhotocraftBundle({ userDataDir: tmpUserData() }), /IdentityStore/);
  const identity = new IdentityStore({ path: ":memory:" }).open();
  assert.throws(() => createPhotocraftBundle({ identity }), /userDataDir/);
  assert.throws(() => new PhotocraftStore({ identity, fs: null }), /dxos-fs/);
  assert.ok(new PhotocraftService({ identity, fs: createPhotocraftBundle({ userDataDir: tmpUserData(), identity, authorization: null }).store.fs }));
});

// ---------------------------------------------------------------------------
// 域工具：runtime / 可见性纯函数
// ---------------------------------------------------------------------------
test("runtime 纯工具：等长替换、无命中返回原引用、运行时脚本非空", () => {
  const source = Buffer.from("创建新文档或打开现有文件。 tail");
  const patched = domain.patchPhotoCraftWasm(source);
  assert.equal(patched.length, source.length, "等长替换不得改变字节长度");
  assert.notEqual(patched.toString("utf8"), source.toString("utf8"));
  const other = Buffer.from("nothing to patch");
  assert.equal(domain.patchPhotoCraftWasm(other), other, "无命中返回原引用");
  const runtime = domain.photoCraftWorkspaceRuntime();
  assert.equal(typeof runtime, "string");
  assert.ok(runtime.indexOf("installPhotoCraftWorkspace") >= 0);
  assert.equal(domain.WELCOME_TEXT_PATCHES.length, 7);
});

test("可见性纯函数：owner / public / restricted+成员 三路", () => {
  const row = { id: "p", owner_id: "u1", deleted_at: null, visibility: "private" };
  assert.equal(domain.canViewProject(row, "u1", []), true);
  assert.equal(domain.canViewProject(row, "u2", []), false);
  assert.equal(domain.canViewProject(Object.assign({}, row, { visibility: "public" }), "u2", []), true);
  assert.equal(domain.canViewProject(Object.assign({}, row, { visibility: "restricted" }), "u2", ["u2"]), true);
  assert.equal(domain.canViewProject(Object.assign({}, row, { visibility: "restricted" }), "u2", ["u3"]), false);
  assert.equal(domain.canViewProject(Object.assign({}, row, { deleted_at: 1 }), "u1", []), false);
  assert.equal(domain.canEditProject(row, "u1"), true);
  assert.equal(domain.canEditProject(row, "u2"), false);
});
