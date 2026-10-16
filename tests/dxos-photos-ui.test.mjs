/**
 * 照片应用前端 · 纯逻辑回归测试（全离线：node:test 直接 import 真的 .ts 逻辑模块，
 * 不启动浏览器、不启动 Electron、不发 IPC）。
 *
 * 覆盖任务书要求的六项：
 *   ① 错误码 → 中文文案映射（三通道，含未登记码不塌缩）
 *   ② 分页状态推导（默认 50 / 上限 100 / truncated / 翻页偏移 / 去重合并）
 *   ③ 来源与文件夹树构建（虚拟文件夹父子、断父、成环；来源真实目录分来源）
 *   ④ 三态可见性控件语义（private / public / restricted、非 owner 禁用、成员清理）
 *   ⑤ appExchange target 过滤与不可用态（后端列表 + mime 过滤 + 可执行提示）
 *   ⑥ base64url 字节还原（与 Buffer 交叉验证）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BACKGROUND_REMOVAL_DEPENDENCY_LABELS,
  IMPORT_DESTINATIONS,
  PHOTOS_COMMANDS,
  PHOTOS_COMMANDS_UNUSED_BY_UI,
  PHOTOS_DEPENDENCY_LABELS,
  PHOTOS_ERROR_TEXT,
  PHOTOS_PAGE_LIMIT_DEFAULT,
  PHOTOS_PAGE_LIMIT_MAX,
  PHOTOS_PAGE_STATE_KINDS,
  assignSummary,
  backgroundRemovalHint,
  base64UrlToBase64,
  base64UrlToBytes,
  base64UrlToDataUrl,
  buildLocalFolderTree,
  buildVirtualFolderTree,
  bytesToBase64Url,
  decodedByteLength,
  dependencyReport,
  domainBridge,
  flattenFolderTree,
  folderOptions,
  folderPathLabel,
  formatBytes,
  isAllowedPhotosCommand,
  isBase64Url,
  localRootId,
  mergePage,
  normalizePageLimit,
  pageState,
  photosErrorState,
  photosErrorText,
  photosFailureLine,
  resultFailure,
  resultValue,
  sourcesTruncationNotices,
  visionModelsView,
} from "../src/photos/photosLogic.ts";

import {
  APP_EXCHANGE_COMMANDS,
  APP_EXCHANGE_ERROR_TEXT,
  PHOTOCRAFT_COMMANDS,
  PHOTOCRAFT_ERROR_TEXT,
  TRASH_PURGE_HINT,
  VISIBILITY_OPTIONS,
  appExchangeErrorState,
  appExchangeErrorText,
  buildExchangeRequest,
  defaultTargetKey,
  exchangeResultText,
  exchangeTargetKey,
  exportArtifactName,
  groupOptions,
  groupProjects,
  isAllowedAppExchangeCommand,
  isAllowedPhotocraftCommand,
  isReferenceOnly,
  membersInputValue,
  newRequestId,
  parseMembersInput,
  photocraftErrorState,
  photocraftErrorText,
  sourceDownloadName,
  targetAccepts,
  targetNeedsCanvas,
  targetOptionLabel,
  targetsPageState,
  targetsUnavailableNotice,
  targetsView,
  visibilityControl,
  visibilityLabel,
  visibilityUpdatePayload,
} from "../src/photos/studioLogic.ts";

/* ══════════════════════════════════════════════════════════════════════════
   ① 错误码 → 文案映射
   ══════════════════════════════════════════════════════════════════════════ */
const PHOTOS_CODES = [
  "PHOTOS_COMMAND_NOT_ALLOWED",
  "PHOTOS_NOT_READY",
  "PHOTOS_INVALID_INPUT",
  "PHOTOS_UNAUTHENTICATED",
  "PHOTOS_NOT_FOUND",
  "PHOTOS_PATH_ESCAPE",
  "PHOTOS_TOO_LARGE",
  "PHOTOS_DEPENDENCY_UNAVAILABLE",
  "PHOTOS_PROVIDER_UNAVAILABLE",
  "PHOTOS_PROVIDER_FAILED",
  "PHOTOS_INTERNAL",
  "DXOS_ERR_INTERNAL",
];
const PHOTOCRAFT_CODES = [
  "PHOTOCRAFT_COMMAND_NOT_ALLOWED",
  "PHOTOCRAFT_NOT_READY",
  "PHOTOCRAFT_INVALID_INPUT",
  "PHOTOCRAFT_UNAUTHENTICATED",
  "PHOTOCRAFT_NOT_FOUND",
  "PHOTOCRAFT_FORBIDDEN",
  "PHOTOCRAFT_CONFLICT",
  "PHOTOCRAFT_TOO_LARGE",
  "PHOTOCRAFT_UNSUPPORTED",
  "PHOTOCRAFT_INTERNAL",
  "DXOS_ERR_INTERNAL",
];
const EXCHANGE_CODES = [
  "APP_EXCHANGE_COMMAND_NOT_ALLOWED",
  "APP_EXCHANGE_INVALID_INPUT",
  "APP_EXCHANGE_UNAUTHENTICATED",
  "APP_EXCHANGE_NOT_FOUND",
  "APP_EXCHANGE_CONFLICT",
  "APP_EXCHANGE_FORBIDDEN",
  "APP_EXCHANGE_TARGET_UNSUPPORTED",
  "APP_EXCHANGE_BYTES_NOT_ALLOWED",
  "APP_EXCHANGE_STALE_REVISION",
  "APP_EXCHANGE_TOO_LARGE",
  "APP_EXCHANGE_IMAGE_INVALID",
  "APP_EXCHANGE_IMAGE_ENGINE_UNAVAILABLE",
  "APP_EXCHANGE_DEPENDENCY_UNAVAILABLE",
  "APP_EXCHANGE_NOT_READY",
  "APP_EXCHANGE_INTERNAL",
  "DXOS_ERR_INTERNAL",
];

