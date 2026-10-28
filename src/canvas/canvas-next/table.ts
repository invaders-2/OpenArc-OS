/**
 * 多维表格（简化自 NOVAI / DX OS 的 table 节点，见 NOVAI docs/v2/DXOS_TABLE_SPEC.md）。
 *
 * 节点：kind = "table"，数据在 node.data.table。
 *   上游 —— ① 文本节点「输出：多维表格 / 分镜表」跑完后自动建表并连线（表格由文本模型生成）；
 *          ② 图片 / 视频 / 音频节点直接连进表格 → 成为最左侧的「输入列」：
 *             只有 1 个素材 → 所有行共用（shared）；多个 → 逐行对应（sequence）。
 *   下游 —— 表格连到生成节点 → 生成节点按行批量生成（见 engine.ts 的 runTableBatch）：
 *             每行提示词 = 上游文本 + 节点提示词 + 该行「列名：值」；每行素材 = 节点自身输入 + 该行输入列素材。
 *
 * 和 NOVAI 相比的简化：输入列由连线自动推导（不做「钉住通道」）；出表一遍生成 + 失败修复一次（不做规划遍）；
 * 不做合并单元格。上限沿用：手工 200 列 / 5000 行，模型生成 40 列 / 200 行，单元格 20000 字。
 */
import type { CanvasDoc, CanvasNode } from "../react-canvas/reactCanvasStore";
import { genOf, inputsOf, isGenKind, outOf, srcOf, textOf, uid, type GenKind } from "./model";

export const TABLE_LIMITS = { cols: 200, rows: 5000, llmCols: 40, llmRows: 200, cell: 20000 };
export type TableData = {
  kind: "table"; version: 1;
  title: string;
  columns: string[];
  rows: string[][];
  /** 由哪个文本节点生成（重新出表时更新这张，而不是再建一张） */
  sourceId?: string;
  /** 输入列模式：auto 按素材数量判断 */
  inputMode?: "auto" | "shared" | "sequence";
};
export type TextOutputMode = "text" | "table" | "storyboard";
export const OUTPUT_MODES: Array<[TextOutputMode, string, string]> = [["text", "文本", "普通文字结果"], ["table", "多维表格", "整理成逐行可执行的任务表"], ["storyboard", "分镜表", "镜头 / 画面 / 运镜 / 时长 / 台词"]];
export const STORYBOARD_COLUMNS = ["镜头", "画面", "运镜", "时长", "台词 / 字幕"];

export function emptyTable(): TableData {
  return { kind: "table", version: 1, title: "多维表格", columns: ["字段 1", "字段 2", "字段 3"], rows: [["", "", ""], ["", "", ""], ["", "", ""]] };
}
export function tableOf(node: CanvasNode): TableData {
  const raw = node.data && typeof node.data === "object" ? (node.data as { table?: unknown }).table : undefined;
  const t = normalizeTable(raw, false);
  if (t) return t;
  // 旧版只读表格（react-canvas 的 legacy table）：data 是二维数组或 {columns, rows}/{cells}
  const legacy = normalizeLegacy(node.data);
  return legacy || emptyTable();
}
export function withTable(node: CanvasNode, t: TableData): CanvasNode {
  return { ...node, text: t.title, data: { ...(node.data && typeof node.data === "object" ? node.data : {}), table: t } };
}

/** 归一化（DX OS Mx）：列名去空补「未命名列」，行补齐列数，非字符串 stringify，截断 */
export function normalizeTable(raw: unknown, llm: boolean): TableData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.columns) || !Array.isArray(r.rows)) return null;
  const maxC = llm ? TABLE_LIMITS.llmCols : TABLE_LIMITS.cols, maxR = llm ? TABLE_LIMITS.llmRows : TABLE_LIMITS.rows;
  const columns = r.columns.slice(0, maxC).map((c, i) => String(c ?? "").trim() || `未命名列 ${i + 1}`);
  if (!columns.length) return null;
  const cell = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)).slice(0, TABLE_LIMITS.cell);
  const rows = r.rows.slice(0, maxR).map((row) => { const arr = Array.isArray(row) ? row : row && typeof row === "object" ? columns.map((c) => (row as Record<string, unknown>)[c]) : [row]; return columns.map((_, i) => cell(arr[i])); });
  return { kind: "table", version: 1, title: typeof r.title === "string" && r.title ? r.title : "多维表格", columns, rows, ...(typeof r.sourceId === "string" ? { sourceId: r.sourceId } : {}), ...(r.inputMode === "shared" || r.inputMode === "sequence" ? { inputMode: r.inputMode } : {}) };
}
function normalizeLegacy(raw: unknown): TableData | null {
  const any = raw as any;
  const matrix: unknown[][] | null = Array.isArray(any) ? any : Array.isArray(any?.cells) ? any.cells : null;
  if (matrix && matrix.length) return normalizeTable({ columns: matrix[0], rows: matrix.slice(1) }, false);
  if (any && Array.isArray(any.columns)) return normalizeTable({ columns: any.columns, rows: Array.isArray(any.rows) ? any.rows : [] }, false);
  return null;
}

