/**
 * B7x · 内置画布节点定义（**纯数据，无 I/O**）。
 *
 * 为什么单独一层：dx-app.json 的 canvas.templates.json 允许模板节点引用 builtin.*。
 * 源 server/developerApps.ts:404 会把 [...BUILTIN_CANVAS_NODES, ...插件节点] 合成
 * allDefinitions 再做存在性 / 端口兼容校验；缺了本文件，builtin.* 连线就只能被"无法验证"跳过。
 * 本文件把内置节点定义冻结成一份纯数据，供 electron/developer-canvas-manifest.cjs 直接使用。
 *
 * 逐字移植自只读源（行号为源文件行号）：
 *   · src/apps/canvas/nodes/director3d/definition.ts:6-18   DIRECTOR_3D_NODE_DEFINITION
 *   · src/apps/canvas/builtinCanvasNodes.ts:6-12            textInput / mediaInputs / generationInputs
 *   · src/apps/canvas/builtinCanvasNodes.ts:14-146          BUILTIN_CANVAS_NODES
 *
 * 与 electron/canvas-domain.cjs 的 NODE_TYPES（source :36）不是同一套概念：
 *   前者是 OpenArc 无限画布文档里的 card kind（prompt/image/llm/generator/…），服务于
 *   canvas-domain.applyCommand 的命令处理；本文件是 DXOS 开发者插件模板可引用的 builtin.*
 *   节点定义（命名空间、端口类型、执行器、Agent 动作），只服务于清单校验。
 *   两者命名空间与用途都不同，因此新建独立模块而不是复用 NODE_TYPES。
 *
 * 未移植（逐条登记，不猜测）：
 *   · registerBuiltinCanvasNodes（源 :148-151）依赖 CanvasNodeRegistry，属于编辑器运行期；
 *   · builtinNodeTypeForCard（源 :153-174）依赖 CanvasCard，属于编辑器运行期；
 *   两者都不在清单校验路径上，本批不引入。
 */
"use strict";

/** 源 builtinCanvasNodes.ts:6 文本输入端口（生成类 / LLM 共用）。 */
const textInput = { id: 'prompt', title: '文本', type: 'text', required: false, multiple: true }
/** 源 builtinCanvasNodes.ts:7-11 媒体输入端口。 */
const mediaInputs = [
  { id: 'images', title: '图片', type: 'media.image[]', multiple: true },
  { id: 'videos', title: '视频', type: 'media.video[]', multiple: true },
  { id: 'audios', title: '音频', type: 'media.audio[]', multiple: true },
]
/** 源 builtinCanvasNodes.ts:12 生成类节点输入端口集合。 */
const generationInputs = [textInput, ...mediaInputs, { id: 'table', title: '表格', type: 'table' }, { id: 'artifacts', title: '通用输入', type: 'artifact', multiple: true }]

/**
 * 源 nodes/director3d/definition.ts:6-18；源 builtinCanvasNodes.ts:4 只 import 一次后并入
 * BUILTIN_CANVAS_NODES，不再对外单独导出。单独导出会形成第二条登记路径，让 builtin.director-3d
 * 可被枚举两次，故这里只保留这一份定义作为数组元素。
 */
const DIRECTOR_3D_NODE_DEFINITION = {
  type: 'builtin.director-3d',
  version: 1,
  stateVersion: 1,
  title: '3D 导演台',
  description: '搭建三维场景、角色站位、机位与运动关键帧。',
  category: 'creative',
  defaultSize: { width: 350, height: 350 },
  inputs: [],
  outputs: [{ id: 'frame', title: '导演画面', type: 'media.image' }],
  executor: { type: 'builtin', id: 'canvas.director3d' },
  agent: { aliases: ['3D 导演台', '导演台', '三维导演台'], discoverable: false, actions: [] },
}