test("① photos 每条已登记错误码都有中文文案，不把原始码当文案", () => {
  for (const code of PHOTOS_CODES) {
    const text = photosErrorText(code);
    assert.ok(text.length > 0, code + " 应有文案");
    assert.notEqual(text, code, code + " 不应直接回原始码");
    assert.equal(text, PHOTOS_ERROR_TEXT[code]);
  }
  assert.match(photosErrorText("PHOTOS_DEPENDENCY_UNAVAILABLE"), /没有执行/);
  assert.match(photosErrorText("PHOTOS_PROVIDER_UNAVAILABLE"), /设置/);
});

test("① photocraft / appExchange 每条已登记错误码都有中文文案", () => {
  for (const code of PHOTOCRAFT_CODES) {
    assert.ok(photocraftErrorText(code).length > 0, code);
    assert.notEqual(photocraftErrorText(code), code, code);
  }
  for (const code of EXCHANGE_CODES) {
    assert.ok(appExchangeErrorText(code).length > 0, code);
    assert.notEqual(appExchangeErrorText(code), code, code);
  }
  assert.match(photocraftErrorText("PHOTOCRAFT_FORBIDDEN"), /所有者/);
  assert.match(appExchangeErrorText("APP_EXCHANGE_BYTES_NOT_ALLOWED"), /只传引用/);
});

test("① 未登记错误码保留原始码（不塌缩成未知错误）", () => {
  assert.match(photosErrorText("PHOTOS_WHATEVER_999"), /PHOTOS_WHATEVER_999/);
  assert.match(photosErrorText(""), /未登记/);
  assert.match(photocraftErrorText("PHOTOCRAFT_NEW"), /PHOTOCRAFT_NEW/);
  assert.match(appExchangeErrorText("APP_EXCHANGE_NEW"), /APP_EXCHANGE_NEW/);
});

test("① 错误码 → PageState kind 只用已登记的 kind", () => {
  assert.equal(photosErrorState("PHOTOS_UNAUTHENTICATED"), "unauthorized");
  assert.equal(photosErrorState("PHOTOS_FORBIDDEN"), "unauthorized");
  assert.equal(photosErrorState("PHOTOS_NOT_READY"), "unavailable");
  assert.equal(photosErrorState("PHOTOS_DEPENDENCY_UNAVAILABLE"), "unavailable");
  assert.equal(photosErrorState("PHOTOS_PROVIDER_UNAVAILABLE"), "unavailable");
  assert.equal(photosErrorState("PHOTOS_NOT_FOUND"), "error");
  assert.equal(photosErrorState("PHOTOS_INVALID_INPUT"), "error");
  assert.equal(photosErrorState("DXOS_ERR_INTERNAL"), "error");
  assert.equal(photocraftErrorState("PHOTOCRAFT_FORBIDDEN"), "unauthorized");
  assert.equal(photocraftErrorState("PHOTOCRAFT_UNSUPPORTED"), "unavailable");
  assert.equal(photocraftErrorState("PHOTOCRAFT_CONFLICT"), "error");
  assert.equal(appExchangeErrorState("APP_EXCHANGE_FORBIDDEN"), "unauthorized");
  assert.equal(appExchangeErrorState("APP_EXCHANGE_DEPENDENCY_UNAVAILABLE"), "unavailable");
  assert.equal(appExchangeErrorState("APP_EXCHANGE_TARGET_UNSUPPORTED"), "error");
  for (const code of [...PHOTOS_CODES, "PHOTOS_FORBIDDEN", "PHOTOS_CONFLICT"]) {
    assert.ok(PHOTOS_PAGE_STATE_KINDS.includes(photosErrorState(code)), code);
  }
});

