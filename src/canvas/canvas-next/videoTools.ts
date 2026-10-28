/**
 * 视频编辑工具（对齐 TapNow 视频工具栏）：
 *   修剪        按节点上的「使用区间」真裁剪成新视频节点（ffmpeg）
 *   智能切镜    检测画面切换，把一段视频按镜头拆成多个节点
 *   替换 / 移除 用支持「视频编辑」的模型改画面里的物体
 *   续写        用支持「视频延长」的模型接着往后生成
 *   重拍        选一段（使用区间）换机位重新生成（Video Retake）
 *   出成片      草稿模式出的低清版本，按最高清晰度重新生成
 *
 * 裁剪类工具在桌面版走主进程 media/clipToCanvas（真文件）；没有 ffmpeg / 没有桌面后端时退回
 * 「同一个视频 + 使用区间」的节点，播放、截帧、下载都按区间，并在提示里说明。
 */
import type { CanvasNode } from "../react-canvas/reactCanvasStore";
import type { VideoSegment } from "./backend/types";
import { connect } from "./actions";
import { regenAsNew, runNode } from "./engine";
import { clampTrim, defaultParams, genOf, outOf, resRange, trimIsFull, uid, type ModelSpec, type VideoMode, type VideoParams } from "./model";
import type { CanvasStore } from "./store";

export type VideoAiOp = "replace" | "remove" | "extend" | "retake";
export const RETAKE_CAMERAS = ["推近特写", "拉远全景", "环绕运镜", "俯拍", "仰拍", "侧面机位", "跟拍", "手持晃动"];

const MODE_OF: Record<VideoAiOp, VideoMode> = { replace: "视频编辑", remove: "视频编辑", extend: "视频延长", retake: "视频编辑" };
const LABEL: Record<VideoAiOp, string> = { replace: "替换", remove: "移除", extend: "续写", retake: "重拍" };

/** 视频节点当前版本 → data URL（资源引用 / 外链都先取成字节） */
export async function videoDataUrl(store: CanvasStore, n: CanvasNode): Promise<string | null> {
  let url = outOf(n)?.url || ""; if (!url) return null;
  if (url.startsWith("data:")) return url;
  if (/^https?:\/\//i.test(url) && store.backend.importRemote) url = await store.backend.importRemote(store.state.canvasId, url, genOf(n).title);
  if (url.startsWith("openarc-asset:")) return store.backend.resolveAsset(url);
  try { const b = await (await fetch(url)).blob(); return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.onerror = () => r(null); fr.readAsDataURL(b); }); } catch { return null; }
}

/** 源节点右侧排一行（已有节点时往下避让） */
function rowSpots(store: CanvasStore, src: CanvasNode, count: number) {
  const doc = store.state.doc; const gap = 30; const x0 = src.x + src.w + 120;
  let y = src.y;
  const w = src.w, h = src.h; const width = count * w + (count - 1) * gap;
  const hit = (yy: number) => doc.nodes.some((o) => o.id !== src.id && o.x < x0 + width + 20 && o.x + o.w + 20 > x0 && o.y < yy + h + 44 && o.y + o.h + 44 > yy);
  for (let i = 0; i < 40 && hit(y); i++) y += 60;
  return Array.from({ length: count }, (_, i) => ({ x: x0 + i * (w + gap), y }));
}

const segLabel = (s: VideoSegment) => `${Math.round(s.inSec * 10) / 10}s–${Math.round(s.outSec * 10) / 10}s`;

/**
 * 把若干区间做成新视频节点（连到源节点之后）。返回新节点；ok=false 表示走了「区间引用」降级。
 */