/** 源 builtinCanvasNodes.ts:14-146（顺序与源一致）。 */
const BUILTIN_CANVAS_NODES = [
  DIRECTOR_3D_NODE_DEFINITION,
  {
    type: 'builtin.image-asset', version: 1, stateVersion: 1, title: '图片', category: 'asset',
    defaultSize: { width: 500, height: 500 }, inputs: [],
    outputs: [{ id: 'image', title: '图片', type: 'media.image' }],
    executor: { type: 'builtin', id: 'canvas.asset.image' },
  },
  {
    type: 'builtin.video-asset', version: 1, stateVersion: 1, title: '视频', category: 'asset',
    defaultSize: { width: 600, height: 338 }, inputs: [],
    outputs: [{ id: 'video', title: '视频', type: 'media.video' }],
    executor: { type: 'builtin', id: 'canvas.asset.video' },
  },
  {
    type: 'builtin.audio-asset', version: 1, stateVersion: 1, title: '音频', category: 'asset',
    defaultSize: { width: 500, height: 180 }, inputs: [],
    outputs: [{ id: 'audio', title: '音频', type: 'media.audio' }],
    executor: { type: 'builtin', id: 'canvas.asset.audio' },
  },
  {
    type: 'builtin.file-asset', version: 1, stateVersion: 1, title: '文件', category: 'asset',
    defaultSize: { width: 360, height: 180 }, inputs: [],
    outputs: [{ id: 'file', title: '文件', type: 'file' }],
    executor: { type: 'builtin', id: 'canvas.asset.file' },
  },
  {
    type: 'builtin.image-generator', version: 1, stateVersion: 1, title: '图片生成', category: 'generation',
    capabilityVersion: 2, semanticRoles: ['generator'],
    defaultSize: { width: 300, height: 380 }, inputs: generationInputs,
    outputs: [{ id: 'images', title: '图片结果', type: 'media.image[]', multiple: true }],
    executor: { type: 'builtin', id: 'canvas.generate.image' },
    agent: { aliases: ['图片生成器', '文生图', '图生图'], actions: [{ id: 'run', title: '运行图片生成', kind: 'run', promptParameter: 'params.prompt', acceptsCanvasInputs: true }] },
  },
  {
    type: 'builtin.midjourney-generator', version: 1, stateVersion: 1, title: 'Midjourney', category: 'generation',
    defaultSize: { width: 360, height: 420 }, inputs: [textInput, { id: 'images', title: '参考图片 / 遮罩', type: 'media.image[]', multiple: true }],
    outputs: [{ id: 'images', title: 'Midjourney 图片', type: 'media.image[]', multiple: true }],
    executor: { type: 'builtin', id: 'canvas.generate.midjourney' },
    agent: { aliases: ['Midjourney', 'MJ'], actions: [{ id: 'run', title: '运行 Midjourney', kind: 'run', promptParameter: 'params.prompt', acceptsCanvasInputs: true }] },
  },
  {
    type: 'builtin.video-generator', version: 1, stateVersion: 1, title: '视频生成', category: 'generation',
    capabilityVersion: 2, semanticRoles: ['generator'],
    defaultSize: { width: 360, height: 380 }, inputs: generationInputs,
    outputs: [{ id: 'videos', title: '视频结果', type: 'media.video[]', multiple: true }],
    executor: { type: 'builtin', id: 'canvas.generate.video' },
    agent: { aliases: ['视频生成器', '文生视频', '图生视频'], actions: [{ id: 'run', title: '运行视频生成', kind: 'run', promptParameter: 'params.prompt', acceptsCanvasInputs: true }] },
  },
  {
    type: 'builtin.audio-generator', version: 1, stateVersion: 1, title: '音频生成', category: 'generation',
    defaultSize: { width: 360, height: 380 }, inputs: generationInputs,
    outputs: [{ id: 'audios', title: '音频结果', type: 'media.audio[]', multiple: true }],
    executor: { type: 'builtin', id: 'canvas.generate.audio' },
    agent: { aliases: ['音频生成器', '语音生成', '音乐生成'], actions: [{ id: 'run', title: '运行音频生成', kind: 'run', promptParameter: 'params.prompt', acceptsCanvasInputs: true }] },
  },
  {
    type: 'builtin.llm', version: 1, stateVersion: 1, title: 'LLM', category: 'ai',
    defaultSize: { width: 360, height: 310 }, inputs: generationInputs,
    outputs: [{ id: 'text', title: '文本', type: 'text' }, { id: 'table', title: '表格', type: 'table' }],
    executor: { type: 'builtin', id: 'canvas.llm' },
    agent: { aliases: ['LLM', '语言模型'], actions: [{ id: 'run', title: '运行 LLM', kind: 'run', promptParameter: 'params.prompt', acceptsCanvasInputs: true }] },
  },
  {
    type: 'builtin.table', version: 1, stateVersion: 1, title: '多维表格', category: 'data',
    capabilityVersion: 2, semanticRoles: ['data'],
    defaultSize: { width: 520, height: 320 },
    inputs: [{ id: 'rows', title: '输入', type: 'artifact', multiple: true }],
    outputs: [{ id: 'table', title: '表格', type: 'table' }, { id: 'rows', title: '行', type: 'json', multiple: true }],
    executor: { type: 'builtin', id: 'canvas.table' },
    agent: { aliases: ['多维表格', '表格'], actions: [{ id: 'read', title: '读取表格声明', kind: 'read' }] },
    operations: [
      { id: 'read_table', title: '读取表格数据', kind: 'query', reads: ['params.protocolParams.table'], sideEffect: 'none', risk: 'low', idempotency: 'idempotent', confirmation: 'on-ambiguity', executorBinding: 'canvas.table.read_table' },
      { id: 'set_cell', title: '修改单元格', kind: 'mutation', inputSchema: { type: 'object', properties: { row: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 }, columnName: { type: 'string' }, value: { type: 'string', maxLength: 20000 } }, required: ['row', 'value'] }, reads: ['params.protocolParams.table'], writes: ['params.protocolParams.table'], sideEffect: 'local', risk: 'low', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.table.set_cell' },
      { id: 'append_row', title: '追加表格行', kind: 'mutation', inputSchema: { type: 'object', properties: { values: { type: 'array' } }, required: ['values'] }, reads: ['params.protocolParams.table'], writes: ['params.protocolParams.table'], sideEffect: 'local', risk: 'low', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.table.append_row' },
      { id: 'delete_row', title: '删除表格行', kind: 'mutation', inputSchema: { type: 'object', properties: { row: { type: 'integer', minimum: 1 } }, required: ['row'] }, reads: ['params.protocolParams.table'], writes: ['params.protocolParams.table'], sideEffect: 'local', risk: 'medium', idempotency: 'keyed', confirmation: 'on-risk', executorBinding: 'canvas.table.delete_row' },
      { id: 'add_column', title: '添加表格列', kind: 'mutation', inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 120 } } }, reads: ['params.protocolParams.table'], writes: ['params.protocolParams.table'], sideEffect: 'local', risk: 'low', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.table.add_column' },
      { id: 'delete_column', title: '删除表格列', kind: 'mutation', inputSchema: { type: 'object', properties: { column: { type: 'integer', minimum: 1 }, columnName: { type: 'string' } } }, reads: ['params.protocolParams.table'], writes: ['params.protocolParams.table'], sideEffect: 'local', risk: 'medium', idempotency: 'keyed', confirmation: 'on-risk', executorBinding: 'canvas.table.delete_column' },
    ],
  },
  {
    type: 'builtin.image-compare', version: 1, stateVersion: 1, title: '图像对比', category: 'image',
    defaultSize: { width: 520, height: 340 },
    inputs: [{ id: 'images', title: '图片输入', type: 'media.image[]', multiple: true }],
    outputs: [],
    executor: { type: 'builtin', id: 'canvas.image.compare' },
  },
  {
    // 源 builtinCanvasNodes.ts:101-107（0.6.1 新增；无 capabilityVersion / semanticRoles / agent，逐字保留）。
    type: 'builtin.mosaic', version: 1, stateVersion: 1, title: '图片拼接', category: 'image',
    defaultSize: { width: 380, height: 300 },
    inputs: [{ id: 'images', title: '图片', type: 'media.image[]', multiple: true }, { id: 'texts', title: '逐图文字', type: 'text', multiple: true }],
    outputs: [{ id: 'image', title: '拼接图片', type: 'media.image' }],
    executor: { type: 'builtin', id: 'canvas.image.mosaic' },
  },
  {
    type: 'builtin.group', version: 1, stateVersion: 1, title: '分组', category: 'layout',
    defaultSize: { width: 560, height: 380 }, inputs: [], outputs: [],
    executor: { type: 'builtin', id: 'canvas.group' },
  },
  {
    type: 'builtin.prompt', version: 1, stateVersion: 1, title: '提示词', category: 'text',
    capabilityVersion: 2, semanticRoles: ['source'],
    defaultSize: { width: 300, height: 180 }, inputs: [{ id: 'text', title: '文本输入', type: 'text' }],
    outputs: [{ id: 'text', title: '文本', type: 'text' }],
    operations: [
      { id: 'read_text', title: '读取提示词', kind: 'query', reads: ['params.prompt'], sideEffect: 'none', risk: 'low', idempotency: 'idempotent', confirmation: 'on-ambiguity', executorBinding: 'canvas.text.read_text' },
      { id: 'append_text', title: '追加提示词', kind: 'mutation', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 20000 }, separator: { type: 'string', enum: ['newline', 'space', 'none'] } }, required: ['text'] }, reads: ['params.prompt'], writes: ['params.prompt'], sideEffect: 'local', risk: 'low', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.text.append_text' },
      { id: 'replace_text', title: '替换提示词', kind: 'mutation', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['text'] }, reads: ['params.prompt'], writes: ['params.prompt'], sideEffect: 'local', risk: 'low', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.text.replace_text' },
      { id: 'clear_text', title: '清空提示词', kind: 'mutation', reads: ['params.prompt'], writes: ['params.prompt'], sideEffect: 'local', risk: 'medium', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.text.clear_text' },
    ],
    executor: { type: 'builtin', id: 'canvas.prompt' },
  },
  {
    type: 'builtin.sticky', version: 1, stateVersion: 1, title: '便签', category: 'text',
    capabilityVersion: 2, semanticRoles: ['source'],
    defaultSize: { width: 240, height: 220 }, inputs: [],
    outputs: [{ id: 'text', title: '文本', type: 'text' }],
    operations: [
      { id: 'read_text', title: '读取便签', kind: 'query', reads: ['params.prompt'], sideEffect: 'none', risk: 'low', idempotency: 'idempotent', confirmation: 'on-ambiguity', executorBinding: 'canvas.text.read_text' },
      { id: 'append_text', title: '追加便签文字', kind: 'mutation', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 20000 }, separator: { type: 'string', enum: ['newline', 'space', 'none'] } }, required: ['text'] }, reads: ['params.prompt'], writes: ['params.prompt'], sideEffect: 'local', risk: 'low', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.text.append_text' },
      { id: 'replace_text', title: '替换便签文字', kind: 'mutation', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['text'] }, reads: ['params.prompt'], writes: ['params.prompt'], sideEffect: 'local', risk: 'low', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.text.replace_text' },
      { id: 'clear_text', title: '清空便签', kind: 'mutation', reads: ['params.prompt'], writes: ['params.prompt'], sideEffect: 'local', risk: 'medium', idempotency: 'keyed', confirmation: 'on-ambiguity', executorBinding: 'canvas.text.clear_text' },
    ],
    executor: { type: 'builtin', id: 'canvas.sticky' },
  },
  {
    type: 'builtin.junction', version: 1, stateVersion: 1, title: '转接点', category: 'flow',
    defaultSize: { width: 68, height: 42 },
    inputs: [{ id: 'in', title: '输入', type: 'artifact', multiple: true }],
    outputs: [{ id: 'out', title: '输出', type: 'artifact', multiple: true }],
    executor: { type: 'builtin', id: 'canvas.junction' },
  },
]

// 只导出数组：director-3d 已是数组内唯一一份，单独导出会让它出现在第二条登记路径上。
module.exports = { BUILTIN_CANVAS_NODES };