test("① 失败行同时给上下文、人话与原始码", () => {
  const line = photosFailureLine("读取照片目录", "PHOTOS_NOT_FOUND");
  assert.match(line, /读取照片目录未完成/);
  assert.match(line, /PHOTOS_NOT_FOUND/);
  assert.match(line, /不存在/);
});

/* ══════════════════════════════════════════════════════════════════════════
   ② 分页状态推导
   ══════════════════════════════════════════════════════════════════════════ */
test("② limit 归一：默认 50，上限 100", () => {
  assert.equal(PHOTOS_PAGE_LIMIT_DEFAULT, 50);
  assert.equal(PHOTOS_PAGE_LIMIT_MAX, 100);
  assert.equal(normalizePageLimit(undefined), 50);
  assert.equal(normalizePageLimit(0), 50);
  assert.equal(normalizePageLimit(-3), 50);
  assert.equal(normalizePageLimit(1.5), 50);
  assert.equal(normalizePageLimit("abc"), 50);
  assert.equal(normalizePageLimit(1), 1);
  assert.equal(normalizePageLimit(50), 50);
  assert.equal(normalizePageLimit(100), 100);
  assert.equal(normalizePageLimit(1000), 100);
  assert.equal(normalizePageLimit("80"), 80);
});

test("② 首屏：total 500 / 已载入 50 → 有下一页且偏移推进", () => {
  const view = pageState({ offset: 0, limit: 50, total: 500, loaded: 50, truncated: false });
  assert.equal(view.hasNext, true);
  assert.equal(view.hasPrev, false);
  assert.equal(view.nextOffset, 50);
  assert.equal(view.prevOffset, 0);
  assert.equal(view.remaining, 450);
  assert.equal(view.label, "已载入 50 / 500");
});

test("② 末页：offset 450 / 已载入 50 → 没有下一页", () => {
  const view = pageState({ offset: 450, limit: 50, total: 500, loaded: 50, truncated: false });
  assert.equal(view.hasNext, false);
  assert.equal(view.hasPrev, true);
  assert.equal(view.prevOffset, 400);
  assert.equal(view.remaining, 0);
});

test("② 后端 truncated=true 与 total 不一致时仍以 truncated 为准", () => {
  const view = pageState({ offset: 0, limit: 50, total: 50, loaded: 50, truncated: true });
  assert.equal(view.hasNext, true);
  assert.equal(view.truncated, true);
});

test("② 不假设一次拿全量：不足一页但总数更大 → 仍有下一页", () => {
  const view = pageState({ offset: 0, limit: 50, total: 137, loaded: 12 });
  assert.equal(view.hasNext, true);
  assert.equal(view.nextOffset, 12);
  assert.equal(view.remaining, 125);
});

test("② loaded 夹在 total 内，后端 total 回退时不会出现负数 remaining", () => {
  const view = pageState({ offset: 40, limit: 50, total: 30, loaded: 50 });
  assert.equal(view.loaded, 0);
  assert.equal(view.remaining, 0);
  assert.equal(view.hasNext, false);
});

test("② mergePage 按键去重且保持顺序（翻页重试不重复插行）", () => {
  const first = [{ id: "a" }, { id: "b" }];
  const second = [{ id: "b" }, { id: "c" }];
  assert.deepEqual(
    mergePage(first, second, (item) => item.id).map((item) => item.id),
    ["a", "b", "c"],
  );
});

test("② sources / folders / virtualFolders 的截断必须说出来", () => {
  assert.deepEqual(sourcesTruncationNotices({}), []);
  const notices = sourcesTruncationNotices({
    sourcesTotal: 152,
    sourcesTruncated: true,
    foldersTotal: 400,
    foldersTruncated: true,
    virtualFoldersTotal: 7,
    virtualFoldersTruncated: false,
    walkCapReached: true,
  });
  assert.equal(notices.length, 3);
  assert.match(notices[0], /来源只显示前 100 个（共 152 个）/);
  assert.match(notices[1], /来源子目录只显示前 100 个（共 400 个）/);
  assert.match(notices[2], /目录扫描到达深度或条目上限/);
});

/* ══════════════════════════════════════════════════════════════════════════
   ③ 来源 / 文件夹树
   ══════════════════════════════════════════════════════════════════════════ */
test("③ 虚拟文件夹树：父子层级、深度与展开遍历", () => {
  const folders = [
    { id: "a", name: "旅行", parentId: null },
    { id: "b", name: "海边", parentId: "a" },
    { id: "c", name: "日落", parentId: "b" },
  ];
  const tree = buildVirtualFolderTree(folders);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, "a");
  assert.equal(tree.byId.get("c").depth, 2);
  assert.deepEqual(flattenFolderTree(tree.roots, ["a"]).map((row) => row.node.id + ":" + row.depth), ["a:0", "b:1"]);
  assert.deepEqual(
    flattenFolderTree(tree.roots, new Set(["a", "b"])).map((row) => row.node.id + ":" + row.depth),
    ["a:0", "b:1", "c:2"],
  );
  assert.equal(folderPathLabel(folders, "c"), "旅行 / 海边 / 日落");
  assert.deepEqual(folderOptions(folders).map((option) => option.label + "@" + option.depth), ["旅行@0", "海边@1", "日落@2"]);
});