export async function segmentsToNodes(store: CanvasStore, src: CanvasNode, segs: VideoSegment[], label: string, opts: { link?: boolean } = {}): Promise<{ nodes: CanvasNode[]; real: boolean; note?: string }> {
  const o = outOf(src); if (!o?.url || !segs.length) return { nodes: [], real: false };
  const g = genOf(src); const spots = rowSpots(store, src, segs.length);
  let made: CanvasNode[] = []; let real = false; let note: string | undefined;
  if (store.backend.clipVideo) {
    const data = await videoDataUrl(store, src);
    if (data) {
      const r = await store.backend.clipVideo(store.state.canvasId, data, segs, g.title);
      if (r.ok) {
        real = true;
        r.clips.forEach((c, i) => {
          if (!c.ref) return;
          made.push(store.newNode("video", spots[i].x, spots[i].y, { title: `${g.title} · ${label}${segs.length > 1 ? " " + (i + 1) : ""}`, uploaded: true, hist: [{ url: c.ref, dur: c.duration, frame: o.frame, w: o.w, h: o.h, res: o.res }], w: src.w, h: src.h }));
        });
        const bad = r.clips.filter((c) => !c.ref).length; if (bad) note = `${bad} 段裁剪失败`;
      } else note = r.error === "FFMPEG_MISSING" ? "本机没有 ffmpeg" : r.error === "NO_BRIDGE" ? "" : `裁剪失败（${r.error}）`;
    } else note = "读取源视频失败";
  }
  if (!real) {
    // 降级：同一个视频 + 使用区间（播放 / 截帧 / 下载都按区间；发给模型的仍是整段）
    made = segs.map((s, i) => store.newNode("video", spots[i].x, spots[i].y, { title: `${g.title} · ${label}${segs.length > 1 ? " " + (i + 1) : ""}`, uploaded: true, hist: [{ ...o, trim: clampTrim(o.dur, { in: s.inSec, out: s.outSec }), draft: undefined }], w: src.w, h: src.h }));
  }
  if (!made.length) return { nodes: [], real, note };
  store.addNodes(made, opts.link === false ? [] : made.map((n) => ({ id: uid("e"), from: src.id, to: n.id })), { select: true });
  return { nodes: made.map((n) => store.node(n.id)!), real, note };
}

/** 修剪：把节点上设好的使用区间导出成一个新视频节点 */
export async function trimToNode(store: CanvasStore, n: CanvasNode) {
  const o = outOf(n); if (!o?.url) { store.toast("这个视频节点还没有可修剪的结果"); return null; }
  const t = clampTrim(o.dur, o.trim);
  if (!o.trim || trimIsFull(o.dur, o.trim)) { store.toast("先拖动视频下方的入点 / 出点选出要保留的一段，再点修剪"); return null; }
  store.toast(`正在裁剪 ${segLabel({ inSec: t.in, outSec: t.out })}…`);
  const r = await segmentsToNodes(store, n, [{ inSec: t.in, outSec: t.out }], "修剪");
  if (!r.nodes.length) { store.toast("修剪失败" + (r.note ? "：" + r.note : "")); return null; }
  store.toast(r.real ? `已裁出 ${segLabel({ inSec: t.in, outSec: t.out })} 为新视频节点` : `已新建只播放 ${segLabel({ inSec: t.in, outSec: t.out })} 的节点${r.note ? `（${r.note}，没有真正裁剪文件）` : "（模拟后端不裁剪文件）"}`, 4200);
  return r.nodes[0];
}

/** 智能切镜：按画面切换拆成多个节点 */
export async function smartClip(store: CanvasStore, n: CanvasNode) {
  const o = outOf(n); if (!o?.url) { store.toast("这个视频节点还没有结果"); return []; }
  if (!store.backend.detectScenes) { store.toast("智能切镜需要桌面版"); return []; }
  store.toast("正在检测镜头…");
  const data = await videoDataUrl(store, n); if (!data) { store.toast("读取视频失败"); return []; }
  const r = await store.backend.detectScenes(data);
  if (!r.ok) { store.toast(r.error === "FFMPEG_MISSING" ? "本机没有 ffmpeg，无法自动切镜（可设置 OPENARC_FFMPEG 指定路径）" : `切镜失败（${r.error}）`, 5000); return []; }
  if (r.shots.length < 2) { store.toast("只检测到 1 个镜头，不需要拆分"); return []; }
  const res = await segmentsToNodes(store, n, r.shots, "镜头");
  store.toast(`已按镜头拆成 ${res.nodes.length} 个视频节点${res.real ? "" : res.note ? `（${res.note}，按区间播放）` : "（按区间播放）"} · ⇧S 可堆叠`, 4600);
  return res.nodes;
}

