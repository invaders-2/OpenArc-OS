/**
 * 「拉取模型」弹窗的勾选 → 增删计划（纯逻辑，无 DOM / 无网络，node --test 直跑）。
 *
 * 口径（老板要求：拉取默认不全部加入，画布里只显示勾选/已加入的模型）：
 *   · registered = 已加入模型库；picked = 本次勾选的未加入模型；dropped = 本次取消勾选的已加入模型。
 *   · adds = 勾选且未 registered（刚拉取时 picked 为空 → 零个，绝不默认全加）。
 *   · removals = registered 且被取消勾选。
 * 能力随模型带：adds 的 capabilities 优先用勾选时记下的值，缺省回落到 classifyRemoteModel 的推断，
 * 与「单个加入」同一口径（未识别能力的模型如实带空能力，不硬塞 chat）。
 */
import { classifyRemoteModel, normalizeModelCapabilities, type RemoteModelItem } from "./modelCategories.ts";

export interface CuratePicks {
  /** 未加入的模型：被勾选的 id → 勾选时记下的能力。 */
  picked?: Record<string, string[]> | null;
  /** 已加入的模型：被取消勾选（= 本次移除）的 id 集合。 */
  dropped?: Record<string, boolean> | null;
}

export interface CuratePlan {
  adds: { id: string; capabilities: string[] }[];
  removals: string[];
}

function droppedSet(map: CuratePicks["dropped"]): Record<string, true> {
  const out: Record<string, true> = {};
  if (!map || typeof map !== "object") return out;
  for (const [key, value] of Object.entries(map)) if (key && value) out[key] = true;
  return out;
}

function pickedMap(map: CuratePicks["picked"]): Record<string, unknown> {
  return map && typeof map === "object" ? (map as Record<string, unknown>) : {};
}

/** 一个模型本次「要加入」时带的能力：勾选值优先，否则按模型名/上游建议推断。 */
export function curateCapabilities(item: RemoteModelItem, pickedCaps?: unknown): string[] {
  if (Array.isArray(pickedCaps)) return normalizeModelCapabilities(pickedCaps);
  return classifyRemoteModel(item).capabilities;
}

/** 行内勾选框的状态：已加入的行默认勾上（取消=移除）；未加入的行默认不勾（勾上=加入）。 */
export function curateRowChecked(item: { id?: unknown; registered?: boolean } | null | undefined, picks: CuratePicks = {}): boolean {
  const id = item && item.id != null ? String(item.id) : "";
  if (!id) return false;
  if (item?.registered === true) return !droppedSet(picks.dropped)[id];
  return Object.prototype.hasOwnProperty.call(pickedMap(picks.picked), id);
}

/**
 * 本次弹窗要执行的差异。
 * @param items provider/models 的清单（含 registered 标记）
 * @param picks 勾选/取消勾选状态
 */
export function buildCuratePlan(items: unknown, picks: CuratePicks = {}): CuratePlan {
  const list = Array.isArray(items) ? items : [];
  const dropped = droppedSet(picks ? picks.dropped : null);
  const picked = pickedMap(picks ? picks.picked : null);
  const seen = new Set<string>();
  const adds: CuratePlan["adds"] = [];
  const removals: string[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as RemoteModelItem;
    const id = item.id == null ? "" : String(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (item.registered === true) {
      if (dropped[id]) removals.push(id);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(picked, id)) continue;
    adds.push({ id, capabilities: curateCapabilities(item, picked[id]) });
  }
  return { adds, removals };
}

/** 批量勾选的结果：一份新的 picked / dropped（一次赋值，不逐行触发重渲染）。 */
export interface CurateState {
  picked: Record<string, string[]>;
  dropped: Record<string, true>;
}

export type BulkPickAction = "select" | "clear" | "reset";

/**
 * 批量勾选（分类页的「全选本类 / 清空本类」、顶部的「清空已选」）。
 *
 *   select：未加入的勾上（能力随模型），已加入的恢复保留（从 dropped 里移除）；
 *   clear（清空本类）：未加入的清掉勾选，已加入的标记移除（dropped）；
 *   reset（清空已选）：本次所有勾选与取消勾选一起清空，回到「默认都保留、一个不加」。
 *
 * @param scopeIds 只作用这些 id（分类页传本类 id）；不传 = 清单里全部模型。
 *                  作用范围外的 picked / dropped 原样保留（跨分类互不影响）。
 */
export function buildBulkPick(items: unknown, picks: CuratePicks = {}, action: BulkPickAction, scopeIds?: string[] | null): CurateState {
  if (action === "reset") return { picked: {}, dropped: {} };
  const source = picks && typeof picks === "object" ? picks : {};
  const nextPicked: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(pickedMap(source.picked))) if (key && Array.isArray(value)) nextPicked[key] = [...value];
  const nextDropped: Record<string, true> = droppedSet(source.dropped);
  const scope = Array.isArray(scopeIds) ? new Set(scopeIds.map((id) => String(id))) : null;
  const seen = new Set<string>();
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as RemoteModelItem;
    const id = item.id == null ? "" : String(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (scope && !scope.has(id)) continue;
    if (item.registered === true) {
      if (action === "select") delete nextDropped[id];
      else nextDropped[id] = true;
      continue;
    }
    if (action === "select") nextPicked[id] = curateCapabilities(item, nextPicked[id]);
    else delete nextPicked[id];
  }
  return { picked: nextPicked, dropped: nextDropped };
}
