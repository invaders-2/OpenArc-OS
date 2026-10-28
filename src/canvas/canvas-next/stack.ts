/**
 * 多节点堆叠（TapNow Stack）：把 2–50 个选中节点收成一叠。
 *
 * 数据上沿用分组节点（kind: "group"），用 data.stack 标记；成员 id 在 children 里。
 * 成员节点仍在文档里（位置、连线、生成数据都不动），只是收在叠里时不在画布上显示；
 * 取消堆叠后原样回到画布。这样旧版画布读到的也只是一个普通分组，不会丢节点。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { genOf, isGenKind, outOf, uid } from "./model";
import type { CanvasStore } from "./store";

export const STACK_MIN = 2;
export const STACK_MAX = 50;
export const STACK_SIZE = { w: 260, h: 260 };

export const isStack = (n: CanvasNode | undefined | null): boolean => !!n && n.kind === "group" && !!(n.data && typeof n.data === "object" && (n.data as { stack?: unknown }).stack);

/** 叠里的成员（按叠内顺序，已删除的跳过） */
export function stackItems(doc: CanvasDoc, stack: CanvasNode): CanvasNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  return (stack.children || []).map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n);
}

/** 收在叠里、不在画布上显示的节点 id */
export function hiddenIds(nodes: CanvasNode[]): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) if (isStack(n)) (n.children || []).forEach((id) => out.add(id));
  return out;
}

/** 节点所在的叠（没有返回 undefined） */
export const stackOf = (doc: CanvasDoc, id: string) => doc.nodes.find((n) => isStack(n) && (n.children || []).includes(id));

/** 能放进叠的节点：普通节点（不收分组 / 叠，叠不能套叠） */
const stackable = (n: CanvasNode | undefined): n is CanvasNode => !!n && n.kind !== "group";

/** 选中的节点收成一叠，叠放在第一个节点的位置 */
/** 分组 / 堆叠的显示名 */
export const groupLabel = (n: CanvasNode) => (isStack(n) ? "堆叠" : n.text && n.text !== "分组" ? n.text : "分组");

export function stackSelection(store: CanvasStore): CanvasNode | null {
  const doc = store.state.doc;
  const ids = [...store.state.ui.sel].filter((id) => stackable(store.node(id)) && !stackOf(doc, id));
  if (ids.length < STACK_MIN) { store.toast(`至少选中 ${STACK_MIN} 个节点才能堆叠`); return null; }
  if (ids.length > STACK_MAX) { store.toast(`一叠最多 ${STACK_MAX} 个节点，当前选中 ${ids.length} 个`); return null; }
  const items = ids.map((id) => store.node(id)!).sort((a, b) => a.y - b.y || a.x - b.x);
  const first = items[0];
  const s: CanvasNode = { id: uid("s"), kind: "group", x: first.x, y: first.y, w: STACK_SIZE.w, h: STACK_SIZE.h, text: "堆叠", children: items.map((n) => n.id), data: { stack: true } };
  store.addNodes([s], [], { select: true, history: true });
  store.toast(`已把 ${items.length} 个节点堆叠 · 双击展开`);
  return s;
}

/** 取消堆叠：成员回到画布原位，叠本身删除 */
export function unstack(store: CanvasStore, sid: string) {
  const s = store.node(sid); if (!isStack(s)) return;
  const items = stackItems(store.state.doc, s!);
  store.mutate((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== sid) }), { history: true });
  store.setUI({ sel: new Set(items.map((n) => n.id)) });
  store.toast(`已取消堆叠：${items.length} 个节点回到画布`);
}

/** 拖进叠：节点从画布收进叠的末尾 */
export function addToStack(store: CanvasStore, sid: string, ids: string[]) {
  const s = store.node(sid); if (!isStack(s)) return 0;
  const doc = store.state.doc; const have = new Set(s!.children || []);
  const add = ids.filter((id) => id !== sid && stackable(store.node(id)) && !have.has(id) && !stackOf(doc, id));
  if (!add.length) return 0;
  if (have.size + add.length > STACK_MAX) { store.toast(`一叠最多 ${STACK_MAX} 个节点`); return 0; }
  // 从普通分组里拖进叠：同时移出原分组，一个节点只属于一个容器
  const addSet = new Set(add);
  store.mutate((d) => ({ ...d, nodes: d.nodes.map((n) => n.id === sid ? { ...n, children: [...(n.children || []), ...add] }
    : n.kind === "group" && (n.children || []).some((c) => addSet.has(c)) ? { ...n, children: (n.children || []).filter((c) => !addSet.has(c)) } : n) }), { history: true });
  store.setUI({ sel: new Set([sid]) });
  store.toast(`已放进堆叠：${add.length} 个节点`);
  return add.length;
}

/**
 * 从叠里拿出一个节点，放到叠右侧。叠里只剩 1 个时自动解散（TapNow：少于 2 个不成叠）。
 */
export function takeFromStack(store: CanvasStore, sid: string, id: string) {
  const s = store.node(sid); if (!isStack(s)) return;
  const rest = (s!.children || []).filter((x) => x !== id && store.node(x));
  const n = store.node(id); if (!n) return;
  const doc = store.state.doc;
  // 叠右侧找一处空位
  const x = s!.x + s!.w + 60; let y = s!.y;
  const hidden = hiddenIds(doc.nodes);
  const hit = (yy: number) => doc.nodes.some((o) => o.id !== id && !hidden.has(o.id) && o.x < x + n.w + 20 && o.x + o.w + 20 > x && o.y < yy + n.h + 44 && o.y + o.h + 44 > yy);
  for (let i = 0; i < 40 && hit(y); i++) y += 60;
  store.mutate((d) => {
    let nodes = d.nodes.map((o) => (o.id === id ? { ...o, x, y } : o.id === sid ? { ...o, children: rest } : o));
    if (rest.length < STACK_MIN) nodes = nodes.filter((o) => o.id !== sid);
    return { ...d, nodes };
  }, { history: true });
  store.setUI({ sel: new Set([id]) });
  store.toast(rest.length < STACK_MIN ? "已移出；叠里只剩 1 个节点，堆叠已解散" : "已移出堆叠");
}

/** 叠封面：前 3 个有画面的成员（图片地址 / 视频封面），没有画面的用类型占位 */
export function stackCover(doc: CanvasDoc, s: CanvasNode) {
  return stackItems(doc, s).slice(0, 3).map((n) => {
    const o = isGenKind(n.kind) ? outOf(n) : null;
    return { id: n.id, kind: n.kind, title: isGenKind(n.kind) ? genOf(n).title : n.text || n.kind, src: n.kind === "image" ? o?.url || "" : n.kind === "video" ? o?.frame || "" : "", text: n.kind === "text" ? (o?.text || "").slice(0, 120) : "" };
  });
}
