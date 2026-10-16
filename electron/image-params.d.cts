/** D5-02 · 图像尺寸策略（画布页 shared/size-policy.js 消费的那张表）的类型声明。
 *  运行时由 electron/image-params.cjs 提供；这里只声明渲染进程 CanvasHost 用到的形状，不改主进程逻辑。*/

export type SizePolicyTier = { id: string; maxPixels: number };

export type SizePolicy = {
  mode: "free" | "bounds" | "enum";
  hintOnly: boolean;
  maxEdge: number;
  maxPixels: number;
  minPixels: number;
  multipleOf: number;
  options: readonly string[];
  prefer: "ratio" | "area";
  autoSize: boolean;
  defaultLevel: string;
  tiers: readonly SizePolicyTier[];
};

/** 页面 normalizeTable 的输入形状（format + 默认策略 + 按模型显示名索引的策略）。*/
export type SizePolicyTable = {
  format: string;
  default: SizePolicy;
  models: Record<string, SizePolicy>;
};

/** 把画布模型清单展开成页面期望的策略表；策略数值只来自本模块的 GPT_IMAGE_2_SIZE_POLICY。*/
export function buildSizePolicyTable(entries: { key?: string; model?: string }[]): SizePolicyTable;