test("③ 虚拟文件夹树：断父升为根并标 orphan，不丢节点", () => {
  const tree = buildVirtualFolderTree([
    { id: "a", name: "A", parentId: "missing" },
    { id: "b", name: "B", parentId: "a" },
  ]);
  assert.equal(tree.byId.get("a").orphan, true);
  assert.equal(tree.orphans.length, 1);
  assert.deepEqual(flattenFolderTree(tree.roots, ["a"]).map((row) => row.node.id), ["a", "b"]);
});

test("③ 虚拟文件夹树：自指与成环被断开且全部可达（不死循环、不丢节点）", () => {
  const self = buildVirtualFolderTree([{ id: "x", name: "X", parentId: "x" }]);
  assert.equal(self.byId.get("x").orphan, true);
  assert.deepEqual(flattenFolderTree(self.roots, ["x"]).map((row) => row.node.id), ["x"]);

  const cycle = buildVirtualFolderTree([
    { id: "x", name: "X", parentId: "y" },
    { id: "y", name: "Y", parentId: "x" },
  ]);
  assert.equal(cycle.droppedCycles.length, 1);
  const visited = flattenFolderTree(cycle.roots, ["x", "y"]).map((row) => row.node.id);
  assert.deepEqual([...visited].sort(), ["x", "y"]);
});

test("③ 来源真实目录树：按来源分桶，断父升为根", () => {
  const folders = [
    { id: "local-folder:s1:照片", name: "照片", parentId: localRootId("s1"), sourceId: "s1", path: "照片" },
    { id: "local-folder:s1:照片/2024", name: "2024", parentId: "local-folder:s1:照片", sourceId: "s1", path: "照片/2024" },
    { id: "local-folder:s2:相机", name: "相机", parentId: "local-folder:s2:missing", sourceId: "s2", path: "相机" },
  ];
  const tree = buildLocalFolderTree(folders);
  assert.equal(localRootId("s1"), "local-root:s1");
  assert.equal(tree.size, 2);
  const s1 = tree.get("s1");
  assert.equal(s1.length, 1);
  assert.equal(s1[0].name, "照片");
  assert.equal(s1[0].children[0].name, "2024");
  assert.equal(s1[0].children[0].depth, 1);
  assert.equal(tree.get("s2")[0].name, "相机");
});

/* ══════════════════════════════════════════════════════════════════════════
   ④ 三态可见性控件语义
   ══════════════════════════════════════════════════════════════════════════ */
test("④ 三态选项固定为 private / public / restricted", () => {
  assert.deepEqual(
    VISIBILITY_OPTIONS.map((option) => option.id),
    ["private", "public", "restricted"],
  );
  assert.equal(visibilityLabel("public"), "公开");
  assert.equal(visibilityLabel("private"), "私有");
  assert.equal(visibilityLabel("restricted"), "指定成员");
  assert.equal(visibilityLabel("unknown"), "未登记可见性");
});

test("④ owner 的三态控件：只有一个选中、未选指定成员时不要求成员", () => {
  const control = visibilityControl({ visibility: "private", mine: true, members: [] });
  assert.equal(control.current, "private");
  assert.equal(control.disabled, false);
  assert.equal(control.options.filter((option) => option.selected).length, 1);
  assert.equal(control.options.find((option) => option.id === "private").selected, true);
  assert.equal(control.requiresMembers, false);
  assert.match(control.note, /清空成员列表/);
});

test("④ restricted：要求成员，并说清成员数与空成员后果", () => {
  const withMembers = visibilityControl({ visibility: "restricted", mine: true, members: ["usr_a", "usr_b"] });
  assert.equal(withMembers.requiresMembers, true);
  assert.equal(withMembers.memberCount, 2);
  assert.match(withMembers.note, /成员 2 个/);

  const empty = visibilityControl({ visibility: "restricted", mine: true, members: [] });
  assert.equal(empty.requiresMembers, true);
  assert.match(empty.note, /成员为空/);
});

test("④ 非 owner：控件整体禁用并给出原因", () => {
  const control = visibilityControl({ visibility: "public", mine: false, members: [] });
  assert.equal(control.disabled, true);
  assert.equal(control.disabledReason, "只有项目所有者可以修改可见性");
  assert.equal(control.options.every((option) => option.disabled), true);
  assert.equal(control.options.find((option) => option.id === "public").selected, true);
});