/** 支持某种生成方式的视频模型：优先节点当前模型 */
export function modelFor(store: CanvasStore, mode: VideoMode, prefer?: ModelSpec): ModelSpec | undefined {
  if (prefer?.modes?.includes(mode)) return prefer;
  return store.modelsOf("video").find((m) => (m.modes || []).includes(mode));
}
export const opMode = (op: VideoAiOp) => MODE_OF[op];

export function aiPrompt(op: VideoAiOp, a: string, b = ""): string {
  if (op === "replace") return `把视频里的「${a.trim()}」替换成「${b.trim()}」，其余画面、人物动作、运镜和时长保持不变。`;
  if (op === "remove") return `从视频里移除「${a.trim()}」，用周围环境自然补全被遮挡的背景，其余画面、动作、运镜和时长保持不变。`;
  if (op === "extend") return a.trim() ? `接着视频的最后一帧继续往后拍：${a.trim()}。人物、场景、光线和风格与原视频一致。` : "接着视频的最后一帧自然地继续往后拍，人物、场景、光线和风格与原视频一致。";
  return `按「${a.trim()}」的机位重新拍摄这一段，人物、动作、场景、光线和时长保持不变。${b.trim() ? b.trim() : ""}`;
}

/**
 * AI 视频编辑：在源节点右侧新建视频节点（连好源视频、选好生成方式和提示词）并开始生成。
 * 重拍时若设了使用区间，先把那一段裁出来作为源。
 */
export async function aiVideoEdit(store: CanvasStore, n: CanvasNode, op: VideoAiOp, a: string, b = ""): Promise<CanvasNode | null> {
  const mode = MODE_OF[op]; const m = modelFor(store, mode, store.modelOf(n));
  if (!m) { store.toast(`还没有支持「${mode}」的视频模型（如 Seedance），请在设置 › 模型里添加`, 5000); return null; }
  if ((op === "replace" && (!a.trim() || !b.trim())) || (op === "remove" && !a.trim()) || (op === "retake" && !a.trim())) { store.toast("先填好要改的内容"); return null; }
  let src = n; const o = outOf(n);
  if (!o?.url) { store.toast("这个视频节点还没有结果"); return null; }
  if (op === "retake" && o.trim && !trimIsFull(o.dur, o.trim)) {
    const t = clampTrim(o.dur, o.trim);
    const seg = await segmentsToNodes(store, n, [{ inSec: t.in, outSec: t.out }], "重拍片段");
    if (!seg.nodes.length) { store.toast("裁剪重拍片段失败" + (seg.note ? "：" + seg.note : "")); return null; }
    src = seg.nodes[0];
  }
  const sp = genOf(n).params as VideoParams;
  const base = defaultParams("video", m) as VideoParams;
  const params: VideoParams = { ...base, model: m.id, mode, ratio: m.ratios?.includes(sp.ratio) ? sp.ratio : base.ratio, res: m.res?.includes(sp.res) ? sp.res : base.res, sound: !!(m.audio && sp.sound) };
  const pos = rowSpots(store, src, 1)[0];
  const title = `${genOf(n).title.replace(/ · .*$/, "")} · ${LABEL[op]}`;
  const node = store.newNode("video", pos.x, pos.y, { title, prompt: aiPrompt(op, a, b), params, w: n.w, h: n.h });
  store.addNodes([node], [], { select: true });
  connect(store, src.id, node.id, { quiet: true });
  // 连线后会按输入自动选生成方式，这里按工具要求的方式定回来
  store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), mode } }));
  store.toast(`已新建「${title}」并开始生成（${m.name} · ${mode}）`);
  void runNode(store, node.id);
  return store.node(node.id)!;
}

/** 草稿出成片：在下方新建节点，关掉草稿、清晰度拉到最高，沿用提示词和全部输入 */
export async function draftToFinal(store: CanvasStore, n: CanvasNode): Promise<CanvasNode | null> {
  const m = store.modelOf(n); const r = resRange(m);
  const fresh = regenAsNew(store, n);
  store.patchGen(fresh.id, (g) => ({ title: genOf(n).title.replace(/ · \d+$/, "") + " · 成片", params: { ...(g.params as VideoParams), draft: false, res: r ? r.high : (g.params as VideoParams).res } }));
  store.toast(`按 ${r ? r.high : "原清晰度"} 出成片`);
  await runNode(store, fresh.id);
  return store.node(fresh.id) || null;
}
