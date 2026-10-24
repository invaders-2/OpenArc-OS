import type { CanvasDoc, CanvasNode } from "./reactCanvasStore";

type Scope = "view" | "selected" | "all";
type View = { x: number; y: number; k: number };
const PADDING = 40;
function nodeBounds(nodes: CanvasNode[]) { const minX = Math.min(...nodes.map((n) => n.x)); const minY = Math.min(...nodes.map((n) => n.y)); const maxX = Math.max(...nodes.map((n) => n.x + n.w)); const maxY = Math.max(...nodes.map((n) => n.y + n.h)); return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }; }
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
async function loadImage(url: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => resolve(img); img.onerror = () => reject(new Error("图片加载失败或跨域受限")); img.src = url; }); }
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) { const lines: string[] = []; let line = ""; for (const char of text) { const next = line + char; if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = char; if (lines.length >= maxLines) break; } else line = next; } if (lines.length < maxLines && line) lines.push(line); return lines; }

export async function exportCanvasPng({ doc, scope, selectedIds, view, viewportWidth, viewportHeight, showDots = true, showEdges = true }: { doc: CanvasDoc; scope: Scope; selectedIds: string[]; view: View; viewportWidth: number; viewportHeight: number; showDots?: boolean; showEdges?: boolean }) {
  const selected = scope === "selected" ? doc.nodes.filter((node) => selectedIds.includes(node.id)) : doc.nodes;
  if (scope === "selected" && !selected.length) throw new Error("没有选中节点");
  const source = selected.length ? selected : doc.nodes;
  if (!source.length && scope !== "view") throw new Error("画布没有可导出的内容");
  let box = { x: 0, y: 0, w: viewportWidth, h: viewportHeight };
  if (scope !== "view") { const b = nodeBounds(source); box = { x: b.x * view.k + view.x - PADDING, y: b.y * view.k + view.y - PADDING, w: b.w * view.k + PADDING * 2, h: b.h * view.k + PADDING * 2 }; }
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(box.w * scale)); canvas.height = Math.max(1, Math.ceil(box.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建导出画布");
  ctx.scale(scale, scale); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, box.w, box.h);
  ctx.save(); ctx.translate(-box.x, -box.y);
  if (showDots) { const step = 28 * Math.max(view.k, 0.2); ctx.fillStyle = "rgba(255,255,255,.10)"; for (let x = ((view.x % step) + step) % step; x < box.w; x += step) for (let y = ((view.y % step) + step) % step; y < box.h; y += step) { ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill(); } }
  const screen = (node: CanvasNode) => ({ x: node.x * view.k + view.x, y: node.y * view.k + view.y, w: node.w * view.k, h: node.h * view.k });
  if (showEdges) { ctx.strokeStyle = "rgba(255,255,255,.28)"; ctx.lineWidth = 1.5; for (const edge of doc.edges) { const from = doc.nodes.find((n) => n.id === edge.from); const to = doc.nodes.find((n) => n.id === edge.to); if (!from || !to) continue; const a = screen(from); const b = screen(to); ctx.beginPath(); ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2); ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2); ctx.stroke(); } }
  for (const node of selected.length ? selected : doc.nodes) {
    if (!doc.nodes.includes(node)) continue;
    const s = screen(node);
    ctx.save(); roundRect(ctx, s.x, s.y, s.w, s.h, 16 * view.k); ctx.fillStyle = "#181818"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = 1; ctx.stroke(); ctx.clip();
    if (node.url && node.kind === "image") { const img = await loadImage(node.url); const ratio = Math.max(s.w / img.naturalWidth, s.h / img.naturalHeight); const iw = img.naturalWidth * ratio; const ih = img.naturalHeight * ratio; ctx.drawImage(img, s.x + (s.w - iw) / 2, s.y + (s.h - ih) / 2, iw, ih); }
    else if (node.kind === "text" || node.kind === "note") { ctx.fillStyle = "#f5f5f5"; ctx.font = Math.max(11, 13 * view.k) + "px -apple-system, sans-serif"; ctx.textBaseline = "top"; const lines = wrapText(ctx, node.text || "", s.w - 24, 8); lines.forEach((line, index) => ctx.fillText(line, s.x + 12, s.y + 14 + index * 18 * Math.max(view.k, .8))); }
    else { ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.font = Math.max(10, 12 * view.k) + "px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; const label = node.kind === "model3d" ? "3D 模型" : node.kind === "scene3d" ? "3D 片场" : node.kind === "timeline" ? "剪辑时间线" : "媒体"; ctx.fillText(label, s.x + s.w / 2, s.y + s.h / 2); }
    ctx.restore();
  }
  ctx.restore();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG 编码失败");
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "canvas-" + scope + ".png"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { bytes: blob.size, width: canvas.width, height: canvas.height };
}