test("④ 可见性载荷：非 restricted 一律清空成员（与后端整表替换同语义）", () => {
  assert.deepEqual(visibilityUpdatePayload("private", ["usr_a"]), { visibility: "private", members: [] });
  assert.deepEqual(visibilityUpdatePayload("public", ["usr_a"]), { visibility: "public", members: [] });
  assert.deepEqual(visibilityUpdatePayload("restricted", ["usr_a", "usr_a", " ", "usr_b"]), {
    visibility: "restricted",
    members: ["usr_a", "usr_b"],
  });
});

test("④ 成员输入：支持换行 / 空格 / 逗号，去重并回写", () => {
  assert.deepEqual(parseMembersInput("usr_a\nusr_b,  usr_c;usr_a"), ["usr_a", "usr_b", "usr_c"]);
  assert.equal(membersInputValue(["usr_a", "usr_b"]), "usr_a\nusr_b");
  assert.deepEqual(parseMembersInput(""), []);
});

test("④ 项目分桶：按后端分组顺序，未列出的分组补桶且不吞项目", () => {
  const groups = [
    { id: "g2", name: "收尾", mine: true, isDefault: false },
    { id: "g1", name: "默认分组", mine: true, isDefault: true },
  ];
  const projects = [
    { id: "p1", groupId: "g1", title: "A", updatedAt: 10 },
    { id: "p2", groupId: "g1", title: "B", updatedAt: 30 },
    { id: "p3", groupId: "g9", title: "C", updatedAt: 20 },
  ];
  const buckets = groupProjects(projects, groups);
  assert.deepEqual(buckets.map((bucket) => bucket.group.id), ["g2", "g1", "g9"]);
  assert.deepEqual(buckets[1].projects.map((project) => project.id), ["p2", "p1"]);
  assert.equal(buckets[2].mine, false);
  assert.deepEqual(
    groupOptions(groups).map((group) => group.id),
    ["g1", "g2"],
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ appExchange target 过滤与不可用态
   ══════════════════════════════════════════════════════════════════════════ */
const TARGETS = [
  {
    appId: "image-studio",
    title: "图像工坊",
    action: "image.edit",
    accepts: ["image/png", "image/jpeg", "image/webp"],
    creates: "document",
    sourceAppId: "dev-photocraft",
    sourceTitle: "PhotoCraft",
    mapping: "equivalent",
    mappingNote: "本仓无 dev-photocraft；等价物为 image-studio",
  },
  {
    appId: "image-studio",
    title: "图像工坊 当前文档",
    action: "image.receive",
    accepts: ["image/png", "image/jpeg", "image/webp"],
    creates: "layer",
    sourceAppId: "dev-photocraft",
    sourceTitle: "PhotoCraft 当前文档",
    mapping: "equivalent",
    mappingNote: "本仓无 dev-photocraft；等价物为 image-studio",
  },
  {
    appId: "canvas",
    title: "无限画布",
    action: "image.import",
    accepts: ["image/png", "image/jpeg", "image/webp"],
    creates: "node",
    sourceAppId: "canvas",
    sourceTitle: "无限画布",
    mapping: "identity",
    mappingNote: "",
  },
];

test("⑤ target 标识与语义由后端字段推导（不硬编码 appId 列表）", () => {
  assert.equal(exchangeTargetKey(TARGETS[0]), "image-studio:image.edit");
  assert.equal(exchangeTargetKey(TARGETS[2]), "canvas:image.import");
  assert.equal(targetAccepts(TARGETS[2], "image/webp"), true);
  assert.equal(targetAccepts(TARGETS[2], "image/gif"), false);
  assert.equal(targetNeedsCanvas(TARGETS[2]), true);
  assert.equal(targetNeedsCanvas(TARGETS[0]), false);
  assert.equal(targetOptionLabel(TARGETS[0]), "图像工坊（新建项目）");
  assert.equal(targetOptionLabel(TARGETS[2]), "无限画布（新建卡片）");
});

test("⑤ target 过滤：PNG 全可用，GIF 全禁用且给出可执行原因", () => {
  const ready = targetsView({ version: 1, targets: TARGETS, canvases: [{ id: "c1", title: "画布一" }] }, "image/png");
  assert.equal(ready.ready, true);
  assert.equal(ready.targets.length, 3);
  assert.equal(ready.targets.every((item) => !item.disabled), true);
  assert.equal(ready.canvases[0].title, "画布一");
  assert.equal(ready.targets[0].note, TARGETS[0].mappingNote);
  assert.equal(defaultTargetKey(ready.targets, "image/png"), "canvas:image.import");

  const blocked = targetsView({ targets: TARGETS, canvases: [] }, "image/gif");
  assert.equal(blocked.ready, false);
  assert.equal(blocked.targets.every((item) => item.disabled), true);
  assert.match(blocked.targets[0].disabledReason, /只接受 PNG \/ JPEG \/ WebP/);
  assert.match(blocked.emptyReason, /PNG \/ JPEG \/ WebP/);
  assert.equal(defaultTargetKey(blocked.targets, "image/gif"), null);
});

test("⑤ target 列表来自后端：为空时不是空态，而是可执行原因", () => {
  const view = targetsView({ version: 1, targets: [], canvases: [] }, "image/png");
  assert.equal(view.ready, false);
  assert.match(view.emptyReason, /canOpen/);
  assert.match(view.emptyReason, /重新读取目标/);
  assert.deepEqual(view.canvases, []);
});

test("⑤ 不可用态提示逐码可执行（不是空态文案）", () => {
  assert.match(targetsUnavailableNotice("APP_EXCHANGE_TARGET_UNSUPPORTED", { appId: "dev-photocraft", action: "image.edit" }), /重新选择/);
  assert.match(targetsUnavailableNotice("APP_EXCHANGE_TARGET_UNSUPPORTED", { appId: "dev-photocraft" }), /dev-photocraft/);
  const dep = targetsUnavailableNotice("APP_EXCHANGE_DEPENDENCY_UNAVAILABLE", { dependency: "listCanvases" });
  assert.match(dep, /端口/);
  assert.match(dep, /listCanvases/);
  assert.match(dep, /没有执行/);
  assert.match(targetsUnavailableNotice("APP_EXCHANGE_NOT_READY"), /尚未装配/);
  assert.match(targetsUnavailableNotice("NO_BRIDGE"), /尚未装配/);
  assert.match(targetsUnavailableNotice("APP_EXCHANGE_FORBIDDEN"), /权限/);
  assert.match(targetsUnavailableNotice("APP_EXCHANGE_IMAGE_ENGINE_UNAVAILABLE"), /sharp/);
});

test("⑤ 目标面板四态：loading / error / unavailable / ready", () => {
  assert.equal(targetsPageState({ loading: true }).kind, "loading");
  assert.equal(targetsPageState({ loading: false, errorCode: "APP_EXCHANGE_TARGET_UNSUPPORTED" }).kind, "error");
  assert.match(targetsPageState({ loading: false, value: { targets: [] }, mime: "image/png" }).description, /canOpen/);
  assert.equal(targetsPageState({ loading: false, value: { targets: TARGETS }, mime: "image/png" }).kind, "ready");
  assert.equal(targetsPageState({ loading: false, value: { targets: TARGETS }, mime: "image/gif" }).kind, "unavailable");
});

test("⑤ 请求构造对齐后端约束：画布必选、图像工坊不覆盖已有项目", () => {
  const asset = { nodeId: "node-1", photoCraftProjectId: "p1", revision: "sha1" };
  const noCanvas = buildExchangeRequest({ requestId: "req-1", target: { appId: "canvas", action: "image.import" }, asset, needsCanvas: true });
  assert.equal(noCanvas.ok, false);
  assert.match(noCanvas.message, /画布/);

  const overwrite = buildExchangeRequest({
    requestId: "req-1",
    target: { appId: "image-studio", action: "image.edit", projectId: "p9" },
    asset,
    needsCanvas: false,
  });
  assert.equal(overwrite.ok, false);
  assert.match(overwrite.message, /新建项目/);

  const good = buildExchangeRequest({
    requestId: "req-1",
    target: { appId: "canvas", action: "image.import", projectId: "c1" },
    asset,
    needsCanvas: true,
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.request, {
    requestId: "req-1",
    target: { appId: "canvas", action: "image.import", projectId: "c1" },
    asset: { nodeId: "node-1", photoCraftProjectId: "p1", revision: "sha1" },
  });

  const noSource = buildExchangeRequest({ requestId: "req-1", target: { appId: "canvas", action: "image.import", projectId: "c1" }, asset: {}, needsCanvas: true });
  assert.equal(noSource.ok, false);
  assert.match(noSource.message, /源文件/);
});

test("⑤ 只传引用：字节或 URL 字段一律判否", () => {
  assert.equal(isReferenceOnly({ nodeId: "a", canvasId: "b" }), true);
  assert.equal(isReferenceOnly({ nodeId: "a", url: "https://x/y.png" }), false);
  assert.equal(isReferenceOnly({ nodeId: "a", image: "data:image/png;base64,AAAA" }), false);
  assert.equal(isReferenceOnly({ asset: { nodeId: "a", bytes: [1, 2, 3] } }), false);
  assert.equal(isReferenceOnly({ asset: { nodeId: "a", data: new Uint8Array([1]) } }), false);
});

test("⑤ 请求 ID 形状与发送结果文案", () => {
  const id = newRequestId("abc-123!@#", 1700000000000);
  assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(id, /1700000000000/);
  assert.match(exchangeResultText({ target: { appId: "image-studio", action: "image.edit", projectId: "p-new" }, asset: { name: "图.png" } }), /新建项目 p-new/);
  assert.match(exchangeResultText({ target: { appId: "canvas", action: "image.import", cardId: "card-9" }, asset: { name: "图.png" } }), /卡片 card-9/);
});

test("⑤ 三通道命令白名单拒绝未登记命令", () => {
  assert.equal(isAllowedPhotosCommand("photos/sources/list"), true);
  assert.equal(isAllowedPhotosCommand("photos/whatever"), false);
  assert.equal(isAllowedPhotosCommand(42), false);
  assert.equal(isAllowedPhotocraftCommand("photocraft/projects/update"), true);
  assert.equal(isAllowedPhotocraftCommand("photocraft/projects/drop"), false);
  assert.equal(isAllowedAppExchangeCommand("appExchange/exchange"), true);
  assert.equal(isAllowedAppExchangeCommand("appExchange/images"), false);
  assert.equal(PHOTOS_COMMANDS_UNUSED_BY_UI.length, 4);
  for (const command of PHOTOS_COMMANDS_UNUSED_BY_UI) assert.ok(PHOTOS_COMMANDS.includes(command), command);
});

test("⑤ 回收站与导出文案对齐后端语义", () => {
  assert.match(TRASH_PURGE_HINT, /回收站/);
  assert.match(TRASH_PURGE_HINT, /无法再恢复/);
  assert.equal(sourceDownloadName("a.png", "image/png"), "a.png");
  assert.equal(sourceDownloadName("", "image/png"), "source.png");
  assert.equal(exportArtifactName({ title: "我的项目", sourceMime: "image/png" }, "out.webp"), "out.webp");
  assert.equal(exportArtifactName({ title: "我的项目", sourceMime: "image/png" }), "我的项目-导出.png");
});

test("⑤ photocraft 命令白名单包含冻结契约里的全部命令", () => {
  const contract = [
    "photocraft/projects/list",
    "photocraft/projects/create",
    "photocraft/projects/get",
    "photocraft/projects/update",
    "photocraft/projects/trash",
    "photocraft/projects/restore",
    "photocraft/projects/purge",
    "photocraft/projects/readSource",
    "photocraft/projects/writeSource",
    "photocraft/projects/export",
    "photocraft/trash/list",
    "photocraft/groups/create",
    "photocraft/groups/remove",
  ];
  for (const command of contract) assert.ok(PHOTOCRAFT_COMMANDS.includes(command), command);
  for (const command of ["appExchange/targets", "appExchange/exchange"]) assert.ok(APP_EXCHANGE_COMMANDS.includes(command), command);
});

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ base64url 字节还原
   ══════════════════════════════════════════════════════════════════════════ */
test("⑥ base64url 往返与 Buffer 交叉验证", () => {
  const samples = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([0, 1]),
    new Uint8Array([0, 1, 2]),
    new Uint8Array([255, 254, 253, 252]),
    new Uint8Array(Array.from({ length: 257 }, (_, index) => (index * 37) % 256)),
  ];
  for (const bytes of samples) {
    const encoded = bytesToBase64Url(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString("base64url"), "与 Buffer 口径一致");
    assert.equal(/[+/=]/.test(encoded), false, "不含 + / 与填充");
    assert.deepEqual([...base64UrlToBytes(encoded)], [...bytes]);
    assert.equal(decodedByteLength(encoded), bytes.length);
    assert.equal(isBase64Url(encoded), true);
  }
});

test("⑥ 已知向量与非法输入", () => {
  assert.deepEqual([...base64UrlToBytes("AAEC")], [0, 1, 2]);
  assert.equal(bytesToBase64Url(new Uint8Array([0, 1, 2])), "AAEC");
  assert.equal(bytesToBase64Url(new Uint8Array([251, 255])), "-_8");
  assert.deepEqual([...base64UrlToBytes("-_8")], [251, 255]);
  assert.deepEqual([...base64UrlToBytes("")], []);
  assert.equal(isBase64Url(""), true);
  assert.equal(isBase64Url("a+b"), false);
  assert.equal(isBase64Url(123), false);
  assert.throws(() => base64UrlToBytes("ab$c"), /base64url/);
});

test("⑥ data URL 转换：base64url 补成标准 base64（浏览器 data: 只吃标准表）", () => {
  assert.equal(base64UrlToBase64("-_8"), "+/8=");
  assert.equal(Buffer.from(base64UrlToBytes("-_8")).toString("base64"), "+/8=");
  assert.equal(base64UrlToBase64("AAEC"), "AAEC");
  assert.equal(base64UrlToDataUrl("AAEC", "image/png"), "data:image/png;base64,AAEC");
  assert.equal(base64UrlToDataUrl("", ""), "data:application/octet-stream;base64,");
});

/* ══════════════════════════════════════════════════════════════════════════
   附加：桥、信封、依赖事实与展示工具
   ══════════════════════════════════════════════════════════════════════════ */
test("桥取用是结构检查（缺命令面即判无桥）", async () => {
  const seen = [];
  const command = async (cmd) => {
    seen.push(cmd);
    return { ok: true, value: { echoed: cmd.command } };
  };
  const bridge = domainBridge({ openarc: { photos: { command } } }, "photos");
  assert.equal(typeof bridge.command, "function");
  assert.deepEqual(await bridge.command({ command: "photos/health" }), { ok: true, value: { echoed: "photos/health" } });
  assert.deepEqual(seen, [{ command: "photos/health" }]);
  assert.equal(domainBridge({ openarc: { photos: {} } }, "photos"), null);
  assert.equal(domainBridge({ openarc: { photos: { command: "nope" } } }, "photos"), null);
  assert.equal(domainBridge({ openarc: {} }, "photos"), null);
  assert.equal(domainBridge({}, "photos"), null);
  assert.equal(domainBridge(null, "photos"), null);
  assert.equal(domainBridge({ openarc: { photocraft: { command } } }, "appExchange"), null);
});

test("信封解析：value / failure / 不完整记录", () => {
  assert.deepEqual(resultValue({ ok: true, value: { total: 3 } }), { total: 3 });
  assert.equal(resultValue({ ok: false, error: "PHOTOS_NOT_FOUND" }), null);
  assert.equal(resultValue({}), null);
  assert.equal(resultValue(null), null);
  assert.deepEqual(resultFailure({ ok: false, error: "PHOTOS_NOT_FOUND", message: "x" }), {
    code: "PHOTOS_NOT_FOUND",
    message: "x",
  });
  assert.equal(resultFailure({ ok: true, value: {} }), null);
  // 失败信封缺 error 字段时归到 DXOS_ERR_INTERNAL（不假装成功，也不丢失败事实）
  assert.deepEqual(resultFailure({ ok: false }), { code: "DXOS_ERR_INTERNAL", message: "" });
  assert.deepEqual(resultFailure({ ok: false, error: "PHOTOS_NOT_FOUND", message: "x", detail: { a: 1 } }), {
    code: "PHOTOS_NOT_FOUND",
    message: "x",
    detail: { a: 1 },
  });
  assert.equal(resultFailure("not-an-envelope"), null);
});

test("photos/health 依赖事实：只报事实，缺失不降级成可用", () => {
  const rows = dependencyReport({ dependencies: { sharp: true, videoPoster: false, importer: false } });
  assert.deepEqual(rows.map((row) => row.key), ["importer", "sharp", "videoPoster"]);
  assert.equal(rows.find((row) => row.key === "sharp").available, true);
  assert.equal(rows.find((row) => row.key === "importer").available, false);
  assert.match(rows.find((row) => row.key === "importer").hint, /不可用/);
  assert.equal(rows.find((row) => row.key === "sharp").label, "图像处理（sharp）");
  assert.deepEqual(dependencyReport({}), []);
  assert.ok(Object.keys(PHOTOS_DEPENDENCY_LABELS).length >= 8);
});

test("视觉模型：无供应商时 available=false 且带配置指引", () => {
  const none = visionModelsView({ available: false, models: [], hint: "请先配置" });
  assert.equal(none.available, false);
  assert.equal(none.hint, "请先配置");
  const some = visionModelsView({
    available: true,
    models: [{ providerId: "p1", providerName: "本地", model: "vlm-1" }],
    hint: null,
  });
  assert.equal(some.available, true);
  assert.equal(some.models.length, 1);
  assert.match(some.hint, /设置/);
  assert.equal(visionModelsView({ available: true, models: [] }).available, false);
});

test("抠图依赖提示带依赖名与下一步", () => {
  const text = backgroundRemovalHint({ dependency: "sharp", hint: "装 sharp 后重试" }, "PHOTOS_DEPENDENCY_UNAVAILABLE");
  assert.match(text, /图像处理（sharp）/);
  assert.match(text, /装 sharp 后重试/);
  assert.match(text, /没有产生任何图/);
  assert.ok(BACKGROUND_REMOVAL_DEPENDENCY_LABELS.sharp);
  assert.equal(IMPORT_DESTINATIONS.length, 2);
  assert.deepEqual(
    IMPORT_DESTINATIONS.map((item) => item.id),
    ["canvas", "library"],
  );
});

test("展示工具：字节与归类摘要", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(1024 * 1024 * 3), "3.0 MB");
  assert.equal(formatBytes(undefined), "—");
  assert.equal(assignSummary({ assigned: 3, skipped: ["a"] }), "已归入 3 张，跳过 1 张（文件已不在来源里）");
  assert.equal(assignSummary({}), "没有需要改动的照片");
});
