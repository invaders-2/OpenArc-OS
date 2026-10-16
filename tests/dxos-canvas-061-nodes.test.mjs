/**
 * 0.6.1 画布内置节点口径回归（只读源：DX OS 0.6.1
 *   src/apps/canvas/builtinCanvasNodes.ts:14-146、
 *   src/apps/canvas/nodes/director3d/definition.ts:6-18）。
 *
 * 为什么单开一份：移植侧 BUILTIN_CANVAS_NODES 之前缺 0.6.1 新增的 builtin.mosaic
 * （源 :101-107），且 director-3d 既作为数组元素又作为独立导出出现，等于留下第二条
 * 登记路径。本测试把「枚举顺序与总数同源」「mosaic 逐字同源」「director-3d 只此一份」
 * 三条钉死；将来再漂移会在 node --test 直接炸出来，而不是靠人工比对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const builtinsModule = require("../electron/developer-canvas-builtins.cjs");
const canvasModule = require("../electron/developer-canvas-manifest.cjs");

const { BUILTIN_CANVAS_NODES } = builtinsModule;

// 源 builtinCanvasNodes.ts:14-146 的数组顺序：:15 先并入 nodes/director3d/definition.ts:6-18，
// 其后是 :16-145 的 16 个内联定义（mosaic 在 :101-107，介于 image-compare 与 group 之间）。
const SOURCE_ORDER = [
  "builtin.director-3d", "builtin.image-asset", "builtin.video-asset", "builtin.audio-asset",
  "builtin.file-asset", "builtin.image-generator", "builtin.midjourney-generator",
  "builtin.video-generator", "builtin.audio-generator", "builtin.llm", "builtin.table",
  "builtin.image-compare", "builtin.mosaic", "builtin.group", "builtin.prompt",
  "builtin.sticky", "builtin.junction",
];

// 源 builtinCanvasNodes.ts:101-107 逐字（注意源里没有 capabilityVersion / semanticRoles / agent）。
const SOURCE_MOSAIC = {
  type: "builtin.mosaic",
  version: 1,
  stateVersion: 1,
  title: "图片拼接",
  category: "image",
  defaultSize: { width: 380, height: 300 },
  inputs: [
    { id: "images", title: "图片", type: "media.image[]", multiple: true },
    { id: "texts", title: "逐图文字", type: "text", multiple: true },
  ],
  outputs: [{ id: "image", title: "拼接图片", type: "media.image" }],
  executor: { type: "builtin", id: "canvas.image.mosaic" },
};

test("0.6.1 口径：枚举顺序与总数同源（17 项，含 builtin.mosaic）", () => {
  assert.deepEqual(BUILTIN_CANVAS_NODES.map((node) => node.type), SOURCE_ORDER);
  assert.equal(BUILTIN_CANVAS_NODES.length, 17);
  assert.equal(new Set(SOURCE_ORDER).size, 17, "节点类型不得重复");
  for (const node of BUILTIN_CANVAS_NODES) assert.ok(node.type.startsWith("builtin."), node.type);
});

test("builtin.mosaic 逐字移植源 builtinCanvasNodes.ts:101-107", () => {
  const mosaic = BUILTIN_CANVAS_NODES.find((node) => node.type === "builtin.mosaic");
  assert.ok(mosaic, "缺 builtin.mosaic 说明仍停在 0.6.1 之前");
  assert.deepEqual(mosaic, SOURCE_MOSAIC);
  // 源 :102-107 未声明这三个字段，移植侧不许自行补齐（补齐会误触发 v2 能力校验路径）。
  for (const key of ["capabilityVersion", "semanticRoles", "agent"]) {
    assert.equal(key in mosaic, false, "builtin.mosaic 不应包含 " + key);
  }
});

test("director-3d 只此一份：数组内唯一，导出面不再出现第二份定义", () => {
  const inArray = BUILTIN_CANVAS_NODES.filter((node) => node.type === "builtin.director-3d");
  assert.equal(inArray.length, 1);

  // 源 builtinCanvasNodes.ts:4 只 import 一次后并入数组；若再单独 module.exports，
  // 枚举所有导出定义时会数到两份 builtin.director-3d（即便引用同一对象）。
  const exportedDefinitions = Object.values(builtinsModule).flatMap((value) =>
    Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [],
  );
  const exportedDirector = exportedDefinitions.filter((node) => node && node.type === "builtin.director-3d");
  assert.equal(exportedDirector.length, 1, "导出面只允许一份 builtin.director-3d");
  assert.equal(exportedDirector[0], inArray[0], "数组内那份就是唯一一份（同一对象）");
});

test("builtin.mosaic 进入清单校验路径：模板可引用，未知类型仍结构化拒绝", () => {
  const template = (nodeType) => ({
    format: "dx-canvas-templates/v1",
    templates: [{ id: "tpl", title: "拼接模板", nodes: [{ id: "m", nodeType, x: 0, y: 0 }], connections: [] }],
  });
  const accepted = canvasModule.validateCanvasTemplateManifest(template("builtin.mosaic"), "demo", []);
  assert.equal(accepted.templates[0].nodes[0].nodeType, "builtin.mosaic");
  assert.throws(
    () => canvasModule.validateCanvasTemplateManifest(template("builtin.not-a-node"), "demo", []),
    (error) => error instanceof Error && error.canvasCode === "CANVAS_UNKNOWN_NODE_TYPE",
  );
});
