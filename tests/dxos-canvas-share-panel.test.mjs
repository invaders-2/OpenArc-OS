/**
 * 画布共享面板 · 前端纯逻辑 + 接线契约（离线单测，不启动 Electron）。
 *
 * 被测的是产品真实代码：
 *   · src/canvas/canvasShareModel.ts —— 面板与 CanvasHost 共用的角色矩阵 / 错误码中文 /
 *     两步确认状态机 / 权限签名；
 *   · src/canvas/CanvasSharePanel.tsx · CanvasHost.tsx · public/novai-canvas/openarc-bridge.js ·
 *     生成件 static/canvas-list.html · experiments/d5-02/vendor-novai-app.mjs 的脚本化改动。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHARE_ROLE_OPTIONS,
  accessChange,
  accessSignature,
  beginRemove,
  beginTransfer,
  entryLabel,
  formatJoinedAt,
  isAccessLostError,
  isRemoveConfirming,
  mapShareError,
  memberRowState,
  nextRemove,
  nextTransfer,
  panelCapabilities,
  parseShareTargetMessage,
  shareRoleLabel,
  sourceRoleLabel,
  transferTargets,
  visibilityHint,
  visibilityLabel,
} from "../src/canvas/canvasShareModel.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("角色矩阵：三档文案 + 面板能力（MANAGER 可管理共享但不能转移所有者）", () => {
  assert.deepEqual(SHARE_ROLE_OPTIONS.map((o) => [o.value, o.label]), [
    ["VIEWER", "查看者"], ["EDITOR", "编辑者"], ["MANAGER", "管理共享"],
  ]);
  assert.equal(shareRoleLabel("VIEWER"), "查看者");
  assert.equal(shareRoleLabel("EDITOR"), "编辑者");
  assert.equal(shareRoleLabel("MANAGER"), "管理共享");
  assert.equal(shareRoleLabel("CONTRIBUTOR"), "CONTRIBUTOR", "未知/旧值不猜成查看者");

  const owner = panelCapabilities({ canManage: true, source: "OWNER_POLICY" });
  assert.deepEqual(owner, {
    showMemberList: true, canChangeVisibility: true, canAddMember: true,
    canChangeRole: true, canRemoveMember: true, canTransferOwner: true,
  });
  const superAdmin = panelCapabilities({ canManage: true, source: "SUPER_ADMIN" });
  assert.equal(superAdmin.canTransferOwner, true);
  const manager = panelCapabilities({ canManage: true, source: "SHARE_MANAGER" });
  assert.equal(manager.showMemberList, true);
  assert.equal(manager.canChangeVisibility, true);
  assert.equal(manager.canAddMember, true);
  assert.equal(manager.canChangeRole, true);
  assert.equal(manager.canRemoveMember, true);
  assert.equal(manager.canTransferOwner, false, "MANAGER 不能转移所有者");
  for (const source of ["SHARE_EDITOR", "SHARE_VIEWER", "ORG_POLICY", ""]) {
    const ro = panelCapabilities({ canManage: false, source });
    assert.deepEqual(ro, {
      showMemberList: false, canChangeVisibility: false, canAddMember: false,
      canChangeRole: false, canRemoveMember: false, canTransferOwner: false,
    });
  }
});

test("成员行状态：停用/账号不存在时角色下拉禁用、移除仍可用；只读用户全部禁用", () => {
  assert.deepEqual(memberRowState({ status: "ACTIVE" }, true), { roleDisabled: false, removeDisabled: false, statusLabel: "正常", statusTone: "neutral" });
  assert.deepEqual(memberRowState({ status: "DISABLED" }, true), { roleDisabled: true, removeDisabled: false, statusLabel: "已停用", statusTone: "warning" });
  assert.deepEqual(memberRowState({ status: "MISSING" }, true), { roleDisabled: true, removeDisabled: false, statusLabel: "账号不存在", statusTone: "danger" });
  assert.deepEqual(memberRowState({ status: "ACTIVE" }, false), { roleDisabled: true, removeDisabled: true, statusLabel: "正常", statusTone: "neutral" });
});

test("错误码 → 中文：target-org / target-disabled / READ_ONLY / NOT_FOUND_OR_FORBIDDEN / owner-changed", () => {
  assert.match(mapShareError("INVALID_INPUT", "target-org"), /同一组织/);
  assert.match(mapShareError("INVALID_INPUT", "target-disabled"), /已停用/);
  assert.match(mapShareError("INVALID_INPUT", "target"), /找不到这个成员/);
  assert.match(mapShareError("INVALID_INPUT", "owner"), /所有者/);
  assert.match(mapShareError("INVALID_INPUT", "role"), /角色不合法/);
  assert.match(mapShareError("READ_ONLY", "SHARE_VIEWER"), /只有所有者和管理共享的人/);
  assert.match(mapShareError("READ_ONLY", "owner-changed"), /所有权已被其他操作变更/);
  assert.equal(mapShareError("NOT_FOUND_OR_FORBIDDEN"), "这本画布已不可访问（可能已被移出共享）");
  assert.match(mapShareError("NOT_FOUND", "share"), /还没有被共享/);
  assert.match(mapShareError("INTERNAL_ERROR", "audit"), /审计未写入/);
  assert.match(mapShareError("SOME_NEW_CODE"), /SOME_NEW_CODE/, "未知错误码如实显示，不吞掉");
});

test("权限来源 → 我的角色 / 入口文案（只读用户不冒充所有者）", () => {
  assert.equal(sourceRoleLabel("OWNER_POLICY"), "所有者");
  assert.equal(sourceRoleLabel("SUPER_ADMIN"), "超级管理员");
  assert.equal(sourceRoleLabel("SHARE_MANAGER"), "管理共享");
  assert.equal(sourceRoleLabel("SHARE_EDITOR"), "编辑者");
  assert.equal(sourceRoleLabel("SHARE_VIEWER"), "查看者");
  assert.equal(sourceRoleLabel("ORG_POLICY"), "组织内可查看（只读）");
  assert.equal(sourceRoleLabel("SHARE_VIEWER", "VIEWER"), "查看者");
  assert.equal(entryLabel(true, "OWNER_POLICY"), "共享");
  assert.equal(entryLabel(false, "SHARE_EDITOR"), "编辑者");
  assert.equal(entryLabel(false, "SHARE_VIEWER"), "只读共享");
  assert.equal(entryLabel(false, "ORG_POLICY"), "组织内可查看");
  assert.match(visibilityHint("ORGANIZATION"), /不能编辑/);
  assert.match(visibilityHint("ORGANIZATION"), /编辑者的人仍可编辑/);
  assert.match(visibilityHint("PRIVATE"), /仅所有者与被单独共享的人/);
  assert.equal(visibilityLabel("ORGANIZATION"), "组织内可见");
  assert.equal(visibilityLabel("PRIVATE"), "私有");
});

test("权限签名：canEdit / canManage / canShare / canView / source（=shareRole）任一变化都必须 push", () => {
  const base = { canView: true, canEdit: true, canManage: false, canShare: false, source: "SHARE_EDITOR" };
  const sig = accessSignature(base);
  assert.equal(accessChange(sig, base).changed, false, "同一个事实重复轮询不重复 push");
  assert.equal(accessChange(sig, { ...base, canEdit: false, source: "SHARE_VIEWER" }).changed, true, "降级为查看者");
  assert.equal(accessChange(sig, { ...base, canManage: true, source: "SHARE_MANAGER" }).changed, true, "升为管理共享");
  assert.equal(accessChange(sig, { ...base, source: "ORG_POLICY", canEdit: false }).changed, true, "显式共享被撤销（组织可见）");
  assert.equal(accessChange(sig, { ...base, shareRole: "VIEWER" }).changed, false, "未知字段不参与签名（canvas/meta 不返回 shareRole）");
  // 撤销共享：canView=false，签名必然变化
  assert.equal(accessChange(sig, { canView: false, canEdit: false, canManage: false, canShare: false, source: "NO_GRANT" }).changed, true);
  assert.equal(isAccessLostError("READ_ONLY"), true);
  assert.equal(isAccessLostError("NOT_FOUND_OR_FORBIDDEN"), true);
  assert.equal(isAccessLostError("INTERNAL_ERROR"), false);
});

test("两步确认状态机：移除成员 / 转移所有者（第一次只进确认，第二次才提交）", () => {
  let remove = beginRemove({ userId: null }, "u_1");
  assert.equal(isRemoveConfirming(remove, "u_1"), true);
  assert.equal(isRemoveConfirming(remove, "u_2"), false);
  remove = nextRemove(remove, { type: "cancel" });
  assert.equal(remove.userId, null, "取消后不再待确认（不提交）");
  remove = nextRemove(remove, { type: "ask", userId: "u_2" });
  assert.equal(remove.userId, "u_2");
  assert.equal(nextRemove(remove, { type: "confirm" }).userId, "u_2", "确认态由调用方在提交成功后清理");

  let transfer = beginTransfer({ target: null, confirming: false }, "u_2");
  assert.deepEqual(transfer, { target: "u_2", confirming: true });
  transfer = nextTransfer(transfer, { type: "cancel" });
  assert.deepEqual(transfer, { target: null, confirming: false });
  transfer = nextTransfer(transfer, { type: "open", target: "u_3" });
  assert.deepEqual(transfer, { target: "u_3", confirming: true });
  assert.deepEqual(nextTransfer(transfer, { type: "done" }), { target: null, confirming: false });
});

test("转移候选：已有成员 + 候选人去重、排除 owner 与非 ACTIVE", () => {
  const shares = [
    { userId: "u_1", role: "EDITOR", displayName: "一号", status: "ACTIVE" },
    { userId: "u_2", role: "VIEWER", displayName: "二号", status: "DISABLED" },
    { userId: "u_3", role: "MANAGER", displayName: "三号", status: "ACTIVE" },
  ];
  const candidates = [{ userId: "u_3", displayName: "三号（候选）" }, { userId: "u_4", username: "four" }];
  assert.deepEqual(transferTargets(shares, candidates, "u_owner"), [
    { userId: "u_1", label: "一号" },
    { userId: "u_3", label: "三号" },
    { userId: "u_4", label: "four" },
  ]);
});

test("列表入口消息：只认 open-share + 非空 canvasId（token/来源由宿主闸门另行校验）", () => {
  assert.equal(parseShareTargetMessage({ kind: "open-share", canvasId: "cv_1" }), "cv_1");
  assert.equal(parseShareTargetMessage({ kind: "open-share", canvasId: "  cv_2  " }), "cv_2");
  assert.equal(parseShareTargetMessage({ kind: "open-share", canvasId: "" }), null);
  assert.equal(parseShareTargetMessage({ kind: "open-share" }), null);
  assert.equal(parseShareTargetMessage({ kind: "call", canvasId: "cv_1" }), null);
  assert.equal(parseShareTargetMessage(null), null);
});

test("加入时间：本地时区 MM-DD；空值如实显示—", () => {
  assert.equal(formatJoinedAt(new Date(2026, 9, 17, 12, 0, 0).getTime()), "10-17");
  assert.equal(formatJoinedAt(0), "—");
  assert.equal(formatJoinedAt(null), "—");
});

test("接线契约：桥 openShare → 列表菜单 → 宿主 open-share；页面里没有共享 UI", () => {
  const bridge = read("public/novai-canvas/openarc-bridge.js");
  assert.match(bridge, /openShare:\s*function \(canvasId\)/);
  assert.match(bridge, /if \(!id\) return false;/);
  assert.match(bridge, /post\(\{ kind: "open-share", canvasId: id, token: token \}\)/, "open-share 必须带实例 token（宿主闸门不接受无 token 的帧消息）");

  const list = read("public/novai-canvas/static/canvas-list.html");
  assert.match(list, /data-action="share"/, "卡片菜单必须有「共享…」一项");
  assert.match(list, /共享…/);
  assert.match(list, /window\.__openarcBridge\.openShare\(c\.id\)/);
  assert.ok(list.indexOf('data-action="duplicate"') < list.indexOf('data-action="share"'), "顺序：复制 → 共享 → 删除");
  assert.ok(list.indexOf('data-action="share"') < list.indexOf('data-action="delete"'), "顺序：复制 → 共享 → 删除");
  for (const marker of ["data-canvas-share-panel", "data-share-member", "data-share-visibility", "canvas-share-panel"]) {
    assert.equal(list.includes(marker), false, "列表页不得画共享 UI：" + marker);
  }

  const host = read("src/canvas/CanvasHost.tsx");
  assert.match(host, /d\.kind === "open-share"/);
  assert.match(host, /parseShareTargetMessage\(d\)/);
  assert.match(host, /<CanvasShareEntry/);
  assert.match(host, /<CanvasSharePanel/);
});

test("接线契约：轮询比较 access 签名 → 变化即 pushContext；READ_ONLY / NOT_FOUND_OR_FORBIDDEN 有处理", () => {
  const host = read("src/canvas/CanvasHost.tsx");
  // 轮询里必须同时读 notifyAccess（签名比较）与 pushContext；不能只看 revision/updatedAt
  assert.match(host, /const accessChangedNow = notifyAccess\(cur\.canvasId, res\.meta\.access\)/);
  assert.match(host, /if \(dataChanged \|\| accessChangedNow\)/);
  assert.match(host, /void pushContext\(\{ canvasId, canEdit: !!access\?\.canEdit \}\)/);
  assert.match(host, /isAccessLostError\(res\.error\)/);
  assert.match(host, /accessLost\(res\.error, cur\.canvasId\)/);
  assert.match(host, /resetFrameRef\.current\(/);
  assert.match(host, /isAccessLostError\(res\.error\)\) await accessLost\(res\.error, String\(params\.canvasId/, "canvas.get 失败同样处理");
  // 保存被拒后立刻切只读（不能停在看起来能编辑）
  assert.match(host, /if \(isAccessLostError\(res\.error\)\) await accessLost\(res\.error, target\)/);
});

test("接线契约：vendor 脚本登记第 18 处改动（菜单 + 分支），面板/桥不在上游补丁里", () => {
  const vendor = read("experiments/d5-02/vendor-novai-app.mjs");
  assert.match(vendor, /第 18 处改动/);
  assert.match(vendor, /data-action=\\"share\\"/);
  assert.match(vendor, /action === 'share'/);
  assert.match(vendor, /window\.__openarcBridge\.openShare\(c\.id\)/);
  assert.match(vendor, /缺锚点即报错|目标缺失/);
  // 面板文件不由 vendor 生成（React 岛属于宿主，不写进 bundle）
  assert.equal(vendor.includes("CanvasSharePanel"), false);
});
