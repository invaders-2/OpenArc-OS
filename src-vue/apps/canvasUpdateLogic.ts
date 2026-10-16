/**
 * 画布专用入口（兼容层）。
 *
 * 通用实现已经泛化到 src-vue/apps/appUpdateLogic.ts（按 appId 驱动）；本文件只是把画布参数
 * 包一层，保证既有探针 / 单测的导入路径与行为不变：
 *   · canvasUpdateView / confirmCopy / confirmDecision 缺省即 canvas（它们就是通用实现本身，
 *     appId / appName 省略时回落 canvas，所以这里直接别名，不再复制一份确认门）；
 *   · data-canvas-update-* 取证属性与 CANVAS_UPDATE_SELECTORS 原样保留。
 *
 * 新代码请直接 import "./appUpdateLogic"。
 */
export * from "./appUpdateLogic.ts";

import {
  appConfirmCopy,
  appConfirmDecision,
  appUpdateView,
  normalizeAppUpdateSources,
  normalizeAppUpdateStatus,
  type AppUpdateBusy,
  type AppUpdatePendingAction,
  type AppUpdateSources,
  type AppUpdateStatus,
} from "./appUpdateLogic.ts";

export const canvasUpdateView = appUpdateView;
export const confirmCopy = appConfirmCopy;
export const confirmDecision = appConfirmDecision;
export const normalizeCanvasUpdateStatus = normalizeAppUpdateStatus;
export const normalizeCanvasUpdateSources = normalizeAppUpdateSources;

export type CanvasUpdateBusy = AppUpdateBusy;
export type CanvasUpdatePendingAction = AppUpdatePendingAction;
export type CanvasUpdateSources = AppUpdateSources;
export type CanvasUpdateStatus = AppUpdateStatus;