/** 解析模型返回（DX OS a6）：剥 ```json、取首尾大括号、JSON.parse、校验 */
export function parseTableJson(text: string): TableData {
  let s = String(text || "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s); if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("模型没有返回统一的多维表格格式");
  let obj: unknown; try { obj = JSON.parse(s.slice(a, b + 1)); } catch { throw new Error("模型没有返回统一的多维表格格式"); }
  const t = normalizeTable(obj, true);
  if (!t) throw new Error("模型没有返回统一的多维表格格式");
  if ((obj as any).columns.some((c: unknown) => !String(c ?? "").trim())) throw new Error("模型返回的表格列名不完整");
  if (!t.rows.length) throw new Error("LLM 没有生成可执行的多维表格。");
  return t;
}

/** 出表提示词（DX OS BS 的 list 分支，简化为一遍） */
export function tablePrompt(task: string, mode: TextOutputMode, mediaCount: number): string {
  const cols = mode === "storyboard" ? `列固定为：${JSON.stringify(STORYBOARD_COLUMNS)}。每行是一个镜头。` : "请根据任务自行设计最合适的列结构，不套固定模板。";
  return [
    "请把结果整理为可逐行执行的生成任务：每一行必须是一条完整、独立、可直接用于后续图像或视频生成的内容。",
    "严格遵守用户指定的数量；未指定时根据输入数量和任务目标合理决定。" + (mediaCount ? `当前有 ${mediaCount} 个素材输入：图片组通常逐张映射到各行，单图参考通常应用到所有相关行。` : ""),
    "如果任务区分了「目标主体」和「风格/版式参考」，每行内容都必须显式写清它们的关系。",
    "不要只写「使用图1」「参考图2」这类占位说明，每个文字单元格都要有足够的信息密度。",
    cols,
    "行的先后顺序已经表达执行顺序，不需要额外的序号列。",
    "不要在 JSON 中创建图片、参考图或生成输入列，系统会在独立的输入列里放素材。",
    "只返回一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：",
    '{"kind":"table","version":1,"columns":["列名1","列名2"],"rows":[["单元格1","单元格2"]]}',
    "", "任务：", task,
  ].join("\n");
}
export function repairPrompt(bad: string): string {
  return "请把下面未通过校验的结果修复为合法的多维表格 JSON。不要删减原有信息，不要输出解释或 Markdown。格式：\n" + '{"kind":"table","version":1,"columns":["列名1"],"rows":[["单元格1"]]}' + "\n\n" + bad.slice(0, 30000);
}

/* ---------- 输入列：从连进表格的素材节点推导 ---------- */
export type TableMedia = { nodeId: string; kind: GenKind; title: string; src: string; url?: string };
export function tableMedia(doc: CanvasDoc, tableId: string): TableMedia[] {
  const node = doc.nodes.find((n) => n.id === tableId);
  const direct = inputsOf(doc, tableId).filter((x) => isGenKind(x.node.kind) && x.node.kind !== "text");
  // 由文本节点生成的表：没有直接素材时，继承那个文本节点的素材输入
  let list = direct;
  if (!list.length && node) { const t = tableOf(node); if (t.sourceId) list = inputsOf(doc, t.sourceId).filter((x) => isGenKind(x.node.kind) && x.node.kind !== "text"); }
  return list.map((x) => ({ nodeId: x.node.id, kind: x.node.kind as GenKind, title: genOf(x.node).title, src: srcOf(x.node), url: outOf(x.node)?.url }));
}
export function inputModeOf(t: TableData, media: TableMedia[]): "shared" | "sequence" { return t.inputMode && t.inputMode !== "auto" ? t.inputMode : media.length > 1 ? "sequence" : "shared"; }
/** 第 row 行（0 起）对应的素材：sequence 逐行，shared 全部共用 */
export function mediaForRow(t: TableData, media: TableMedia[], row: number): TableMedia[] {
  if (!media.length) return [];
  return inputModeOf(t, media) === "sequence" ? (media[row] ? [media[row]] : []) : media;
}

/* ---------- 下游：生成节点读表 ---------- */
export type BatchRow = { row: number; text: string; media: TableMedia[]; tableId: string };
/** 生成节点的所有上游表格的逐行任务（DX OS Pu）：行数取各表最大行数，空行跳过 */
export function batchRows(doc: CanvasDoc, genId: string): BatchRow[] {
  const tables = inputsOf(doc, genId).filter((x) => x.node.kind === "table").map((x) => x.node);
  if (!tables.length) return [];
  const n = Math.max(...tables.map((t) => tableOf(t).rows.length));
  const out: BatchRow[] = [];
  for (let r = 0; r < n; r++) {
    const media: TableMedia[] = []; const lines: string[] = [];
    for (const tn of tables) {
      const t = tableOf(tn); const tm = tableMedia(doc, tn.id);
      media.push(...mediaForRow(t, tm, r));
      (t.rows[r] || []).forEach((v, i) => { if (v && v.trim()) lines.push(`${t.columns[i]}：${v.trim()}`); });
    }
    out.push({ row: r + 1, text: lines.join("\n"), media, tableId: tables[0].id });
  }
  return out;
}
export type BatchSettings = { concurrency: number; startRow: number; manual: boolean; selected: number[]; failure: "stop" | "continue" };
export const DEFAULT_BATCH: BatchSettings = { concurrency: 3, startRow: 1, manual: false, selected: [], failure: "continue" };
export type BatchJournal = { runId: string; rows: Array<{ row: number; status: "pending" | "running" | "completed" | "failed"; nodeId?: string; error?: string }> };
export function batchOf(node: CanvasNode): { settings: BatchSettings; journal: BatchJournal | null } {
  const raw = node.data && typeof node.data === "object" ? (node.data as { batch?: any }).batch : undefined;
  const s = { ...DEFAULT_BATCH, ...(raw?.settings || {}) } as BatchSettings;
  s.concurrency = Math.max(1, Math.min(8, Math.round(Number(s.concurrency) || 3)));
  s.startRow = Math.max(1, Math.round(Number(s.startRow) || 1));
  return { settings: s, journal: raw?.journal && Array.isArray(raw.journal.rows) ? raw.journal : null };
}
export function withBatch(node: CanvasNode, patch: { settings?: Partial<BatchSettings>; journal?: BatchJournal | null }): CanvasNode {
  const cur = batchOf(node);
  const batch = { settings: { ...cur.settings, ...(patch.settings || {}) }, journal: patch.journal === undefined ? cur.journal : patch.journal };
  return { ...node, data: { ...(node.data && typeof node.data === "object" ? node.data : {}), batch } };
}
/** 本次要跑的行（DX OS bl）：手动模式 = 已选行；批量模式 = 起始行之后；都要有内容 */
export function rowsToRun(rows: BatchRow[], s: BatchSettings): BatchRow[] {
  const has = (r: BatchRow) => r.media.length > 0 || !!r.text.trim();
  return s.manual ? rows.filter((r) => s.selected.includes(r.row) && has(r)) : rows.filter((r) => r.row >= s.startRow && has(r));
}
export function emptyRunHint(rows: BatchRow[], s: BatchSettings): string {
  if (s.manual) return "请先点击上方行，选择至少一行独立运行";
  if (s.startRow > rows.length) return `起始行超出表格范围，当前共 ${rows.length} 行`;
  return "起始行之后没有可生成的内容";
}

/* ---------- 尺寸（DX OS Yw / mR，按我们的节点比例收一点） ---------- */
export const TABLE_COL_W = 132, TABLE_INPUT_COL_W = 96, TABLE_HEAD_H = 34;
export function rowHeight(cells: string[], hasMedia: boolean): number {
  const lines = Math.max(1, ...cells.map((c) => Math.ceil((c || "").length / 16) || 1));
  return Math.min(140, Math.max(hasMedia ? 84 : 40, 20 + lines * 15));
}
export function tableAutoSize(t: TableData, mediaCols: number): { w: number; h: number } {
  const w = Math.max(320, Math.min(800, (mediaCols ? TABLE_INPUT_COL_W : 0) + t.columns.length * TABLE_COL_W + 36));
  const h = Math.min(640, TABLE_HEAD_H + t.rows.reduce((s, r) => s + rowHeight(r, mediaCols > 0), 0) + 40);
  return { w, h: Math.max(160, h) };
}
export const newTableId = () => uid("t");
export { textOf };
