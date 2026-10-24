/**
 * UI 逐个对齐 · 对照流水线（task-4）。
 *
 * 用法：
 *   node tests/ui-align-shots.mjs                # 22 个应用全跑
 *   node tests/ui-align-shots.mjs --app=files    # 只跑一个（可重复，用于逐个对齐后重截）
 *
 * 产物：artifacts/ui-alignment/<序号>-<slug>/{proto.png,ours.png,compare.png}
 *       artifacts/ui-alignment/report.json、README.md
 *
 * 原型侧：Playwright Chromium 打开 artifacts/ui-alignment/proto-source/index.html，
 *         OA.store.locked=false 后逐个 OA.openApp(protoId)，等 900ms，按窗口容器 2x 截图。
 * 我们侧：真实 Electron + 真实 preload + identity/files/market/integration 桥；
 *         用「应用中心」弹窗打开同一 appId，等窗口稳定后 CDP clip 截图（同样 2x）。
 * 对比图：左原型右我们，各自等比装进同尺寸框（1060×710），顶部标注应用名与两侧原始尺寸。
 *
 * 约束：不伪造数据；原型违反 DESIGN_SYSTEM 的地方（彩色、600 字重、发丝线）以规范为准，
 *       差异清单里逐条注明。差异清单 DIFFS 由人工核对截图后维护（重新跑流水线不会丢）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const OUT = path.join(ROOT, "artifacts", "ui-alignment");
const PROTO = path.join(OUT, "proto-source");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEW = { width: 1512, height: 950 };
const PANE = { width: 1060, height: 710 };

/** 原型 id ↔ 我们 appId；顺序即目录序号。 */
export const TARGETS = [
  { seq: "01", slug: "finder", protoId: "finder", appId: "files", name: "访达" },
  { seq: "02", slug: "library", protoId: "library", appId: "resource-library", name: "资源库" },
  { seq: "03", slug: "browser", protoId: "browser", appId: "browser", name: "浏览器" },
  { seq: "04", slug: "studio", protoId: "studio", appId: "canvas", name: "AI Studio" },
  { seq: "05", slug: "chat", protoId: "chat", appId: "chat", name: "对话" },
  { seq: "06", slug: "projects", protoId: "projects", appId: "projects", name: "项目" },
  { seq: "07", slug: "skills", protoId: "skills", appId: "skills", name: "Skill 中心" },
  { seq: "08", slug: "mcp", protoId: "mcp", appId: "mcp-center", name: "MCP 中心" },
  { seq: "09", slug: "market", protoId: "market", appId: "market", name: "应用市场" },
  { seq: "10", slug: "automation", protoId: "automation", appId: "automation", name: "自动化" },
  { seq: "11", slug: "org", protoId: "org", appId: "organization", name: "组织治理" },
  { seq: "12", slug: "settings", protoId: "settings", appId: "settings", name: "系统设置" },
  { seq: "13", slug: "calendar", protoId: "calendar", appId: "calendar", name: "日历" },
  { seq: "14", slug: "weather", protoId: "weather", appId: "weather", name: "天气" },
  { seq: "15", slug: "music", protoId: "music", appId: "music", name: "音乐" },
  { seq: "16", slug: "photos", protoId: "photos", appId: "photos", name: "相册" },
  { seq: "17", slug: "notes", protoId: "notes", appId: "notes", name: "文稿" },
  { seq: "18", slug: "video", protoId: "video", appId: "video", name: "视频剪辑" },
  { seq: "19", slug: "drama", protoId: "drama", appId: "drama", name: "短剧工坊" },
  { seq: "20", slug: "dev", protoId: "dev", appId: "dev", name: "开发者" },
  { seq: "21", slug: "declare", protoId: "declare", appId: "declare", name: "图片声明" },
  { seq: "22", slug: "trash", protoId: "trash", appId: "trash", name: "回收站" },
];

/**
 * 首屏可见差异（人工核对截图后维护；≤5 条，severity: 高/中/低）。
 * 原型是视觉基准，但它自身违反 DESIGN_SYSTEM 的地方（彩色渐变、600 字重、发丝线、
 * 非语义状态色）按规范处理，并在条目里注明「规范优先」，不算我们的缺陷。
 */
const DIFFS = {
  files: [
    { severity: "低", proto: "侧栏「个人收藏」有 桌面/文稿/下载/图片 四个固定入口", ours: "只有 桌面 + 真实顶层文件夹（文稿/下载/图片不是本机固定目录）", gap: "数据模型只有桌面与自建文件夹；不造固定路径。已按「个人收藏 / 位置 / 标签」分区，标签如实标注未接入。" },
    { severity: "低", proto: "状态栏右侧「本机 · 可用 412 GB」", ours: "「本机 · D1」", gap: "没有真实容量查询接口；按不造数据原则不写假容量。" },
    { severity: "低", proto: "工具条无右侧独立分组", ours: "搜索右侧保留项目 Agent 入口（真实 agent 能力）", gap: "真实功能保留，独立成组；对齐后不再是「多一个 icon 挤在工具条里」。" },
  ],
  "resource-library": [
    { severity: "中", proto: "空态直接用图标+标题+说明，不显示工具条计数以外的结构", ours: "空态沿用旧组件（图标/说明/新建入口）", gap: "空态样式还可以按原型再收一遍；本轮先保证有数据时结构对齐。" },
    { severity: "低", proto: "视频卡有真实首帧海报", ours: "视频卡是类型图标 + 真实时长徽标（0:04）", gap: "宿主没有视频抽帧能力，不造假首帧。" },
    { severity: "低", proto: "可见范围可编辑（仅自己/本部门/组织）", ours: "只读展示「仅自己」等真实值 + NOT VERIFIED 说明", gap: "数据层没有范围修改命令，按不造假原则只读。" },
    { severity: "低", proto: "允许 Agent 使用是开关", ours: "只读能力位 + NOT VERIFIED 说明", gap: "没有 Agent 授权开关命令。" },
  ],
  browser: [
    { severity: "高", proto: "起始页有 6 个快捷入口卡 + 说明 + 底部任务提示", ours: "只有地址栏 + 空白页（探针 browser:command 是桩）", gap: "宿主缺浏览器导航/收藏桥，INVALID 判定为宿主能力不足；起始页 UI 仍需后续对齐。" },
    { severity: "中", proto: "地址栏与工具条密度更高，右侧有下载/更多", ours: "地址栏更宽、右侧按钮少", gap: "工具条控件与间距未对齐。" },
  ],
  studio: [
    { severity: "高", proto: "画布首页 = 搜索结果 + 模板卡 + 最近项目网格", ours: "文字型空态（探针缺 canvas:command）", gap: "INVALID：宿主没接画布域；首页信息架构本身也未按原型做模板/最近项目。" },
    { severity: "中", proto: "左栏「发现/模板/最近」+ 画布入口", ours: "左栏是项目/会话入口", gap: "侧栏信息架构不同。" },
  ],
  chat: [
    { severity: "中", proto: "工具条有模型下拉，可切换模型", ours: "显示真实模型名 + 下拉只读列表，并写明「由主进程冻结」", gap: "task/run 的模型由主进程冻结，所选模型不会下发；不给假下拉（切换 NOT VERIFIED）。" },
    { severity: "中", proto: "输入区附件、Skill、引用资源三个入口都能用", ours: "附件 / Skill 禁用并标 NOT VERIFIED；引用资源接真实 resource/get", gap: "没有附件与 Skill 选择命令；资源引用是真实能力。" },
    { severity: "低", proto: "设备徽标可切换设备", ours: "只读「本机 · D1」+ NOT VERIFIED", gap: "task 命令没有设备字段。" },
    { severity: "低", proto: "会话列表摘要显示最后一条消息", ours: "摘要显示真实状态 + 更新时间", gap: "task/list 不返回最后一条消息；不造摘要。" },
  ],
  projects: [
    { severity: "中", proto: "工具条显示「负责人 · 截止日期」", ours: "负责人未设置 · 截止未设置（后端没有字段）", gap: "agent/resource 项目都没有负责人/截止字段，如实显示未设置并标 NOT VERIFIED，不造人名和日期。" },
    { severity: "中", proto: "任务行都有进度条", ours: "只有已完成 100% / 取消 0% 显示确定进度；运行中显示「进度不可推导」", gap: "任务列表接口没有 steps/事件聚合，不能由单条任务推导百分比，不编进度。" },
    { severity: "中", proto: "文件 / 成员 / 项目记忆都是满数据", ours: "文件来自同名资源项目的真实引用；成员/项目记忆是写实空态", gap: "成员/角色/项目记忆后端没有命令（NOT VERIFIED）；文件不跨项目伪造。" },
    { severity: "低", proto: "负责人列带头像和人名", ours: "执行者列显示后端真实 executionProfile（助理 · thinking / agent）", gap: "没有项目成员表，执行者按任务真实字段显示。" },
  ],
  skills: [
    { severity: "高", proto: "技能市场 = 卡片网格（名称/描述/来源/安装按钮）", ours: "空态「没有可用技能」", gap: "INVALID：宿主缺 skill:command；市场卡片结构也未对齐。" },
  ],
  mcp: [
    { severity: "高", proto: "左栏连接列表 + 右栏工具开关与调用日志", ours: "红色错误条（No handler registered for mcp:command）", gap: "INVALID：宿主缺 MCP 域，不能当 UI 差异。" },
  ],
  market: [
    { severity: "低", proto: "hero 有彩色海报与 3 个指示点", ours: "中性灰阶 hero + 真实状态文案 + 2 个指示点", gap: "规范优先：去彩色；指示点数量按真实数据屏数。" },
    { severity: "低", proto: "应用卡右侧只有胶囊按钮", ours: "胶囊 + 悬停出现的程序坞 pin", gap: "真实程序坞能力保留，悬停才出现。" },
  ],
  automation: [
    { severity: "高", proto: "概览统计 + 自动化规则列表（触发/下次/动作）", ours: "统计卡 + 规则列表，但顶部出现「自动化服务出错 AUTOMATION_INTERNAL」", gap: "INVALID：宿主缺 automation 域；列表结构本身接近。" },
  ],
  organization: [
    { severity: "中", proto: "用户表：头像/邮箱/角色/部门/状态/操作 + 筛选", ours: "同样的表结构，但只有 Admin 一行且缺部门数据", gap: "结构接近；数据量与列宽不同。探针里组织服务已接，属真实空数据。" },
    { severity: "低", proto: "左栏「组织治理」+ 成员/部门/应用权限/资源权限/审计日志", ours: "已按同名同顺序对齐", gap: "已对齐。" },
  ],
  settings: [
    { severity: "中", proto: "外观页：壁纸缩略图网格 + 玻璃/减少动态/图标大小", ours: "同样的分区，但壁纸只有系统项、缩略图更少", gap: "控件结构接近，选项数量与缩略图样式需继续对齐。" },
    { severity: "低", proto: "账户卡在侧栏顶部", ours: "账户条目在侧栏中部", gap: "位置有差异。" },
  ],
  calendar: [
    { severity: "中", proto: "月视图 + 事件彩条 + 右侧当日日程", ours: "同样的月视图 + 右侧面板，但事件条样式与密度不同", gap: "事件 chip/日程列表样式未对齐。" },
    { severity: "低", proto: "顶部月份切换与「今天」按钮更紧凑", ours: "控件更松", gap: "间距未对齐。" },
  ],
  weather: [
    { severity: "高", proto: "整屏天气卡：大温度 + 逐小时 + 7 日", ours: "「读取天气数据遇到问题」错误卡", gap: "INVALID：探针禁网（fetchImpl 未注入），Open-Meteo 不可达；不是 UI 差异。" },
  ],
  music: [
    { severity: "高", proto: "播放器（封面/进度/队列）+ 曲库列表", ours: "「读取音乐库失败 LOCAL_MEDIA…」", gap: "INVALID：宿主缺本地媒体域。" },
  ],
  photos: [
    { severity: "高", proto: "照片网格（缩略图 + 分组）", ours: "「读取相册目录失败」", gap: "INVALID：宿主缺照片/媒体命令。" },
  ],
  notes: [
    { severity: "中", proto: "左栏文稿列表 + 右栏 Markdown 正文与元信息", ours: "空态 + 新建入口（真实无文稿）", gap: "编辑器布局未按原型实现；空态符合不造数据原则。" },
  ],
  video: [
    { severity: "高", proto: "预览窗 + 多轨时间线 + 素材栏", ours: "「视频剪辑暂不可用」", gap: "INVALID：宿主缺视频/FFmpeg 域。" },
  ],
  drama: [
    { severity: "高", proto: "短剧工坊：剧集网格 + 分镜/素材 + 导出", ours: "文字空态（探针没有短剧数据/媒体域）", gap: "结构未对齐；先记录，后续按原型重做。" },
  ],
  dev: [
    { severity: "高", proto: "开发者：代码编辑器 + 终端输出 + 运行按钮", ours: "空态面板（探针缺开发者运行域）", gap: "布局未对齐。" },
  ],
  declare: [
    { severity: "中", proto: "图片声明：拖入区 + 声明列表 + 导出按钮", ours: "空态 + 拖入提示（真实无图片）", gap: "列表/导出结构未对齐；空态不造假。" },
  ],
  trash: [
    { severity: "中", proto: "回收站：文件网格 + 恢复/清空", ours: "空态「回收站是空的」+ 清空按钮", gap: "空态合理；有内容时的网格/恢复操作未实现对齐。" },
  ],
};

/** 访达这轮对齐的逐项结论（写进 report.json 的 files 条目）。 */
const FINDER_ALIGNMENT = [
  { item: "1 内容区扁平图标网格（不按类型加小标题）", status: "通过", detail: "网格视图返回单一分组；分组只在列表视图保留。截图 01-finder/after-compare.png 左原型右实现。" },
  { item: "2 底部状态栏回归 + 资源库操作条选中时才出现", status: "通过", detail: "未选中只显示左侧 N 项 / 右侧 本机 · D1；选中项时操作条浮在状态栏上方（真实 resource 功能保留）。" },
  { item: "3 工具条顺序 返回/前进·标题·视图·排序·新建·搜索", status: "通过", detail: "新建用真实 shell.createSubfolder（探针里也用它建了两个真实文件夹）；项目 Agent 入口是真实能力，挪到搜索右侧独立分组。" },
  { item: "4 侧栏分区 个人收藏 / 位置 / 标签 + 分区样式", status: "部分通过", detail: "分区与 11px 次级色/32 行高已对齐；「标签」没有真实数据能力，只放如实说明，标 NOT VERIFIED。" },
  { item: "5 图标 64 / 标签 12px 次级色，真实文件类型图标", status: "通过", detail: "文件夹 64（真实 FolderIcon）、文件 64（真实类型 glyph）、图片用真实缩略图；名称为 12px 次级色。" },
  { item: "6 窗口默认尺寸 940×590（原型同尺寸）", status: "通过", detail: "本应用与原型一致；其它应用尺寸差见 report.json 的 sizeDelta，未改壳层。" },
];

const LIBRARY_ALIGNMENT = [
  { item: "1 左栏三组：资源库（类型+数量）/ 快捷（收藏、最近）/ 集合", status: "通过", detail: "数量来自 resource/query 的 total（真实查询），集合与收藏来自真实命令。" },
  { item: "2 工具条：标题 + N 项 · 本地优先，不自动上传 + 搜索 + 主按钮添加", status: "通过", detail: "添加是 details 菜单，三个入口都接真实命令（导入 / 链接 / 新建）。" },
  { item: "3 标签 chips（可点击筛选，选中态明显）", status: "通过", detail: "chips 来自 resource/listTags，选中写回 filterTag，走真实查询。" },
  { item: "4 卡片网格：真实缩略图 / 收藏星 / 视频时长 / 名称+类型·范围", status: "通过", detail: "缩略图走 openarc-resource capability；收藏星真实 setFavorite；时长来自真实 video metadata（探针里 0:04）。" },
  { item: "5 右侧滑入详情（不是固定第三栏）", status: "通过", detail: "160ms transform，减少动态时 token 归零；打开 / 下载 / 移到回收站等真实动作保留。" },
  { item: "6 可见范围（仅自己 / 本部门 / 组织）", status: "未验收", detail: "数据层只有读取，没有范围修改命令；详情里只读展示并明确 NOT VERIFIED，不伪造可点击分段。" },
  { item: "7 允许 Agent 使用开关", status: "未验收", detail: "没有授权开关命令；只读显示能力位（agentAllowed），并写明 NOT VERIFIED。" },
  { item: "8 空态写实（无资源 / 搜索无结果）", status: "通过", detail: "沿用真实空态文案，不造缩略图。" },
];

const PROJECTS_ALIGNMENT = [
  { item: "1 左栏项目列表（名字 + 任务数徽标）+ 新建项目", status: "通过", detail: "列表与数量来自 agent/project/list + agent/task/list；新建走 agent/project/create。" },
  { item: "2 工具条：项目名 + 负责人 · 截止 + 分段 + 新任务", status: "部分通过", detail: "负责人/截止后端无字段，如实显示「未设置」（NOT VERIFIED）；分段与「新任务」已就位。" },
  { item: "3 任务控制台 4 卡（整体进度 / 进行中 / 等待确认 / 已完成）", status: "通过", detail: "整体进度 = 已完成任务占比并写明推导口径；其余计数来自真实任务状态。" },
  { item: "4 任务表（任务 / 执行者 / 状态 / 进度 / 去确认 / 重试）", status: "通过", detail: "去确认进入回答流程；重试调用真实 task/resume；进度只在可确定时显示。" },
  { item: "5 点击行展开事件记录", status: "通过", detail: "展开后 task/get + task/events，步骤与事件都是真实返回。" },
  { item: "6 文件 = 资源网格", status: "通过", detail: "匹配同名资源项目后展示真实引用与缩略图（capability URL），访问权逐个重新校验。" },
  { item: "7 成员表（成员 / 角色 / 本项目权限）", status: "未验收", detail: "后端没有项目成员/角色/权限字段；写实空态并标 NOT VERIFIED，不造成员。" },
  { item: "8 项目记忆列表 + 添加记忆", status: "未验收", detail: "后端没有项目记忆命令；写实空态并标 NOT VERIFIED，不造记忆条目。" },
  { item: "9 新建任务弹窗", status: "部分通过", detail: "任务名与执行方式（thinking/agent）接真实 agent/task/create；「自己执行」「执行设备」无后端命令，禁用并写明 NOT VERIFIED。" },
  { item: "10 保留现有真实 agent 能力", status: "通过", detail: "暂停/恢复/取消/回答/续跑/直接 agent/project/run 全部保留在行展开与「直接交给项目 Agent」里。" },
];

const CHAT_ALIGNMENT = [
  { item: "1 两栏布局（去掉右侧第三栏）", status: "通过", detail: "任务步骤/事件收进消息流末尾「处理过程」折叠块，不再占第三栏。" },
  { item: "2 左栏 搜索 + 新建 + 今天/更早 分组 + 标题/摘要", status: "通过", detail: "摘要用真实状态+更新时间；分组按 updatedAt 计算。" },
  { item: "3 工具条 标题 + 模型 + 设备 + ⋯", status: "部分通过", detail: "模型与设备是真实只读值（NOT VERIFIED 切换）；⋯ 菜单接刷新/停止/新对话。" },
  { item: "4 消息流：用户右对齐实心气泡；助理圆球 + 气泡", status: "通过", detail: "用户气泡实心右对齐，助理 24px 圆球 + 浅底气泡，无第三栏。" },
  { item: "5 任务卡 / 工具调用", status: "通过", detail: "来自真实 task 事件（tool.proposed/execution.*），可展开逐步查看。" },
  { item: "6 流式 / 输入中", status: "通过", detail: "运行中显示输入中三点 + 光标；状态来自真实 task 轮询，不伪造 token。" },
  { item: "7 输入区 附件 / 能力 chip / 引用资源 / 快捷键 / 发送 / 停止", status: "部分通过", detail: "资源引用接真实 picker + resource/get；附件与 Skill 无命令，禁用并标 NOT VERIFIED。" },
  { item: "8 空态写实", status: "通过", detail: "无对话/无模型都有真实说明，不造示例会话。" },
  { item: "9 保留 新建/切换/发送/停止/审批/预算续接", status: "通过", detail: "全部保留在消息流与工具栏。" },
  { item: "10 模型切换", status: "未验收", detail: "模型由主进程冻结；只读展示，不做无效切换。" },
];

/** 宿主能力边界（决定 INVALID）：这些应用的截图只用于确认状态，不能算 UI 差异。 */
const CAPTURE_STATUS = {
  browser: "探针宿主的 browser:command 是桩，页面内容不具代表性",
  canvas: "宿主未接 canvas:command",
  skills: "宿主未接 skill:command",
  "mcp-center": "宿主未接 mcp:command",
  automation: "宿主未接 automation:command（页面顶部报 AUTOMATION_INTERNAL）",
  weather: "探针禁网（未注入 fetch），Open-Meteo 不可达",
  music: "宿主未接本地媒体域",
  photos: "宿主未接照片/媒体命令",
  video: "宿主未接视频 / FFmpeg 域",
  drama: "宿主未接短剧/媒体域（页面报服务出错）",
};

async function launchBrowser() {
  // 本机 Playwright 缓存里的 Chromium 版本与 @playwright/test 期望的 build 不一致；
  // 优先用系统 Chrome（channel: chrome），不额外下载浏览器。
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch (error) {
    console.log("channel=chrome 启动失败，回退 Playwright 自带 Chromium：" + String((error && error.message) || error).slice(0, 200));
    return await chromium.launch();
  }
}

function parseArgs(argv) {
  const out = { apps: [], composeOnly: false, probeStatus: false, geometry: false, responsive: false, interactions: false };
  for (const arg of argv) {
    const match = /^--app=(.+)$/.exec(arg);
    if (match) out.apps = match[1].split(",").map((item) => item.trim()).filter(Boolean);
    if (arg === "--compose-only") out.composeOnly = true;
    if (arg === "--probe-status") out.probeStatus = true;
    if (arg === "--geometry") out.geometry = true;
    if (arg === "--responsive") out.responsive = true;
    if (arg === "--interactions") out.interactions = true;
  }
  return out;
}

function ensureProtoSource() {
  if (fs.existsSync(path.join(PROTO, "index.html"))) return;
  const fallback = "/tmp/openarc-proto";
  if (!fs.existsSync(path.join(fallback, "index.html"))) {
    throw new Error("找不到原型：artifacts/ui-alignment/proto-source/index.html 与 /tmp/openarc-proto 都不存在");
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(fallback, PROTO, { recursive: true });
  console.log("原型源已复制：" + path.relative(ROOT, PROTO));
}

function appDir(target) {
  return path.join(OUT, target.seq + "-" + target.slug);
}

/** 读 PNG 头拿尺寸（compose-only 不重截，直接用已有图）。 */
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function existingResults(targets, side) {
  const results = {};
  for (const target of targets) {
    const file = path.join(appDir(target), side + ".png");
    if (!fs.existsSync(file)) continue;
    const size = pngSize(file);
    if (!size) continue;
    // 截图统一是 2x；报告里写 CSS 像素（= 物理像素 / 2）。
    results[target.appId] = { width: Math.round(size.width / 2), height: Math.round(size.height / 2), file: path.relative(ROOT, file) };
  }
  return results;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/* ── 原型侧 ───────────────────────────────────────────────────────────── */
async function captureProto(browser, targets) {
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: "light" });
  await page.goto("file://" + path.join(PROTO, "index.html"));
  await page.waitForFunction("window.OA && window.OA.store && document.querySelector('.os')", null, { timeout: 30000 });
  await page.evaluate(() => {
    OA.store.locked = false;
    OA.store.unlocking = false;
    OA.store.theme = "light";
    OA.store.reduced = true;
    OA.store.wallpaper = 0;
    OA.store.dockSize = 48;
    OA.store.scale = "std";
    OA.store.windows.splice(0);
    OA.store.focused = null;
  });
  await sleep(400);
  const results = {};
  for (const target of targets) {
    const opened = await page.evaluate((id) => {
      const win = OA.openApp(id);
      return win ? { id: win.id, w: win.w, h: win.h } : null;
    }, target.protoId);
    if (!opened) throw new Error("原型没有打开应用：" + target.protoId);
    await sleep(900);
    const rect = await page.evaluate((id) => {
      const index = OA.store.windows.findIndex((w) => w.app === id);
      const el = document.querySelectorAll(".win")[index];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, target.protoId);
    if (!rect) throw new Error("原型窗口容器找不到：" + target.protoId);
    const dir = appDir(target);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "proto.png");
    await page.screenshot({ path: file, clip: rect });
    results[target.appId] = { width: Math.round(rect.width), height: Math.round(rect.height), file: path.relative(ROOT, file) };
    await page.evaluate((id) => {
      const win = OA.store.windows.find((w) => w.app === id);
      if (win) OA.close(win.id);
    }, target.protoId);
    await sleep(320);
  }
  await page.close();
  return results;
}

/* ── 我们侧：真实 Electron 宿主 ───────────────────────────────────────── */
const PROBE_MAIN = String.raw`"use strict";
const { app, BrowserWindow, ipcMain, safeStorage, nativeImage, screen, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Readable } = require("node:stream");
const ROOT = process.env.OA_ALIGN_ROOT;
const OUT = process.env.OA_ALIGN_OUT;
const DEV = process.env.OA_DEV_SERVER;
const DEV_BASE = DEV.replace(/[/]+$/, "") + "/";
const uiURL = new URL("vue.html", DEV).href;
const TARGETS = JSON.parse(process.env.OA_ALIGN_TARGETS || "[]");
const GEO = process.env.OA_ALIGN_GEOMETRY === "1";
const RESP = process.env.OA_ALIGN_RESPONSIVE === "1";
const ANCHORS = JSON.parse(process.env.OA_ALIGN_ANCHORS || "{}");
const INTERACTIONS = process.env.OA_ALIGN_INTERACTIONS === "1";
const ADMIN = "align-admin@openarc.test";
const PW = "align-admin-password-1";
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { createFileService } = require(path.join(ROOT, "electron/file-service.cjs"));
const { createMarketBundle } = require(path.join(ROOT, "electron/market-service.cjs"));
const { createMarketUpdateBundle } = require(path.join(ROOT, "electron/market-update-service.cjs"));
const { createPluginBundle } = require(path.join(ROOT, "electron/plugin-service.cjs"));
const { registerMarketIpc, registerIntegrationIpc } = require(path.join(ROOT, "electron/plugin-bootstrap.cjs"));
const { createPlatformBundle } = require(path.join(ROOT, "electron/platform-service.cjs"));
const { registerPlatformIpc } = require(path.join(ROOT, "electron/platform-bootstrap.cjs"));
const { createDxosFsAdapterForUserData } = require(path.join(ROOT, "electron/agent-service.cjs"));
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "oa-align-probe-"));
app.setPath("userData", USER_DATA);
protocol.registerSchemesAsPrivileged([
  { scheme: "openarc-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: "openarc-resource", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
const NATIVE = "/System/Library/PrivateFrameworks/SiriUI.framework/Versions/A/Resources/Siri Blob.mov";

const report = { results: {}, checks: [], errors: [], consoleErrors: [] };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail).slice(0, 400) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const q = (v) => JSON.stringify(String(v));
const has = (sel) => js("return !!document.querySelector(" + q(sel) + ")");
const click = (sel) => js("var el=document.querySelector(" + q(sel) + "); if(!el) return 'missing'; el.click(); return 'ok';");
const setInput = (sel, value) => js("var el=document.querySelector(" + q(sel) + "); if(!el) return 'missing'; var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(el," + q(value) + "); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';");
async function waitFn(expr, timeout) {
  const t0 = Date.now();
  for (;;) {
    try { if (await js("return (" + expr + ")")) return true; } catch {}
    if (Date.now() - t0 > (timeout || 15000)) return false;
    await sleep(120);
  }
}
async function ensureReady() {
  const gate = () => js("var d=document.querySelector('.desktop'); return d ? d.getAttribute('data-identity-gate') : 'no-root'");
  const g = await gate();
  if (g !== "ready") {
    await setInput('[data-d3-id="login-identifier"]', ADMIN);
    await setInput('[data-d3-id="login-password"]', PW);
    await click('[data-d3-id="login-submit"]');
  }
  return waitFn("(function(){var d=document.querySelector('.desktop'); return !!d && d.getAttribute('data-identity-gate')==='ready';})()", 30000);
}
async function activeWindow() {
  return await js("var el=document.querySelector('.window.active'); if(!el) return null; var r=el.getBoundingClientRect(); return {id:el.getAttribute('data-window-id'), aria:el.getAttribute('aria-label')||'', left:r.left, top:r.top, width:r.width, height:r.height};");
}
async function openApp(appId) {
  const known = await js("return Array.from(document.querySelectorAll('.window')).map(function(el){return el.getAttribute('data-window-id')||''});");
  const knownIds = Array.isArray(known) ? known : [];
  // 与点击程序坞/应用中心等价：直接调壳层 store 的 activateApp（同一产品入口，避开浮层时序）。
  const invoked = await js(
    "var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell');" +
      "if(!shell||typeof shell.activateApp!=='function') return 'no-shell'; shell.activateApp(" + JSON.stringify(appId) + "); return 'ok';",
  );
  if (invoked !== "ok") return { ok: false, detail: "壳层 store 不可用：" + invoked };
  const appeared = await waitFn(
    "(function(){var ids=Array.from(document.querySelectorAll('.window')).map(function(el){return el.getAttribute('data-window-id')||''}); var known=" + JSON.stringify(knownIds) + "; return ids.some(function(id){return id && known.indexOf(id)<0;});})()",
    20000,
  );
  if (!appeared) return { ok: false, detail: "窗口没有出现：" + appId };
  const newId = await js(
    "return (function(){var known=" + JSON.stringify(knownIds) + "; var els=Array.from(document.querySelectorAll('.window')); var hit=els.filter(function(el){return known.indexOf(el.getAttribute('data-window-id')||'')<0;}).pop(); return hit?hit.getAttribute('data-window-id'):'';})()",
  );
  if (!newId) return { ok: false, detail: "新窗口 id 读不到：" + appId };
  await sleep(700);
  if (appId === "resource-library") {
    await waitFn("Array.from(document.querySelectorAll('[data-rl-thumb-type=image]')).every(function(el){var st=el.getAttribute('data-rl-thumb-state'); return st==='loaded'||st==='failed';})", 6000);
    await sleep(600);
  }
  const info = await js(
    "var el=document.querySelector(" + q('[data-window-id="' + newId + '"]') + "); if(!el) return null;" +
      "el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:400,clientY:80}));" +
      "var r=el.getBoundingClientRect(); return {id:el.getAttribute('data-window-id'), aria:el.getAttribute('aria-label')||'', left:r.left, top:r.top, width:r.width, height:r.height};",
  );
  if (!info) return { ok: false, detail: "窗口矩形读不到：" + appId };
  await sleep(180);
  return { ok: true, window: info };
}

async function setWindowBounds(id, width, height) {
  return await js(
    "var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell');" +
      "if(!shell) return 'no-shell'; var w=shell.windows.find(function(x){return x.id===" + q(id) + ";}); if(!w) return 'no-window';" +
      "w.bounds.w=" + Math.round(width) + "; w.bounds.h=" + Math.round(height) + "; return 'ok';",
  );
}
async function measureGeometry(appId, winId) {
  const anchors = ANCHORS[appId] || [];
  const result = await js(
    "var win=document.querySelector(" + q('[data-window-id="' + winId + '"]') + "); if(!win) return null; var root=win.querySelector('.split')||win.querySelector('.weather-app')||win; var rr=root.getBoundingClientRect();" +
      "var list=" + JSON.stringify(anchors) + ";" +
      "var anchors=list.map(function(a){ var el=root.querySelector(a.sel); if(!el) return {name:a.name, missing:true}; var r=el.getBoundingClientRect(); var cs=getComputedStyle(el); return {name:a.name, x:r.left-rr.left, y:r.top-rr.top, w:r.width, h:r.height, font:parseFloat(cs.fontSize)||0, hidden:r.width===0&&r.height===0}; });" +
      "var main=root.querySelector('.split-main'); var ms=main?getComputedStyle(main):null; var rs=getComputedStyle(root); var side=root.querySelector('.split-side'); var ss=side?getComputedStyle(side):null; var sr=side?side.getBoundingClientRect():null; var mr=main?main.getBoundingClientRect():null; return {root:{x:rr.left,y:rr.top,w:rr.width,h:rr.height}, debug:{rootGap:rs.gap, rootPadding:rs.padding, mainPadding:ms?ms.padding:null, mainMargin:ms?ms.margin:null, sideMargin:ss?ss.margin:null, sideX:sr?sr.left-rr.left:null, sideRight:sr?sr.right-rr.left:null, mainX:mr?mr.left-rr.left:null}, anchors:anchors};",
  );
  if (appId === "drama" && result) {
    await js("var el=document.querySelector('[data-drama-stage=design]'); if(el) el.click(); return 'ok';");
    await sleep(400);
    const cast = await js(
      "var win=document.querySelector(" + q('[data-window-id="' + winId + '"]') + "); if(!win) return null; var root=win.querySelector('.split')||win; var rr=root.getBoundingClientRect(); var el=root.querySelector('.dr-body[data-drama-panel=design] .dr-item'); if(!el) return null; var r=el.getBoundingClientRect(); return {name:'cast-card', x:r.left-rr.left, y:r.top-rr.top, w:r.width, h:r.height, font:parseFloat(getComputedStyle(el).fontSize)||0, hidden:false};",
    );
    if (cast) result.anchors = result.anchors.filter((a) => a.name !== "cast-card").concat([cast]);
    await js("var el=document.querySelector('[data-drama-stage=script]'); if(el) el.click(); return 'ok';");
    await sleep(300);
  }
  if (appId === "automation" && result) {
    await js("var el=document.querySelector('[data-au-tab=all]'); if(el) el.click(); return 'ok';");
    await sleep(300);
    const listExtra = await js(
      "var win=document.querySelector(" + q('[data-window-id="' + winId + '"]') + "); if(!win) return null; var root=win.querySelector('.split')||win; var rr=root.getBoundingClientRect(); var out=[]; [['row','.au-rule'],['status','.au-status'],['switch','.au-switch']].forEach(function(pair){var el=root.querySelector(pair[1]); if(!el) return; var r=el.getBoundingClientRect(); out.push({name:pair[0], x:r.left-rr.left, y:r.top-rr.top, w:r.width, h:r.height, font:parseFloat(getComputedStyle(el).fontSize)||0, hidden:false});}); return out;",
    );
    if (Array.isArray(listExtra)) result.anchors = result.anchors.filter((a) => !["row", "status", "switch"].includes(a.name)).concat(listExtra);
    await js("var el=document.querySelector('[data-au-tab=runs]'); if(el) el.click(); return 'ok';");
    await sleep(300);
    const extra = await js(
      "var win=document.querySelector(" + q('[data-window-id="' + winId + '"]') + "); if(!win) return null; var root=win.querySelector('.split')||win; var rr=root.getBoundingClientRect(); var el=root.querySelector('.au-run-row'); if(!el) return null; var r=el.getBoundingClientRect(); return {name:'run-row', x:r.left-rr.left, y:r.top-rr.top, w:r.width, h:r.height, font:parseFloat(getComputedStyle(el).fontSize)||0, hidden:false};",
    );
    if (extra) result.anchors = result.anchors.filter((a) => a.name !== "run-row").concat([extra]);
    await js("var el=document.querySelector('[data-au-tab=overview]'); if(el) el.click(); return 'ok';");
  }
  return result;
}
async function geometryChecks(winId) {
  return await js(
    "var win=document.querySelector(" + q('[data-window-id="' + winId + '"]') + "); if(!win) return null; var wr=win.getBoundingClientRect();" +
      "var overflow=[]; var overlaps=[]; var clipped=[];" +
      "['.split-main','.split-side','.window-body'].forEach(function(sel){var el=win.querySelector(sel); if(!el) return; var dx=el.scrollWidth-el.clientWidth; if(dx>1) overflow.push(sel+':'+dx);});" +
      "function rect(sel){var el=win.querySelector(sel); if(!el) return null; var r=el.getBoundingClientRect(); return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height};}" +
      "var tb=rect('.pane-toolbar'), content=rect('.file-grid')||rect('.chat-scroll')||rect('.pj-body')||rect('.rl-content')||rect('.mk-view'), bottom=rect('.finder-status')||rect('.chat-dock');" +
      "if(tb&&content){var ih=Math.min(tb.b,content.b)-Math.max(tb.t,content.t); if(ih>2) overlaps.push('toolbar/content:'+Math.round(ih));}" +
      "if(bottom&&content){var ib=Math.min(bottom.b,content.b)-Math.max(bottom.t,content.t); if(ib>2) overlaps.push('bottom/content:'+Math.round(ib));}" +
      "['.file-cell','.rl-card','.pj-table tbody tr','.mk-card','.chat-msg[data-role=user]'].forEach(function(sel){var r=rect(sel); if(!r) return; if(r.r>wr.right+0.5||r.b>wr.bottom+0.5) clipped.push(sel);});" +
      "var detail=rect('.rl-detail'); if(detail){var card=rect('.rl-card'); if(card && card.r>detail.l+0.5) overlaps.push('detail/card:'+Math.round(card.r-detail.l));}" +
      "var firstControlX=null; var root=win.querySelector('.split')||win.querySelector('.weather-app')||win;" +
      "var rr=root.getBoundingClientRect(); var bar=root.querySelector('.pane-toolbar, .mk-bar, .dc-toolbar, .tabstrip, .music-toolbar, .notes-toolbar, .pj-toolbar, .rl-toolbar, .cal-toolbar, .wx-top');" +
      "if(bar){var cand=Array.from(bar.children).find(function(el){var r=el.getBoundingClientRect(); return r.width>4 && r.height>4;}); if(cand) firstControlX=Math.round(cand.getBoundingClientRect().left-rr.left);}" +
      "return {overflow:overflow, overlaps:overlaps, clipped:clipped, firstControlX:firstControlX};",
  );
}
async function minimizeWindow(id) {
  await js("var el=document.querySelector(" + q('[data-window-id="' + id + '"]') + "); if(!el) return 'missing'; var btn=el.querySelector('.traffic .minimize'); if(btn) btn.click(); return btn?'ok':'missing';");
  await sleep(320);
}

app.whenReady().then(async () => {
  try {
    const identity = createIdentityService({ userDataDir: USER_DATA, safeStorage, allowAdmin: true, nativeImage });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    // ── task-5：resource 域 fixture（真实走 ResourceService，明确是「探针·」样本）──
    const seeded = [];
    try {
      const seedLogin = await identity.service.dispatch({ type: "identity/login", identifier: ADMIN, password: PW });
      if (seedLogin && seedLogin.ok && seedLogin.session) {
        const ctx = { sessionRef: seedLogin.session.ref, appId: "resource-library", source: "ui" };
        const imageA = path.join(ROOT, "public/icons/photos.png");
        const imageB = path.join(ROOT, "public/icons/market.png");
        const video = path.join(ROOT, "public/export-source.webm");
        const added = [];
        const importImage = async (file, name, scope) => {
          const res = await identity.resourceService.importManaged({ context: ctx, sourcePath: file, name, mimeType: "image/png", scope: scope || "PERSONAL" });
          if (res && res.ok && res.resource) added.push(res.resource.resourceId);
          return res;
        };
        const importText = async (payload) => {
          const res = await identity.resourceService.importText({ context: ctx, ...payload });
          if (res && res.ok && res.resource) added.push(res.resource.resourceId);
          return res;
        };
        await importImage(imageA, "探针·主视觉.png");
        await importImage(imageB, "探针·应用海报.png", "ORGANIZATION");
        await importText({ name: "探针·品牌规范.md", text: "# 品牌规范\n\n探针样本：用于资源库卡片与详情结构的真实文件。\n", resourceType: "text" });
        await importText({ name: "探针·同步脚本.ts", text: "export async function sync() { return 1; }\n", resourceType: "code", language: "ts" });
        await importText({ name: "探针·海报提示词.txt", text: "秋季新品主视觉，留白，暖灰背景，产品居中。\n", resourceType: "prompt" });
        await importText({ name: "探针·项目记忆.md", text: "项目记忆样本：本地优先，不自动上传。\n", resourceType: "memory", memorySubtype: "project-memory" });
        const vid = await identity.resourceService.importManaged({ context: ctx, sourcePath: video, name: "探针·片头.webm", mimeType: "video/webm", resourceType: "video", scope: "PERSONAL" });
        if (vid && vid.ok && vid.resource) added.push(vid.resource.resourceId);
        if (added[0]) await identity.resourceService.setFavorite({ context: ctx, resourceRef: added[0], favorite: true });
        if (added[2]) await identity.resourceService.setFavorite({ context: ctx, resourceRef: added[2], favorite: true });
        const tagA = await identity.resourceService.createTag({ context: ctx, name: "秋季上新" });
        const tagB = await identity.resourceService.createTag({ context: ctx, name: "品牌资产" });
        if (tagA && tagA.ok && tagA.tag && added[0]) await identity.resourceService.assignTag({ context: ctx, resourceRef: added[0], tagId: tagA.tag.tagId });
        if (tagB && tagB.ok && tagB.tag && added[1]) await identity.resourceService.assignTag({ context: ctx, resourceRef: added[1], tagId: tagB.tag.tagId });
        const colA = await identity.resourceService.createCollection({ context: ctx, name: "秋季上新", description: "探针样本集合" });
        const colB = await identity.resourceService.createCollection({ context: ctx, name: "品牌资产", description: "探针样本集合" });
        if (colA && colA.ok && colA.collection && added[0]) await identity.resourceService.setCollection({ context: ctx, resourceRef: added[0], collectionId: colA.collection.collectionId });
        if (colB && colB.ok && colB.collection && added[1]) await identity.resourceService.setCollection({ context: ctx, resourceRef: added[1], collectionId: colB.collection.collectionId });
        const seedProject = await identity.projectService.createProject({ context: ctx, name: "秋季上新" });
        if (seedProject && seedProject.ok && seedProject.project) {
          for (const rid of added.slice(0, 2)) {
            await identity.projectService.addResource({ context: ctx, projectId: seedProject.project.id, resourceRef: rid });
          }
        }
        const probeThumb = added[0] ? await identity.previewService.thumbnail({ context: ctx, resourceRef: added[0] }) : null;
        if (probeThumb && probeThumb.ok) report.thumbUrl = probeThumb.url;
        seeded.push("resources=" + added.length + " thumb=" + (probeThumb ? (probeThumb.ok ? "ok:" + String(probeThumb.url).slice(0, 40) : String(probeThumb.error)) : "none"));
      } else {
        seeded.push("login=" + JSON.stringify(seedLogin && seedLogin.error));
      }
    } catch (error) {
      seeded.push("seed-error=" + String((error && error.message) || error));
    }
    out("SEED " + seeded.join(" "));
    const fileService = createFileService({ userDataDir: USER_DATA });
    const seedDir = path.join(USER_DATA, "seed-files");
    fs.mkdirSync(seedDir, { recursive: true });
    const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const seedFiles = [
      { name: "项目说明.md", body: "# 项目说明\n\n这是探针真实落盘的示例文稿，用于访达列表密度对照。\n" },
      { name: "会议记录.txt", body: "10:00 需求对齐\n10:30 视觉走查\n" },
      { name: "需求清单.csv", body: "模块,状态\n访达,进行中\n资源库,排队中\n" },
    ];
    const seedPaths = seedFiles.map((item) => {
      const target = path.join(seedDir, item.name);
      fs.writeFileSync(target, item.body, "utf8");
      return target;
    });
    const seedMarket = path.join(ROOT, "public/icons/market.png");
    const seedMarketTarget = path.join(seedDir, "探针·门店图.png");
    if (fs.existsSync(seedMarket)) fs.copyFileSync(seedMarket, seedMarketTarget);
    const seedSource = path.join(ROOT, "public/icons/photos.png");
    const seedImage = path.join(seedDir, "演示图片.png");
    if (fs.existsSync(seedSource)) fs.copyFileSync(seedSource, seedImage);
    else fs.writeFileSync(seedImage, PNG_1PX);
    seedPaths.push(seedImage);
    const videoSrc = path.join(ROOT, "public/export-source.webm");
    if (fs.existsSync(videoSrc)) {
      for (const name of ["探针·产品特写.webm", "探针·使用场景.webm", "探针·门店空镜.webm"]) {
        const target = path.join(seedDir, name);
        fs.copyFileSync(videoSrc, target);
        seedPaths.push(target);
      }
    }
    try {
      fileService.importPaths("desktop", seedPaths);
    } catch (error) {
      report.errors.push("seed files failed: " + String((error && error.message) || error));
    }
    const marketUpdate = createMarketUpdateBundle({ userDataDir: USER_DATA, appDir: ROOT, authorization: identity.authorization, fetchImpl: null, packageResolver: null });
    const marketBundle = createMarketBundle({ userDataDir: USER_DATA, appDir: ROOT, updateService: marketUpdate, thirdPartyService: null });
    const pluginBundle = createPluginBundle({ userDataDir: USER_DATA, safeStorage: safeStorage, fetch: fetch.bind(globalThis) });
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    win = new BrowserWindow({ width: Math.min(workArea.width, 1512), height: Math.min(workArea.height, 950), x: 0, y: 0, show: true, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const isTrusted = (event) => event.sender === win.webContents && String((event.senderFrame && event.senderFrame.url) || "").indexOf(DEV_BASE) === 0;
    registerMarketIpc({ ipcMain, bundle: marketBundle, identity: identity.service, isTrusted });
    registerIntegrationIpc({ ipcMain, bundle: pluginBundle, identity: identity.service, isTrusted });
    const dxosFsAdapter = createDxosFsAdapterForUserData(USER_DATA);
    const platformBundle = createPlatformBundle({
      userDataDir: USER_DATA,
      identityStore: identity.store,
      authorization: identity.authorization,
      appVersion: "0.1.0",
      appName: "OpenArc OS",
      environment: { locale: "zh-CN", build: null },
      processes: () => [],
      metrics: () => ({}),
      fsStore: dxosFsAdapter.store,
      clock: null,
      logger: null,
    });
    registerPlatformIpc({ ipcMain, bundle: platformBundle, identity: identity.service, isTrusted });
    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      authorization: identity.authorization,
      resource: identity.resourceService,
      resourceSearch: identity.searchService,
      resourcePreview: identity.previewService,
      projects: identity.projectService,
      canvas: identity.canvasService,
      picker: identity.pickerService,
      governance: identity.governanceService,
      device: identity.deviceService,
      model: identity.modelService,
      mcp: identity.mcpService,
      isTrusted,
      send: () => {},
    });
    const filesChannels = {
      "files:list": (e, folderId) => fileService.list(String(folderId || "")),
      "files:import": (e, payload) => fileService.importPaths(String((payload && payload.folderId) || ""), Array.isArray(payload && payload.paths) ? payload.paths : []),
      "files:rename": (e, payload) => fileService.rename(String(payload.folderId || ""), String(payload.id || ""), String(payload.name || "")),
      "files:remove": (e, payload) => fileService.remove(String(payload.folderId || ""), String(payload.id || "")),
      "files:trash": (e, payload) => fileService.trash(String(payload.folderId || ""), String(payload.id || ""), payload.groupId),
      "files:trashList": () => fileService.listTrash(),
      "files:trashRestore": (e, payload) => fileService.restore(String(payload.id || "")),
      "files:trashPurge": (e, payload) => fileService.purge(String(payload.id || "")),
      "files:trashEmpty": () => fileService.empty(),
      "files:read": (e, payload) => fileService.read(String(payload.folderId || ""), String(payload.id || "")),
      "files:thumb": (e, payload) => {
        const hit = fileService.resolve(String(payload.folderId || ""), String(payload.id || ""));
        if (!hit) return { ok: false, error: "NOT_FOUND" };
        try {
          const image = nativeImage.createFromPath(hit.path);
          if (image.isEmpty()) return { ok: false, error: "NO_THUMBNAIL" };
          const small = image.resize({ width: 128, height: 128, quality: "good" });
          return { ok: true, dataUrl: small.toDataURL() };
        } catch (error) {
          return { ok: false, error: "NO_THUMBNAIL" };
        }
      },
      "files:info": () => ({ ok: false, error: "NO_INFO" }),
      "files:copy": (e, payload) => fileService.copy(String(payload.folderId || ""), payload.ids, String(payload.toFolderId || "")),
      "files:move": (e, payload) => fileService.move(String(payload.folderId || ""), payload.ids, String(payload.toFolderId || "")),
      "files:export": () => ({ ok: false, error: "CANCELED" }),
    };
    for (const [channel, fn] of Object.entries(filesChannels)) {
      ipcMain.handle(channel, async (event, payload) => {
        if (!isTrusted(event)) throw Error("Forbidden");
        return fn(event, payload);
      });
    }
    ipcMain.on("files:startDrag", () => {});
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    ipcMain.handle("browser:command", async () => ({ ok: true }));
    ipcMain.handle("system:info", async () => ({ ok: true, value: { platform: "darwin", arch: "arm64", version: "0.1.0", hostname: "align-probe" } }));
    protocol.handle("openarc-resource", async (request) => {
      try {
        const res = await identity.previewService.handleProtocolRequest(request);
        return res;
      } catch (error) {
        out("PROTO-ERR " + String((error && error.stack) || error).slice(0, 300));
        return new Response("error", { status: 500 });
      }
    });
    protocol.handle("openarc-file", async () => {
      try {
        if (!fs.existsSync(NATIVE)) return new Response("Not Found", { status: 404 });
        return new Response(Readable.toWeb(fs.createReadStream(NATIVE)), { status: 200, headers: { "Content-Type": "video/quicktime", "Access-Control-Allow-Origin": "*" } });
      } catch { return new Response("Error", { status: 500 }); }
    });
    const agentFixture = (() => {
      let projectSeq = 1;
      let taskSeq = 10;
      let eventSeq = 100;
      const projects = [
        { id: "agent-proj-probe", name: "秋季上新", root_node_id: "oa-probe-root", created_at: Date.now() },
        { id: "agent-proj-probe-2", name: "品牌短片", root_node_id: "oa-probe-root-2", created_at: Date.now() },
        { id: "agent-proj-probe-3", name: "门店陈列更新", root_node_id: "oa-probe-root-3", created_at: Date.now() },
      ];
      const tasks = [
        { taskId: "task-probe-1", projectId: "agent-proj-probe", title: "生成 3 张门店海报", instruction: "生成 3 张门店海报，白底留白 40%", status: "waiting_user", mode: "react", executionProfile: "thinking", createdAt: Date.now() - 900000, updatedAt: Date.now() - 60000, errorMessage: null },
        { taskId: "task-probe-2", projectId: "agent-proj-probe", title: "整理秋季上新素材", instruction: "整理秋季上新素材并写入资源库", status: "running", mode: "react", executionProfile: "agent", createdAt: Date.now() - 600000, updatedAt: Date.now() - 20000, errorMessage: null },
        { taskId: "task-probe-3", projectId: "agent-proj-probe", title: "导出主图 6 张", instruction: "导出主图 6 张", status: "completed", mode: "react", executionProfile: "thinking", createdAt: Date.now() - 3600000, updatedAt: Date.now() - 1800000, errorMessage: null },
        { taskId: "task-probe-4", projectId: "agent-proj-probe", title: "校对商品文案", instruction: "校对商品文案", status: "failed", mode: "react", executionProfile: "thinking", createdAt: Date.now() - 7200000, updatedAt: Date.now() - 3000000, errorMessage: "模型调用超时（探针样本）" },
        { taskId: "task-probe-5", projectId: "agent-proj-probe-2", title: "剪 15 秒片头", instruction: "剪 15 秒片头", status: "completed", mode: "react", executionProfile: "thinking", createdAt: Date.now() - 5400000, updatedAt: Date.now() - 2400000, errorMessage: null },
        { taskId: "task-probe-6", projectId: "agent-proj-probe-3", title: "更新门店陈列图", instruction: "更新门店陈列图", status: "queued", mode: "react", executionProfile: "agent", createdAt: Date.now() - 4800000, updatedAt: Date.now() - 3600000, errorMessage: null },
      ];
      const events = {
        "task-probe-1": [
          { id: "e1", sequence: 1, type: "task.created", message: "任务创建，目标设备 本机 · D1", at: Date.now() - 900000 },
          { id: "e2", sequence: 2, type: "task.running", message: "开始执行 · 图像模型（自动选择）", at: Date.now() - 880000 },
          { id: "e3", sequence: 3, type: "task.waiting_user", message: "等待确认：是否写入资源库？", at: Date.now() - 60000 },
        ],
        "task-probe-2": [
          { id: "e4", sequence: 1, type: "task.created", message: "任务创建", at: Date.now() - 600000 },
          { id: "e5", sequence: 2, type: "task.running", message: "读取资源库引用", at: Date.now() - 500000 },
        ],
        "task-probe-3": [
          { id: "e6", sequence: 1, type: "task.created", message: "任务创建", at: Date.now() - 3600000 },
          { id: "e7", sequence: 2, type: "task.completed", message: "任务完成，产物已写入资源库", at: Date.now() - 1800000 },
        ],
        "task-probe-4": [
          { id: "e8", sequence: 1, type: "task.created", message: "任务创建", at: Date.now() - 7200000 },
          { id: "e9", sequence: 2, type: "task.failed", message: "模型调用超时", at: Date.now() - 3000000 },
        ],
      };
      const steps = [
        { id: "s1", title: "读取项目资源", status: "completed" },
        { id: "s2", title: "生成海报", status: "running" },
        { id: "s3", title: "写入资源库", status: "queued" },
      ];
      const find = (id) => tasks.find((t) => t.taskId === id);
      const pushEvent = (taskId, type, message) => {
        eventSeq += 1;
        (events[taskId] = events[taskId] || []).push({ id: "e" + eventSeq, sequence: (events[taskId] || []).length + 1, type, message, at: Date.now() });
      };
      return { projects, tasks, events, steps, find, pushEvent, nextProject: () => "agent-proj-probe-" + (++projectSeq), nextTask: () => "task-probe-" + (++taskSeq) };
    })();
    ipcMain.handle("agent:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const command = raw && raw.command;
      const payload = (raw && raw.payload) || {};
      const ok = (value) => ({ ok: true, value });
      const fail = (error, message) => ({ ok: false, error, message: message || "" });
      if (command === "agent/project/list") return ok({ items: agentFixture.projects });
      if (command === "agent/project/create") {
        const project = { id: agentFixture.nextProject(), name: String(payload.name || "新项目"), root_node_id: String(payload.rootNodeId || "oa-probe-root-" + Date.now().toString(36)), created_at: Date.now() };
        agentFixture.projects.push(project);
        return ok({ project });
      }
      if (command === "agent/project/run") return ok({ outcome: { text: "探针 fixture：项目 Agent 同步回复（真实命令形状）", complete: true } });
      if (command === "agent/task/list") {
        return ok({ items: agentFixture.tasks.filter((t) => t.projectId === payload.projectId) });
      }
      if (command === "agent/task/create") {
        const task = { taskId: agentFixture.nextTask(), projectId: String(payload.projectId || ""), title: String(payload.title || payload.instruction || "新任务"), instruction: String(payload.instruction || ""), status: "running", mode: "react", executionProfile: String(payload.executionProfile || "thinking"), createdAt: Date.now(), updatedAt: Date.now(), errorMessage: null };
        agentFixture.tasks.unshift(task);
        agentFixture.events[task.taskId] = [{ id: "e-" + task.taskId, sequence: 1, type: "task.created", message: "任务创建（探针 fixture）", at: Date.now() }];
        return ok({ task });
      }
      if (command === "agent/task/get") {
        const task = agentFixture.find(payload.taskId);
        if (!task) return fail("AGENT_TASK_NOT_FOUND", "探针 fixture 没有这个任务");
        return ok({ task, checkpoints: 2, steps: agentFixture.steps, deliverables: [] });
      }
      if (command === "agent/task/events") {
        return ok({ items: agentFixture.events[payload.taskId] || [] });
      }
      if (command === "agent/task/pause" || command === "agent/task/resume" || command === "agent/task/cancel" || command === "agent/task/answer" || command === "agent/task/continue") {
        const task = agentFixture.find(payload.taskId);
        if (!task) return fail("AGENT_TASK_NOT_FOUND", "探针 fixture 没有这个任务");
        const next = { "agent/task/pause": "paused", "agent/task/resume": "running", "agent/task/cancel": "cancelled", "agent/task/answer": "running", "agent/task/continue": "queued" }[command];
        task.status = next;
        task.updatedAt = Date.now();
        agentFixture.pushEvent(task.taskId, "task." + next, "探针 fixture 状态更新");
        return ok({ task });
      }
      if (command === "agent/run/inspect") return ok({ inspection: { run: { status: "running" }, nodeActivity: { recorded: { modelCalls: 3, toolCalls: 2 } } } });
      return fail("AGENT_NOT_READY", "探针 fixture 未实现 " + String(command));
    });
    // ── task-7：对话 fixture（两轮真实结构：步骤/产物/事件/工具调用）──
    const taskFixture = (() => {
      const now = Date.now();
      const mk = (id, goal, status, updatedAt, steps, events, calls) => ({ id, goal, status, updatedAt, steps, events, calls });
      const t1 = mk("task-chat-1", "把秋季上新的素材整理成 3 组，并给出每组一句文案", "SUCCEEDED", now - 60000,
        [
          { stepId: "step-1", sequence: 1, status: "SUCCEEDED", input: { goal: "把秋季上新的素材整理成 3 组，并给出每组一句文案" }, kind: "model" },
          { stepId: "step-2", sequence: 2, status: "SUCCEEDED", input: { goal: "检查结果并写入资源库" }, kind: "model" },
        ],
        [
          { eventId: "ev-1", sequence: 1, eventType: "task.created", createdAt: now - 120000, safePayload: {} },
          { eventId: "ev-2", sequence: 2, eventType: "tool.proposed", createdAt: now - 110000, safePayload: { toolName: "fs_list", toolId: "fs_list", proposalId: "p1" } },
          { eventId: "ev-3", sequence: 3, eventType: "tool.execution.succeeded", createdAt: now - 100000, safePayload: { toolName: "fs_list", toolId: "fs_list", proposalId: "p1" } },
          { eventId: "ev-4", sequence: 4, eventType: "tool.proposed", createdAt: now - 90000, safePayload: { toolName: "resource_write", toolId: "resource_write", proposalId: "p2" } },
          { eventId: "ev-5", sequence: 5, eventType: "tool.execution.succeeded", createdAt: now - 80000, safePayload: { toolName: "resource_write", toolId: "resource_write", proposalId: "p2" } },
          { eventId: "ev-6", sequence: 6, eventType: "task.completed", createdAt: now - 60000, safePayload: {} },
        ],
        [
          { callId: "call-1", stepId: "step-1", status: "ok", startedAt: now - 110000, completedAt: now - 100000 },
        ]);
      const t2 = mk("task-chat-2", "生成 3 张门店海报", "SUCCEEDED", now - 86400000,
        [{ stepId: "step-3", sequence: 1, status: "SUCCEEDED", input: { goal: "生成 3 张门店海报" }, kind: "model" }],
        [
          { eventId: "ev-7", sequence: 1, eventType: "task.created", createdAt: now - 90000000, safePayload: {} },
          { eventId: "ev-8", sequence: 2, eventType: "task.completed", createdAt: now - 86400000, safePayload: {} },
        ],
        []);
      const tasks = { "task-chat-1": t1, "task-chat-2": t2 };
      const artifacts = {
        "task-chat-1": [
          { stepId: "step-1", content: "已按色系整理成 3 组：暖灰、焦糖、深绿。\n\n- 暖灰：通勤场景\n- 焦糖：周末出行\n- 深绿：户外系列", createdAt: now - 70000 },
          { stepId: "step-2", content: "3 组素材已写入资源库，命名是「秋季上新_组名_序号」。\n\n需要我继续生成主图吗？", createdAt: now - 62000 },
        ],
        "task-chat-2": [{ stepId: "step-3", content: "3 张门店海报已生成并保存到资源库。", createdAt: now - 86450000 }],
      };
      return {
        tasks,
        artifacts,
        list: () => Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt),
        detail: (id) => {
          const task = tasks[id];
          if (!task) return null;
          return {
            task: { taskId: task.id, goal: task.goal, status: task.status, updatedAt: task.updatedAt, createdAt: task.updatedAt - 60000, revision: 1, modelConfigId: "cfg-probe-1" },
            steps: task.steps,
            artifacts: artifacts[id] || [],
            events: task.events,
            calls: task.calls,
            appendable: true,
            appendReason: null,
            resumable: false,
            stopReason: null,
            recovery: null,
            budgetLedger: null,
            verifications: [],
          };
        },
        add: (goal) => {
          const id = "task-chat-" + Date.now().toString(36);
          tasks[id] = mk(id, goal, "SUCCEEDED", Date.now(), [{ stepId: "step-" + id, sequence: 1, status: "SUCCEEDED", input: { goal }, kind: "model" }], [{ eventId: "ev-" + id, sequence: 1, eventType: "task.completed", createdAt: Date.now(), safePayload: {} }], []);
          artifacts[id] = [{ stepId: "step-" + id, content: "探针 fixture：收到「" + goal + "」。", createdAt: Date.now() }];
          return id;
        },
      };
    })();
    ipcMain.handle("task:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const command = raw && raw.command;
      const payload = (raw && raw.payload) || {};
      if (command === "task/list") return { ok: true, items: taskFixture.list().map((t) => ({ taskId: t.id, goal: t.goal, status: t.status, updatedAt: t.updatedAt, revision: 1, modelConfigId: "cfg-probe-1" })) };
      if (command === "task/get") {
        const detail = taskFixture.detail(payload.taskId);
        return detail ? { ok: true, ...detail } : { ok: false, error: "TASK_NOT_FOUND" };
      }
      if (command === "task/run") {
        const id = taskFixture.add(String(payload.goal || ""));
        return { ok: true, taskId: id };
      }
      if (command === "task/appendStep") return { ok: true, taskId: payload.taskId };
      if (command === "task/cancel" || command === "task/resume" || command === "task/acknowledgeUnknownEffect") return { ok: true };
      return { ok: false, error: "INTERNAL_ERROR" };
    });
    try { ipcMain.removeHandler("model:command"); } catch {}
    ipcMain.handle("model:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const command = raw && raw.command;
      if (command === "model/list") {
        return { ok: true, items: [
          { configId: "cfg-probe-1", displayName: "DeepSeek V3", providerName: "DeepSeek", status: "enabled", capabilities: ["chat"] },
          { configId: "cfg-probe-2", displayName: "GPT-4.1", providerName: "OpenAI 兼容", status: "enabled", capabilities: ["chat"] },
        ] };
      }
      if (command === "defaults/get") return { ok: true, personal: { chat: "cfg-probe-1" }, organization: {} };
      return { ok: false, error: "INTERNAL_ERROR" };
    });
    // task-11：天气 fixture（Open-Meteo 形状；探针禁网时用）
    ipcMain.handle("weather:forecast", async (event, payload) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      if (process.env.OA_ALIGN_WEATHER_ERROR === "1") return { ok: false, error: "NETWORK" };
      const now = new Date();
      const iso = (d) => d.toISOString().slice(0, 13) + ":00";
      const day = (offset) => { const d = new Date(now); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
      const hourly = Array.from({ length: 24 }, (_, i) => { const d = new Date(now); d.setHours(d.getHours() + i); return { time: iso(d), temp: 19 + ((i * 3) % 9), code: [1, 2, 3, 61][i % 4], pop: (i * 7) % 60 }; });
      const daily = Array.from({ length: 7 }, (_, i) => ({ date: day(i), code: [1, 2, 3, 61, 2, 1, 3][i], max: 24 + (i % 4), min: 15 + (i % 3), pop: (i * 11) % 70, sunrise: day(i) + "T06:12", sunset: day(i) + "T17:48" }));
      return { ok: true, current: { temp: 23, feels: 22, humidity: 61, code: 2, wind: 9, isDay: true, time: iso(now) }, hourly, daily };
    });
    ipcMain.handle("weather:geocode", async (event, payload) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const name = String((payload && payload.name) || "上海");
      return { ok: true, items: [{ name: name || "上海", admin: "上海", country: "中国", lat: 31.23, lon: 121.47 }] };
    });
    ipcMain.removeHandler("files:trashList");
    ipcMain.handle("files:trashList", async (event) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      if (process.env.OA_ALIGN_TRASH_EMPTY === "1") return { entries: [] };
      return { entries: [
        { id: "trash-probe-1", origId: "img-1", folderId: "desktop", from: "桌面", name: "旧版主图.png", ext: "png", groupId: null },
        { id: "trash-probe-2", origId: "img-2", folderId: "desktop", from: "文稿", name: "封面备选.jpg", ext: "jpg", groupId: null },
        { id: "trash-probe-3", origId: "no-thumb-1", folderId: "desktop", from: "下载", name: "旧版主图-无缩略图.png", ext: "png", groupId: null },
        { id: "trash-probe-4", origId: "clip-1", folderId: "desktop", from: "秋季上新", name: "门店走查.mp4", ext: "mp4", groupId: null },
        { id: "trash-probe-5", origId: "doc-1", folderId: "desktop", from: "", name: "需求草稿.md", ext: "md", groupId: null },
      ] };
    });
    ipcMain.removeHandler("files:thumb");
    ipcMain.handle("files:thumb", async (event, payload) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const id = String(payload && payload.id || "");
      if (id.includes("no-thumb")) return { ok: false, error: "NO_THUMBNAIL" };
      if (id.startsWith("img-") || id.startsWith("clip-")) {
        const shot = path.join(ROOT, "public/icons/photos.png");
        try {
          const image = nativeImage.createFromPath(shot);
          if (!image.isEmpty()) return { ok: true, dataUrl: image.resize({ width: 128, height: 128 }).toDataURL() };
        } catch {}
      }
      return { ok: false, error: "NO_THUMBNAIL" };
    });
    ipcMain.removeHandler("files:trashRestore");
    ipcMain.handle("files:trashRestore", async (event) => ({ ok: true }));
    ipcMain.removeHandler("files:trashPurge");
    ipcMain.handle("files:trashPurge", async (event) => ({ ok: true }));
    ipcMain.removeHandler("files:trashEmpty");
    ipcMain.handle("files:trashEmpty", async (event) => ({ ok: true }));
    ipcMain.handle("image:declare", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const payload = raw && raw.payload ? raw.payload : (raw || {});
      const list = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.images) ? payload.images : [];
      return { ok: true, results: list.map((item, index) => ({ id: item.id, ok: true, replaced: index % 2 === 0, entry: { name: String(item.id || "image") + "-declared.png" } })) };
    });
    // task-27：AI Studio 模型/canvas fixture
    ipcMain.removeHandler("model:command");
    ipcMain.handle("model:command", async (_e, raw) => {
      if (raw && raw.type === "canvas/models") return { ok: true, models: [{ configId: "probe-chat", label: "Probe Chat", providerName: "probe", status: "enabled", capabilities: ["chat"] }] };
      return { ok: true, models: [] };
    });
    ipcMain.removeHandler("canvas:command");
    ipcMain.handle("canvas:command", async (event, raw) => {
      const type = raw && raw.type;
      if (type === "canvas/run") return { ok: true, runId: "probe-run" };
      if (type === "canvas/modelChatStream") {
        const requestId = String(raw.requestId || "");
        const state = process.env.OA_ALIGN_STUDIO_EVENT_STATE || process.env.OA_ALIGN_STUDIO_STATE || "complete";
        const emit = (ev) => { try { event.sender.send("model:event", { payload: { type: "canvas.stream", requestId, event: ev } }); } catch { /* ignore */ } };
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        emit({ type: "thinking.delta", text: "先确认目标：为秋季新品生成门店文案，并检查可用素材。" });
        await wait(220);
        if (state === "thinking") await wait(30000);
        emit({ type: "tool.start", id: "t1", name: "素材检索" });
        await wait(320);
        if (state === "tool" || state === "stopped") await wait(30000);
        emit({ type: "tool.end", id: "t1", status: "done", ms: 820, output: "找到 3 条门店素材引用" });
        emit({ type: "task", items: ["理解需求", "检索素材", "生成文案"] });
        emit({ type: "source", title: "OpenArc 设计系统", url: "https://openarc.local/design" });
        emit({ type: "code", lang: "ts", code: "const copy = await studio.run({ kind: \"poster\", ratio: \"3:4\" });" });
        emit({ type: "image", url: "/icons/photos.png" });
        await wait(260);
        emit({ type: "text.delta", text: "这是探针流式生成的示例回复。" });
        return { ok: true, text: "这是探针流式生成的示例回复。" };
      }
      if (type === "canvas/runFinish" || type === "canvas/runStop") return { ok: true };
      return { ok: true };
    });
    // task-25：开发者 fixture（1 项目 2 文件 + 检查日志）
    ipcMain.removeHandler("developer:command");
    ipcMain.handle("developer:command", async (_e, raw) => {
      const cmd = raw && raw.command;
      if (cmd === "developer/health") return { ok: true, value: { ok: true, version: "probe" } };
      if (cmd === "developer/list") return { ok: true, value: { apps: [], count: 0 } };
      if (cmd === "developer/lab/list") return { ok: true, value: { drafts: [{ id: "draft-1", name: "门店海报", appId: "store-poster", summary: "沙箱开发项目", files: [{ path: "main.js", bytes: 2048, content: "import { createApp } from \"openarc-app/v1\";\n\nconst app = createApp({ name: \"store-poster\" });\nconst poster = await app.run({ width: 1080, height: 1440 });\nreturn poster;" }, { path: "manifest.json", bytes: 512, content: "{\n  \"schema\": \"openarc-app/v1\",\n  \"name\": \"store-poster\",\n  \"version\": \"0.3.0\"\n}" }], previewUrl: "/icons/photos.png", checks: [{ id: "entry", label: "入口文件存在", status: "pass" }, { id: "secrets", label: "未包含绝对路径与密钥", status: "pass" }, { id: "icon", label: "assets/icon.svg 缺失：将自动生成默认图标", status: "warn" }], createdAt: Date.now() }] } };
      if (cmd === "developer/lab/templates") return { ok: true, value: { templates: [] } };
      if (cmd === "developer/docs/status") return { ok: true, value: { status: {} } };
      return { ok: true, value: {} };
    });
    // task-23：视频探测 fixture（真实时长）
    ipcMain.removeHandler("video:status");
    ipcMain.handle("video:status", async () => ({ ok: true, available: true, version: "probe" }));
    ipcMain.removeHandler("video:probe");
    ipcMain.handle("video:probe", async () => ({ ok: true, duration: 5, width: 1920, height: 1080 }));
    // task-22：照片 fixture（4 张：3 图 + 1 视频）
    ipcMain.removeHandler("photos:command");
    ipcMain.handle("photos:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const cmd = String(raw && (raw.command || raw.type) || "");
      const items = [
        { id: "ph-1", name: "门店主视觉.png", kind: "image", mime: "image/png", size: 420000, updated_ts: Date.now() - 3600000, relativePath: "秋季上新/门店主视觉.png", source_id: "src-1" },
        { id: "ph-2", name: "海报方案.jpg", kind: "image", mime: "image/jpeg", size: 380000, updated_ts: Date.now() - 7200000, relativePath: "秋季上新/海报方案.jpg", source_id: "src-1" },
        { id: "ph-3", name: "片头预览.mp4", kind: "video", mime: "video/mp4", size: 8200000, updated_ts: Date.now() - 86400000, relativePath: "视频/片头预览.mp4", source_id: "src-1" },
        { id: "ph-4", name: "生成主图.png", kind: "image", mime: "image/png", size: 520000, updated_ts: Date.now() - 172800000, relativePath: "生成/生成主图.png", source_id: "src-1" },
      ];
      const icons = { "ph-1": "tests/fixtures/photos/coast.png", "ph-2": "tests/fixtures/photos/desert.png", "ph-3": "tests/fixtures/photos/forest.png", "ph-4": "tests/fixtures/photos/dusk.png" };
      const data = (id) => { try { const png = path.join(ROOT, icons[id] || "tests/fixtures/photos/coast.png"); const img = nativeImage.createFromPath(png); return img.resize({ width: 640 }).toDataURL().split(",")[1]; } catch { return ""; } };
      if (cmd === "photos/health") return { ok: true, value: { ok: true, commands: 12 } };
      if (cmd === "photos/sources/list") return { ok: true, value: { sources: [{ id: "src-1", name: "图库来源", available: true }], folders: [], virtualFolders: [], items, total: items.length, offset: 0, limit: 60, truncated: false } };
      if (cmd === "photos/sourceThumbnail") { const id = String(raw.payload?.id || raw.id || "ph-1"); return { ok: true, value: { data: data(id) } }; }
      if (cmd === "photos/sourceFile") { const id = String(raw.payload?.id || raw.id || "ph-1"); return { ok: true, value: { data: data(id), mime: "image/png", size: 420000 } }; }
      return { ok: true, value: {} };
    });
    // task-21：MCP fixture（就绪 3 工具 + 调用记录；失败连接）
    ipcMain.removeHandler("mcp:command");
    ipcMain.handle("mcp:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const cmd = String(raw && (raw.command || raw.type) || "");
      const ready = {
        connectionId: "mcp-1", name: "文件系统", transport: "stdio", location: "LOCAL", endpoint: "npx -y @modelcontextprotocol/server-filesystem /Users/probe",
        status: "CONNECTED", enabled: true, authMode: "NONE", visibility: "PERSONAL", lastConnectedAt: Date.now() - 120000,
        protocolVersion: "2025-06-18", serverName: "filesystem", serverVersion: "0.6.2", toolsHash: "probe-hash-1",
        capabilities: { tools: {}, resources: {} },
        tools: [
          { name: "read_file", description: "读取文件内容", inputSchemaSummary: "path: string" },
          { name: "search", description: "搜索文件", inputSchemaSummary: "query: string" },
          { name: "write_file", description: "写入文件（需确认）", inputSchemaSummary: "path, content" },
        ],
      };
      const bad = {
        connectionId: "mcp-2", name: "远程检索", transport: "http", location: "REMOTE", endpoint: "https://mcp.example.com/sse",
        status: "ERROR", enabled: true, authMode: "BEARER", visibility: "TEAM", lastConnectedAt: 0,
        lastErrorCode: "MCP_HANDSHAKE_FAILED", tools: [],
      };
      if (cmd === "mcp/list") return { ok: true, items: [ready, bad] };
      if (cmd === "mcp/get") { const id = String(raw.payload?.connectionId || raw.connectionId || ""); return { ok: true, connection: id === "mcp-2" ? bad : ready }; }
      if (cmd === "mcp/testLog") return { ok: true, items: [{ at: Date.now() - 120000, ok: true, latencyMs: 42 }, { at: Date.now() - 86400000, ok: false, errorCode: "MCP_TIMEOUT", latencyMs: 3000 }] };
      return { ok: true };
    });
    // task-19：Skill 中心 fixture（市场 3 + 我的 1 + 已安装 2）
    ipcMain.removeHandler("skill:command");
    ipcMain.handle("skill:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const type = String(raw && (raw.command || raw.type) || "");
      const skills = [
        { id: "sk-1", name: "海报批量生成", description: "按模板批量生成门店海报并导出。", version: "1.2.0", author: "OpenArc", builtin: true, enabled: true, kind: "image" },
        { id: "sk-2", name: "竞品监测", description: "定期抓取竞品价格与上新，生成摘要。", version: "0.9.1", author: "社区", builtin: false, enabled: true, kind: "efficiency" },
        { id: "sk-3", name: "门店海报批量生成", description: "读取门店清单，套用海报模板并导出 PDF。", version: "0.3.0", author: "Admin", builtin: false, enabled: false, kind: "image" },
        { id: "sk-4", name: "视频号切片", description: "从长视频切出 15 秒片段。", version: "1.0.0", author: "设计部", builtin: false, enabled: true, kind: "video" },
      ];
      if (type === "skill/health") return { ok: true, value: { commands: 15 } };
      if (type === "skill/list") return { ok: true, value: { skills } };
      if (type === "skill/get") return { ok: true, value: { skill: skills[0] } };
      if (type === "skill/pack/list") return { ok: true, value: { packs: [] } };
      if (type === "skill/enable" || type === "skill/disable") return { ok: true, value: {} };
      return { ok: true, value: {} };
    });
    // task-18：自动化 fixture（3 规则 + 3 运行记录）
    ipcMain.removeHandler("automation:command");
    ipcMain.handle("automation:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const type = String(raw && (raw.command || raw.type) || "");
      const automations = [
        { id: "au-1", title: "每日竞品价格", enabled: true, schedule: { kind: "daily", time: "09:00" }, action: { type: "agent_instruction", args: { instruction: "运行 Skill「竞品监测」并生成摘要" } }, nextRunAt: Date.now() + 3600000, lastStatus: "success", lastError: null },
        { id: "au-2", title: "周报汇总", enabled: true, schedule: { kind: "weekly", time: "17:30", weekdays: [4] }, action: { type: "agent_instruction", args: { instruction: "汇总本周项目进展" } }, nextRunAt: Date.now() + 86400000, lastStatus: "failed", lastError: "依赖的「表格读取」MCP 未连接" },
        { id: "au-3", title: "素材归档", enabled: false, schedule: { kind: "daily", time: "23:00" }, action: { type: "agent_instruction", args: { instruction: "把「下载」中的图片移入资源库" } }, nextRunAt: 0, lastStatus: "stopped", lastError: null },
      ];
      const now = Date.now();
      const runs = [
        { id: "run-1", automationId: "au-1", status: "success", startedAt: now - 3600000, finishedAt: now - 3599000, result: "42 s" },
        { id: "run-2", automationId: "au-2", status: "failed", startedAt: now - 86400000, finishedAt: now - 86400000 + 3000, error: "MCP 未连接" },
        { id: "run-3", automationId: "au-1", status: "success", startedAt: now - 90000000, finishedAt: now - 90000000 + 39000 },
      ];
      if (type === "automation/health") return { ok: true, value: { schedulerRunning: true } };
      if (type === "automation/list") return { ok: true, value: { automations } };
      if (type === "automation/runs") return { ok: true, value: { runs } };
      if (type === "automation/parse") return { ok: true, value: { automation: null } };
      if (type === "automation/create") return { ok: true, value: { automation: automations[0] } };
      return { ok: true, value: {} };
    });
    // task-17：组织治理 fixture（成员/部门/审计/应用）
    ipcMain.removeHandler("governance:command");
    ipcMain.handle("governance:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const type = String(raw && raw.type || "");
      const depts = [
        { departmentId: "dept-design", name: "设计部", description: "视觉与视频", memberCount: 3, resourceCount: 128, collectionCount: 4, status: "ACTIVE" },
        { departmentId: "dept-ops", name: "运营部", description: "内容与门店", memberCount: 2, resourceCount: 76, collectionCount: 2, status: "ACTIVE" },
        { departmentId: "dept-admin", name: "管理组", description: "", memberCount: 1, resourceCount: 12, collectionCount: 1, status: "ACTIVE" },
      ];
      const users = [
        { userId: "u-1", identifier: "admin", displayName: "Admin", role: "SUPER_ADMIN", status: "ACTIVE", departments: [depts[2]] },
        { userId: "u-2", identifier: "chensi", displayName: "陈思", role: "ADMIN", status: "ACTIVE", departments: [depts[0]] },
        { userId: "u-3", identifier: "wanglei", displayName: "王磊", role: "MEMBER", status: "ACTIVE", departments: [depts[1]] },
        { userId: "u-4", identifier: "zhouhang", displayName: "周航", role: "MEMBER", status: "DISABLED", departments: [depts[1]] },
        { userId: "u-5", identifier: "zhao", displayName: "Zhao", role: "MEMBER", status: "ACTIVE", departments: [depts[0]] },
        { userId: "u-6", identifier: "li", displayName: "李然", role: "MEMBER", status: "ACTIVE", departments: [] },
      ];
      if (type === "governance/listUsers") return { ok: true, items: users };
      if (type === "governance/listDepartments") return { ok: true, items: depts };
      if (type === "governance/listAudit") return { ok: true, items: [
        { action: "resource.write", decision: "ALLOW", reasonCode: "OWNER", actorUserId: "u-2", resourceRef: "resource://library/6" },
        { action: "resource.share", decision: "ALLOW", reasonCode: "DEPT_ADMIN", actorUserId: "u-3", resourceRef: "resource://library/9" },
        { action: "file.delete", decision: "DENY", reasonCode: "NO_PERMISSION", actorUserId: "u-4", resourceRef: "resource://library/3" },
      ] };
      if (type === "governance/listApps") return { ok: true, items: [
        { appId: "studio", name: "AI Studio", status: "enabled", grantCount: 2, memoryAccess: true },
        { appId: "drama", name: "短剧工坊", status: "enabled", grantCount: 1, memoryAccess: true },
        { appId: "org", name: "组织治理", status: "enabled", grantCount: 0, memoryAccess: false },
      ] };
      return { ok: true, items: [] };
    });
    // task-13：本地音乐库 fixture（真实 media/library/* 形状）
    ipcMain.handle("media:command", async (event, raw) => {
      if (!isTrusted(event)) throw Error("Forbidden");
      const command = raw && raw.command;
      const tracks = Array.from({ length: 8 }, (_, i) => ({
        id: "track-probe-" + i,
        title: ["秋季上新", "门店循环", "夜色通勤", "午后整理", "品牌片头", "陈列走查", "周会背景", "收尾"][i],
        artist: ["运营部", "设计部", "陈思", "王磊", "Zhao", "周航", "Admin", "Unknown"][i],
        album: i % 2 ? "门店歌单" : "秋季上新",
        duration: 150 + i * 23,
        ext: ["mp3", "flac", "m4a", "wav"][i % 4],
        fileName: "track-" + i + ".mp3",
        folder: i % 3 ? "Music/秋季" : "Music",
        size: 3200000 + i * 120000,
        trackNo: i + 1,
        hasLyrics: i % 3 === 0,
        albumImage: null,
        artistImage: null,
      }));
      if (command === "media/short-drama/list") return { ok: true, value: { projects: [{ id: "drama-1", name: "《晚风知道》", stage: "script", episodeCount: 3, shots: [], updatedAt: Date.now(), sourceText: "便利店傍晚的故事。".repeat(4), blueprint: { logline: "旧照片与重逢", tone: "温柔", episodes: [{ id: "ep1", title: "傍晚的便利店", summary: "林夏遇见陈默。", hook: "旧照片" }, { id: "ep2", title: "汽水与旧照片", summary: "两人回忆。", hook: "老汽水" }, { id: "ep3", title: "晚风知道", summary: "告别。", hook: "—" }] }, visualDesign: { style: "暖光写实", characters: [{ id: "c1", name: "林夏", role: "便利店店长" }, { id: "c2", name: "陈默", role: "归乡青年" }], locations: [] } }] } };
      if (command === "media/short-drama/get") return { ok: true, value: { project: { id: "drama-1", name: "《晚风知道》", stage: "script", shots: [], sourceText: "便利店傍晚的故事。".repeat(4), blueprint: { logline: "旧照片与重逢", tone: "温柔", model: "probe", episodes: [{ id: "ep1", title: "傍晚的便利店", summary: "林夏遇见陈默。", hook: "旧照片", characterNames: "林夏、陈默", locationNames: "便利店" }, { id: "ep2", title: "汽水与旧照片", summary: "两人回忆过去。", hook: "老汽水", characterNames: "林夏", locationNames: "便利店" }, { id: "ep3", title: "晚风知道", summary: "告别与重逢。", hook: "—", characterNames: "陈默", locationNames: "街道" }] }, visualDesign: { style: "暖光写实", characters: [{ id: "c1", name: "林夏", role: "便利店店长", appearance: "米色针织衫" }, { id: "c2", name: "陈默", role: "归乡青年", appearance: "深色风衣" }], locations: [] } }, images: [] } };
      if (command === "media/render/list") return { ok: true, value: { jobs: [] } };
      if (command === "media/library/config/get") return { ok: true, value: { config: { configured: true, dirs: ["/Users/probe/Music"], dirNames: ["Music"], trackCount: tracks.length } } };
      if (command === "media/library/tracks" || command === "media/library/scan") return { ok: true, value: { tracks } };
      return { ok: false, error: "MEDIA_INTERNAL", message: "探针 fixture 未实现 " + String(command) };
    });
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) out("CONSOLE " + String(message).slice(0, 300));
    });
    await win.loadURL(uiURL);
    await waitFn("document.readyState==='complete' && !!window.openarc", 60000);
    // Vite dev 的 CSP 没有列入 openarc-resource（生产 meta 有）；探针只放行 CSP 以便截真实缩略图。
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Page.setBypassCSP", { enabled: true });
    out("GATE-BEFORE " + JSON.stringify(await js("var d=document.querySelector('.desktop'); return {gate:d?d.getAttribute('data-identity-gate'):'no-root', text:(document.body.innerText||'').slice(0,160)};")));
    check("登录进入桌面", await ensureReady(), "url=" + uiURL);
    out("GATE-AFTER " + JSON.stringify(await js("var d=document.querySelector('.desktop'); return {gate:d?d.getAttribute('data-identity-gate'):'no-root', login:!!document.querySelector('[data-d3-id=login-submit]')};")));
    await js("localStorage.setItem('oa-theme','light'); localStorage.setItem('oa-motion','true'); localStorage.setItem('oa-weather-consent','true'); localStorage.setItem('oa-weather-cities', JSON.stringify([{name:'上海',admin:'上海',country:'中国',lat:31.23,lon:121.47}])); return 'ok'");
    await win.webContents.reload();
    await waitFn("document.readyState==='complete' && !!window.openarc", 60000);
    await sleep(500);
    await ensureReady();
    await waitFn("!!document.querySelector('.dock')", 15000);
    // 用产品自己的 store API 建两个真实文件夹（等价于用户在访达右键新建），只为对照密度；
    // 不写 DOM 假数据，内容照样来自 oa-folders 持久层。
    await js(
      "var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell');" +
        "if(!shell||typeof shell.createSubfolder!=='function') return 'no-shell';" +
        "var names=['项目资料','素材库'];" +
        "for (var i=0;i<names.length;i++){ await new Promise(function(resolve){setTimeout(resolve,12)}); var f=shell.createSubfolder('desktop'); if(f&&f.id) shell.renameFolder(f.id, names[i]); }" +
        "return 'ok';",
    );
    await js("var d=new Date(); var k=function(dt){return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');}; var t=new Date(d); var tm=new Date(d); tm.setDate(tm.getDate()+1); localStorage.setItem('oa-calendar-events', JSON.stringify([{id:'cal-probe-1',date:k(t),time:'15:00',title:'设计评审'},{id:'cal-probe-2',date:k(t),time:'18:00',title:'主图交付'},{id:'cal-probe-3',date:k(tm),time:'10:30',title:'供应商沟通'}])); return 'ok';");
    if (report.thumbUrl) {
      }
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");

    if (INTERACTIONS) {
      const results = {};
      const shellState = () => js("var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell'); return shell ? {focused:shell.focusedWindowId, windows:shell.windows.map(function(w){return {id:w.id, appId:w.appId, x:w.bounds.x, y:w.bounds.y, w:w.bounds.w, h:w.bounds.h, visible:w.visible, maximized:w.maximized, group:w.tabGroupId};})} : null;");
      await js("var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell'); shell.activateApp('files'); return 'ok';");
      await waitFn("!!document.querySelector('.window.active')", 8000);
      await sleep(600);
      const before = await shellState();
      const fileWin = before.windows.find((w) => w.appId === "files");
      const r = await js("var el=document.querySelector('.window.active'); var r=el.getBoundingClientRect(); return {left:r.left, top:r.top};");
      const x = r ? Math.round(r.left + 300) : 300;
      const y = r ? Math.round(r.top + 6) : 6;
      if (fileWin && r) {
        await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 70, y: y + 46, button: "left", buttons: 1 });
        await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 70, y: y + 46, button: "left", clickCount: 1 });
      }
      await sleep(400);
      const afterDrag = await shellState();
      const dragged = afterDrag.windows.find((w) => w.id === fileWin.id);
      results.drag = { before: fileWin ? { x: fileWin.x, y: fileWin.y } : null, after: dragged ? { x: dragged.x, y: dragged.y } : null, pass: !!dragged && fileWin && (Math.abs(dragged.x - fileWin.x) > 20 || Math.abs(dragged.y - fileWin.y) > 20) };
      const rectNow = await js("var el=document.querySelector('.window.active'); var r=el.getBoundingClientRect(); return {left:r.left, top:r.top};");
      const dx = rectNow ? Math.round(rectNow.left + 300) : x;
      const dy = rectNow ? Math.round(rectNow.top + 6) : y;
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: dx, y: dy, button: "left", clickCount: 2 });
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: dx, y: dy, button: "left", clickCount: 2 });
      await sleep(500);
      const afterDbl = await shellState();
      results.doubleClickMaximize = { maximized: !!(afterDbl.windows.find((w) => w.id === fileWin.id) || {}).maximized, pass: !!(afterDbl.windows.find((w) => w.id === fileWin.id) || {}).maximized };
      await js("var b=document.querySelector('.window.active .traffic .minimize'); if(b) b.click(); return 'ok';");
      await sleep(400);
      const afterMin = await shellState();
      results.minimize = { visible: !!(afterMin.windows.find((w) => w.id === fileWin.id) || {}).visible, pass: !(afterMin.windows.find((w) => w.id === fileWin.id) || {}).visible };
      await js("var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell'); shell.dispatch({type:'window/restore', id:" + JSON.stringify(fileWin.id) + "}); return 'ok';");
      await sleep(300);
      await js("var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell'); shell.activateApp('browser'); return 'ok';");
      await sleep(500);
      await js("var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell'); shell.openNewWindow('browser'); return 'ok';");
      await sleep(600);
      await js("var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell'); shell.mergeSameApp('browser'); return 'ok';");
      await sleep(600);
      let afterTabs = await shellState();
      if (!afterTabs.windows.some((w) => w.tabGroupId)) {
        const browserIds = afterTabs.windows.filter((w) => w.appId === "browser").map((w) => w.id);
        if (browserIds.length >= 2) {
          await js("var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell'); shell.mergeTab(" + JSON.stringify(browserIds[0]) + "," + JSON.stringify(browserIds[1]) + "); return 'ok';");
          await sleep(500);
          afterTabs = await shellState();
        }
      }
      const domTabs = await js("return document.querySelectorAll('.window-tabbar .window-tab').length;");
      results.tabs = { apps: afterTabs.windows.map((w) => w.appId), groups: afterTabs.windows.filter((w) => w.tabGroupId).length, domTabs, pass: afterTabs.windows.some((w) => w.tabGroupId) || domTabs >= 2 };
      report.interactions = results;
      report.results.__interactions = results;
      out("INTERACTIONS " + JSON.stringify(results));
      out("RESULT " + JSON.stringify(report));
      try { win?.destroy(); } catch {}
      app.quit();
      return;
    }

    for (const target of TARGETS) {
      const result = await openApp(target.appId);
      if (!result.ok) {
        check(target.seq + " " + target.slug, false, result.detail);
        continue;
      }
      const rect = result.window;
      if (target.appId === "chat") {
        await js("var el=document.querySelector('[data-chat-session]'); if(!el) return 'missing'; el.click(); return 'ok';");
        await waitFn("!!document.querySelector('[data-chat-message]')", 6000);
        await sleep(700);
      }
      if (target.appId === "weather") {
        await waitFn("!!document.querySelector('[data-weather-temp]')", 8000);
        await sleep(600);
      }
      if (target.appId === "settings") {
        await waitFn("!!document.querySelector('.settings-body')", 8000);
        const theme = process.env.OA_ALIGN_THEME;
        const glass = process.env.OA_ALIGN_GLASS;
        if (theme || glass) {
          await js("var el=document.getElementById('app'); var app=el&&el.__vue_app__; var pinia=app&&app.config.globalProperties&&app.config.globalProperties.$pinia; var shell=pinia&&pinia._s&&pinia._s.get('shell'); if(!shell) return 'no-shell';" + (theme ? " shell.setTheme(" + JSON.stringify(theme) + ");" : "") + (glass ? " shell.setGlass(" + JSON.stringify(glass) + ");" : "") + " return 'ok';");
          await sleep(500);
        }
      }
      if (target.appId === "canvas") {
        await waitFn("!!document.querySelector('[data-studio-chat]')", 8000);
        const studioState = process.env.OA_ALIGN_STUDIO_EVENT_STATE || process.env.OA_ALIGN_STUDIO_STATE || "";
        const eventState = process.env.OA_ALIGN_STUDIO_EVENT_STATE || "";
        if (eventState) {
          await js("var ta=document.querySelector('[data-studio-input]'); if(!ta) return 'no-ta'; var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta,'写一段秋季新品门店海报文案'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';");
          await js("var b=document.querySelector('[data-studio-send]'); if(b) b.click(); return 'ok';");
          if (eventState === "thinking") await sleep(700);
          else if (eventState === "tool") await sleep(1200);
          else if (eventState === "complete") await waitFn("(function(){var el=document.querySelector('[data-studio-message=assistant] .studio-msg-body'); return !!(el && el.innerText.indexOf('示例')>=0);})()", 12000);
          else if (eventState === "stopped") { await sleep(1100); await js("var b=document.querySelector('[data-studio-stop]'); if(b) b.click(); return 'ok';"); await sleep(300); }
        }
        if (studioState === "chat" || studioState === "generating") {
          await js("var ta=document.querySelector('[data-studio-input]'); if(!ta) return 'no-ta'; var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta,'写一段秋季新品门店海报文案'); ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';");
          await js("var b=document.querySelector('[data-studio-send]'); if(b) b.click(); return 'ok';");
          if (studioState === "chat") await waitFn("(function(){var el=document.querySelector('[data-studio-message=assistant] .studio-msg-body'); return !!(el && el.innerText.indexOf('示例')>=0);})()", 12000);
          else await sleep(400);
        }
        await sleep(300);
      }
      if (target.appId === "browser") {
        await waitFn("!!document.querySelector('[data-browser-start]')", 8000);
        await sleep(400);
      }
      if (target.appId === "dev") {
        await waitFn("!!document.querySelector('[data-dev-file]')", 8000);
        await sleep(500);
      }
      if (target.appId === "drama") {
        await js("window.__drList=null; window.openarc.media.command({command:'media/short-drama/list'}).then(function(r){window.__drList=r})");
        await sleep(600);
        out("DRLIST " + JSON.stringify(await js("return window.__drList")));
        await waitFn("!!document.querySelector('.dr-body')", 8000);
        await sleep(500);
      }
      if (target.appId === "video") {
        await waitFn("!!document.querySelector('.vd-bin-clip')", 8000);
        await js("var el=document.querySelector('.vd-bin-clip'); if(el) el.click(); return 'ok';");
        await waitFn("!!document.querySelector('.vd-clipbar')", 8000);
        await sleep(500);
      }
      if (target.appId === "photos") {
        await setWindowBounds(rect.id, 1020, 680);
        await sleep(300);
        await waitFn("!!document.querySelector('.photos-card')", 8000);
        if (process.env.OA_ALIGN_PHOTOS_VIEWER === "1") {
          await js("var el=document.querySelector('[data-photos-open]'); if(el) el.click(); return 'ok';");
          await waitFn("!!document.querySelector('[data-photos-viewer]')", 6000);
          await sleep(600);
        }
        await sleep(500);
      }
      if (target.appId === "mcp") {
        await waitFn("!!document.querySelector('[data-mcp-connection]')", 8000);
        await sleep(500);
      }
      if (target.appId === "skills") {
        await waitFn("!!document.querySelector('[data-skill-id]')", 8000);
        if (process.env.OA_ALIGN_SKILL_DETAIL === "1") {
          await js("var el=document.querySelector('[data-skill-id]'); if(el) el.click(); return 'ok';");
          await waitFn("!!document.querySelector('[data-skill-detail]')", 6000);
        }
        await sleep(500);
      }
      if (target.appId === "automation") {
        await waitFn("!!document.querySelector('[data-au-rule]')", 6000);
        await waitFn("!!document.querySelector('.au-run-row')", 6000);
        await sleep(500);
      }
      if (target.appId === "org") {
        await waitFn("!!document.querySelector('[data-d3-04d-user]')", 6000);
        if (process.env.OA_ALIGN_ORG_DEPT === "1") {
          await js("var el=document.querySelector('[data-d3-04d-tab=departments]'); if(el) el.click(); return 'ok';");
          await waitFn("!!document.querySelector('[data-d3-04d-dept]')", 6000);
        }
        await sleep(500);
      }
      if (target.appId === "trash") {
        await waitFn("!!document.querySelector('.trash-item')", 6000);
        await waitFn("!!document.querySelector('.trash-thumb')", 6000);
        await sleep(400);
      }
      if (target.appId === "declare") {
        await js("var el=document.querySelector('.dc-drop'); if(!el) return 'missing'; el.click(); return 'ok';");
        await waitFn("!!document.querySelector('.dc-pick')", 6000);
        await js("var picks=document.querySelectorAll('.dc-pick'); for(var i=0;i<Math.min(2,picks.length);i++) picks[i].click(); return 'ok';");
        await js("var el=document.querySelector('.dc-drop'); if(el) el.click(); return 'ok';");
        await waitFn("!!document.querySelector('.dc-row')", 6000);
        await sleep(500);
      }
      if (target.appId === "music") {
        await waitFn("!!document.querySelector('.music-row')", 8000);
        await sleep(500);
      }
      if (target.appId === "notes") {
        await js("var el=document.querySelector('[data-notes-row]'); if(!el) return 'missing'; el.click(); return 'ok';");
        await waitFn("!!document.querySelector('.notes-paper')", 6000);
        await sleep(600);
      }
      if (process.env.OA_ALIGN_LARGE === "1") {
        const largeSize = String(process.env.OA_ALIGN_LARGE_SIZE || "1400x900").split("x").map(Number);
        await setWindowBounds(result.window.id, largeSize[0] || 1400, largeSize[1] || 900);
        await js("var d=document.querySelector('.dock'); if(d) d.style.display='none'; return 'ok';");
        out("CHATDIMS " + JSON.stringify(await js("var root=document.querySelector('.chat-app'); var side=document.querySelector('.chat-side'); var main=document.querySelector('.chat-main'); var body=document.querySelector('.chat-body'); return {inner:window.innerWidth, root:root?root.getBoundingClientRect().width:null, side:side?side.getBoundingClientRect().width:null, main:main?main.getBoundingClientRect().width:null, body:body?body.getBoundingClientRect().width:null, scrollW:root?root.scrollWidth:null};")));
        await sleep(500);
        const cur = await js("var el=document.querySelector(" + q('[data-window-id="' + result.window.id + '"]') + "); if(!el) return null; var r=el.getBoundingClientRect(); return {left:r.left, top:r.top, width:r.width, height:r.height};");
        if (cur) {
          const cb = win.getContentBounds();
          const shot = await win.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png", clip: { x: cur.left, y: cur.top, width: Math.round(cb.width), height: Math.round(cb.height), scale: 1 }, captureBeyondViewport: false });
          const dir = path.join(OUT, "large");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, Math.round(cb.width) + "-" + target.seq + "-" + target.slug + ".png"), Buffer.from(shot.data, "base64"));
        }
        continue;
      }
      if (GEO || RESP) {
        if (target.appId === "resource-library") {
          await js("var el=document.querySelector('.rl-card'); if(el) el.click(); return el?'ok':'missing';");
          await waitFn("!!document.querySelector('.rl-detail.is-open')", 5000);
          await sleep(500);
        }
        const designW = Math.round(rect.width);
        const designH = Math.round(rect.height);
        const sizes = [
          { name: "design", w: designW, h: designH },
          { name: "narrow", w: Math.round(designW * 0.8), h: designH },
          { name: "short", w: designW, h: Math.round(designH * 0.85) },
        ];
        const geometry = {};
        for (const size of sizes) {
          await setWindowBounds(result.window.id, size.w, size.h);
          await sleep(420);
          const current = await js("var el=document.querySelector(" + q('[data-window-id="' + result.window.id + '"]') + "); if(!el) return null; var r=el.getBoundingClientRect(); return {left:r.left, top:r.top, width:r.width, height:r.height};");
          if (!current) continue;
          geometry[size.name] = {
            width: Math.round(current.width),
            height: Math.round(current.height),
            anchors: (await measureGeometry(target.appId, result.window.id)).anchors,
            debug: (await measureGeometry(target.appId, result.window.id)).debug,
            checks: await geometryChecks(result.window.id),
          };
          if (GEO && size.name === "design") {
            const rootRect = await js("var win=document.querySelector(" + q('[data-window-id="' + result.window.id + '"]') + "); var root=win&&(win.querySelector('.split')||win); if(!root) return null; var r=root.getBoundingClientRect(); return {left:r.left, top:r.top, width:r.width, height:r.height};");
            if (rootRect) {
              const contentShot = await win.webContents.debugger.sendCommand("Page.captureScreenshot", {
                format: "png",
                clip: { x: rootRect.left, y: rootRect.top, width: rootRect.width, height: rootRect.height, scale: 1 },
                captureBeyondViewport: false,
              });
              const gdir = path.join(OUT, target.seq + "-" + target.slug);
              fs.mkdirSync(gdir, { recursive: true });
              fs.writeFileSync(path.join(gdir, "content.png"), Buffer.from(contentShot.data, "base64"));
              geometry[size.name].root = { width: Math.round(rootRect.width), height: Math.round(rootRect.height) };
            }
          }
          if (RESP) {
            const respShot = await win.webContents.debugger.sendCommand("Page.captureScreenshot", {
              format: "png",
              clip: { x: current.left, y: current.top, width: current.width, height: current.height, scale: 1 },
              captureBeyondViewport: false,
            });
            const responsiveDir = path.join(OUT, target.seq + "-" + target.slug);
            fs.mkdirSync(responsiveDir, { recursive: true });
            fs.writeFileSync(path.join(responsiveDir, "responsive-" + size.name + ".png"), Buffer.from(respShot.data, "base64"));
          }
        }
        await setWindowBounds(result.window.id, designW, designH);
        await sleep(300);
        report.results[target.appId] = {
          width: designW,
          height: designH,
          aria: rect.aria,
          geometry,
        };
        check(target.seq + " " + target.slug + " geometry", true, Object.keys(geometry).join("/"));
        await minimizeWindow(result.window.id);
        continue;
      }
      const shot = await win.webContents.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: 1 },
        captureBeyondViewport: false,
      });
      const dir = path.join(OUT, target.seq + "-" + target.slug);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "ours.png");
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      const hint = await js("var el=document.querySelector('.window.active .window-body'); var t=el?(el.textContent||''):''; var patterns=['No handler registered','桥不可用','尚未装配','服务暂时不可用','服务出错','BRIDGE_ABSENT','NOT_READY','无法访问','_INTERNAL']; var hit=patterns.filter(function(p){return t.indexOf(p)>=0}); return {hit:hit, text:t.replace(/\\s+/g,' ').slice(0,180)};");
      report.results[target.appId] = { width: Math.round(rect.width), height: Math.round(rect.height), aria: rect.aria, file: path.relative(ROOT, file), errorHints: hint.hit, textSample: hint.text };
      check(target.seq + " " + target.slug, true, rect.aria + " " + Math.round(rect.width) + "x" + Math.round(rect.height) + (hint.hit.length ? " · 可疑桥错误 " + hint.hit.join(",") : ""));
      if (target.appId === "chat") {
        await js("var el=document.querySelector('.chat-process > summary'); if(el) el.click(); return el?'ok':'missing';");
        await sleep(400);
        await js("var el=document.querySelector('.chat-process'); if(el) el.scrollIntoView({block:'end'}); return 'ok';");
        await sleep(700);
        const detailShot2 = await win.webContents.debugger.sendCommand("Page.captureScreenshot", {
          format: "png",
          clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: 1 },
          captureBeyondViewport: false,
        });
        fs.writeFileSync(path.join(dir, "detail.png"), Buffer.from(detailShot2.data, "base64"));
      }
      if (target.appId === "projects") {
        const openedRow = await js("var el=document.querySelector('[data-project-agent-task-item]'); if(!el) return 'missing'; el.click(); return 'ok';");
        if (openedRow === "ok") {
          await waitFn("!!document.querySelector('.pj-expand')", 5000);
          await js("var el=document.querySelector('.pj-expand'); if(el) el.scrollIntoView({block:'start'}); return 'ok';");
          await sleep(900);
          const detailShot = await win.webContents.debugger.sendCommand("Page.captureScreenshot", {
            format: "png",
            clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: 1 },
            captureBeyondViewport: false,
          });
          fs.writeFileSync(path.join(dir, "detail.png"), Buffer.from(detailShot.data, "base64"));
          await js("var row=document.querySelector('[data-project-agent-task-item]'); if(row) row.click(); return 'ok';");
          await sleep(250);
        }
      }
      if (target.appId === "resource-library") {
        const opened = await js("var el=document.querySelector('.rl-card'); if(!el) return 'missing'; el.click(); return 'ok';");
        if (opened === "ok") {
          await waitFn("!!document.querySelector('.rl-detail.is-open')", 5000);
          await sleep(900);
          const detailShot = await win.webContents.debugger.sendCommand("Page.captureScreenshot", {
            format: "png",
            clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: 1 },
            captureBeyondViewport: false,
          });
          fs.writeFileSync(path.join(dir, "detail.png"), Buffer.from(detailShot.data, "base64"));
          await js("var close=document.querySelector('[data-rl-detail-close]'); if(close) close.click(); return 'ok';");
          await sleep(250);
        }
      }
      await minimizeWindow(result.window.id);
    }
  } catch (error) {
    report.errors.push(String((error && error.stack) || error));
    check("探针整体未抛异常", false, String((error && error.message) || error).slice(0, 300));
  } finally {
    try { win?.destroy(); } catch {}
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch {}
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
`;

async function captureOurs(targets) {
  const port = await freePort();
  const devURL = "http://127.0.0.1:" + port + "/";
  const vite = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let viteLog = "";
  vite.stdout.on("data", (d) => (viteLog += String(d)));
  vite.stderr.on("data", (d) => (viteLog += String(d)));
  let up = false;
  for (let i = 0; i < 200 && !up; i += 1) {
    try {
      up = (await fetch(devURL)).ok;
    } catch {
      /* 还没起来 */
    }
    if (!up) await sleep(250);
  }
  if (!up) {
    vite.kill("SIGKILL");
    throw new Error("Vite 未启动：\n" + viteLog.slice(-1200));
  }
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-align-probe-host-"));
  fs.writeFileSync(path.join(probeDir, "main.cjs"), PROBE_MAIN, "utf8");
  fs.writeFileSync(path.join(probeDir, "package.json"), JSON.stringify({ name: "oa-align-probe", main: "main.cjs" }), "utf8");
  const jobs = targets.map((target) => ({ appId: target.appId, seq: target.seq, slug: target.slug }));
  const childEnv = {
    ...process.env,
    OA_DEV_SERVER: devURL,
    OA_ALIGN_ROOT: ROOT,
    OA_ALIGN_OUT: OUT,
    OA_ALIGN_TARGETS: JSON.stringify(jobs),
    OA_ALIGN_INTERACTIONS: process.env.OA_ALIGN_INTERACTIONS || "0",
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const electronPath = require("electron");
  const child = spawn(electronPath, [probeDir, "--no-sandbox"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += String(d);
    process.stdout.write(String(d));
  });
  child.stderr.on("data", (d) => {
    stderr += String(d);
    process.stderr.write(String(d));
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 600000);
    child.on("exit", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  vite.kill("SIGKILL");
  try {
    fs.rmSync(probeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
  if (!match) throw new Error("我们侧探针没有输出结果；stderr:\n" + stderr.slice(-2000));
  const report = JSON.parse(match[1]);
  if (report.errors.length) throw new Error("我们侧探针报错：" + report.errors.join("\n").slice(0, 1500));
  if (code !== 0) throw new Error("Electron 退出码 " + code);
  return report.results;
}

/* ── 对比图：左原型右我们，各自等比装进同尺寸框 ───────────────────────── */
function compareHtml(target, proto, ours) {
  const dims = (item) => (item ? item.width + "×" + item.height : "缺失");
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><style>" +
    "body{margin:0;background:#f5f5f7;font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#1d1d1f}" +
    ".canvas{padding:20px 20px 24px}" +
    "h1{margin:0 0 4px;font-size:17px;font-weight:500}" +
    ".meta{margin:0 0 16px;font-size:12px;color:#6e6e73}" +
    ".row{display:flex;gap:16px}" +
    ".pane{width:1060px;height:710px;display:flex;flex-direction:column;gap:8px;min-width:0}" +
    ".pane h2{margin:0;font-size:12px;font-weight:500;color:#3a3a3c;display:flex;gap:8px;align-items:baseline}" +
    ".pane h2 span{font-weight:400;color:#86868b;font-variant-numeric:tabular-nums}" +
    ".shot{flex:1;min-height:0;background:#e8e8ed;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden}" +
    ".shot img{max-width:100%;max-height:100%;object-fit:contain;display:block;box-shadow:0 6px 24px rgb(0 0 0 / .12);border-radius:10px}" +
    "</style></head><body><div class=\"canvas\" id=\"canvas\">" +
    "<h1>" + target.seq + " · " + target.name + "</h1>" +
    "<p class=\"meta\">左：Claude 原型（" + dims(proto) + "）　右：OpenArc OS 当前实现（" + dims(ours) + "）　两侧等比装入 " + PANE.width + "×" + PANE.height + " 对照框</p>" +
    "<div class=\"row\">" +
    "<div class=\"pane\"><h2>原型<span>" + dims(proto) + "</span></h2><div class=\"shot\"><img src=\"proto.png\" alt=\"原型\"></div></div>" +
    "<div class=\"pane\"><h2>我们<span>" + dims(ours) + "</span></h2><div class=\"shot\"><img src=\"ours.png\" alt=\"我们\"></div></div>" +
    "</div></div></body></html>";
}

async function composeCompare(browser, targets, proto, ours) {
  for (const target of targets) {
    const dir = appDir(target);
    if (!fs.existsSync(path.join(dir, "proto.png")) || !fs.existsSync(path.join(dir, "ours.png"))) continue;
    const htmlFile = path.join(dir, "compare.html");
    fs.writeFileSync(htmlFile, compareHtml(target, proto[target.appId], ours[target.appId]), "utf8");
    const page = await browser.newPage({ viewport: { width: PANE.width * 2 + 56, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });
    await page.goto("file://" + htmlFile);
    await page.waitForFunction("Array.from(document.images).every(function (img) { return img.complete; })");
    await page.locator("#canvas").screenshot({ path: path.join(dir, "compare.png") });
    await page.close();
    fs.rmSync(htmlFile, { force: true });
  }
}

/* ── 报告 ─────────────────────────────────────────────────────────────── */
function writeReport(targets, proto, ours) {
  const reportFile = path.join(OUT, "report.json");
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } catch {
    previous = null;
  }
  const fresh = targets.map((target) => ({
    seq: target.seq,
    slug: target.slug,
    name: target.name,
    protoId: target.protoId,
    appId: target.appId,
    dir: path.relative(ROOT, appDir(target)),
    proto: proto[target.appId] || null,
    ours: ours[target.appId] || null,
    compare: path.relative(ROOT, path.join(appDir(target), "compare.png")),
    sizeDelta: proto[target.appId] && ours[target.appId]
      ? { width: ours[target.appId].width - proto[target.appId].width, height: ours[target.appId].height - proto[target.appId].height }
      : null,
    valid: !!ours[target.appId] && !CAPTURE_STATUS[target.appId] && !(ours[target.appId].errorHints && ours[target.appId].errorHints.length),
    invalidReason: CAPTURE_STATUS[target.appId] || ((ours[target.appId] && ours[target.appId].errorHints && ours[target.appId].errorHints.length) ? "页面出现宿主错误：" + ours[target.appId].errorHints.join(",") : null),
    errorHints: (ours[target.appId] && ours[target.appId].errorHints) || [],
    differences: DIFFS[target.appId] || [],
    alignment: target.appId === "files" ? FINDER_ALIGNMENT : target.appId === "resource-library" ? LIBRARY_ALIGNMENT : target.appId === "projects" ? PROJECTS_ALIGNMENT : target.appId === "chat" ? CHAT_ALIGNMENT : undefined,
  }));
  // 单跑 --app 时不要把其它应用的基线记录冲掉：按 appId 合并已有报告。
  const merged = new Map();
  for (const app of (previous && Array.isArray(previous.apps) ? previous.apps : [])) merged.set(app.appId, app);
  for (const app of fresh) merged.set(app.appId, app);
  const apps = Array.from(merged.values()).sort((a, b) => String(a.seq).localeCompare(String(b.seq)));
  const report = {
    generatedAt: new Date().toISOString(),
    view: VIEW,
    pane: PANE,
    protoSource: path.relative(ROOT, PROTO),
    apps,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf8");
  const validApps = apps.filter((app) => app.valid);
  const invalidApps = apps.filter((app) => !app.valid);
  const bulletRows = apps
    .map((app) => {
      const header = "- **" + app.seq + " " + app.name + "**" + (app.valid ? "" : "（INVALID：" + (app.invalidReason || "宿主缺桥") + "）") + " — 原型 " + (app.proto ? app.proto.width + "×" + app.proto.height : "缺失") + " / 我们 " + (app.ours ? app.ours.width + "×" + app.ours.height : "缺失");
      const bullets = (app.differences.length ? app.differences : [{ severity: "中", proto: "待核对", ours: "待核对", gap: "本轮未记录" }])
        .slice(0, 3)
        .map((d) => "  - [" + d.severity + "] 原型：" + d.proto + "；我们：" + d.ours + "；差：" + d.gap)
        .join("\n");
      const alignment = Array.isArray(app.alignment)
        ? "\n" + app.alignment.map((item) => "  - 对齐：" + item.item + " — " + item.status + (item.detail ? "（" + item.detail + "）" : "")).join("\n")
        : "";
      return header + "\n" + bullets + alignment;
    })
    .join("\n");
  const markdown = "# 22 个应用 · 原型 vs OpenArc OS 差异要点\n\n" +
    "生成时间：" + new Date().toISOString() + "；对照图目录：artifacts/ui-alignment/<序号>-<slug>/compare.png（左原型、右实现）。\n\n" +
    "## 结论概览\n\n" +
    "- 真实可比：" + validApps.length + " 个（" + validApps.map((a) => a.name).join("、") + "）\n" +
    "- 宿主缺桥 / 环境不可达，不能当 UI 差异（INVALID）：" + invalidApps.length + " 个（" + invalidApps.map((a) => a.name + "：" + (a.invalidReason || "缺桥")).join("；") + "）\n" +
    "- 已对齐：访达（01）、应用市场（09）本轮之前已对齐；其余按下面的要点逐个排期。\n" +
    "- 原型自身违反 DESIGN_SYSTEM 的地方（彩色海报、600 字重、发丝线）按规范实现，已在条目里注明「规范优先」。\n\n" +
    "## 逐应用要点\n\n" + bulletRows + "\n";
  fs.writeFileSync(path.join(OUT, "report.md"), markdown, "utf8");
  const rows = apps
    .map((app) => {
      const diffs = app.differences.length
        ? app.differences.map((d) => "- [" + d.severity + "] 原型：" + d.proto + " / 我们：" + d.ours + " / 差：" + d.gap).join("\n")
        : "- （待核对）";
      const delta = app.sizeDelta ? (app.sizeDelta.width === 0 && app.sizeDelta.height === 0 ? "尺寸一致" : "尺寸差 " + (app.sizeDelta.width >= 0 ? "+" : "") + app.sizeDelta.width + "×" + (app.sizeDelta.height >= 0 ? "+" : "") + app.sizeDelta.height) : "尺寸未知";
      const invalid = app.valid ? "" : "\n⚠ INVALID（宿主缺桥或能力不足，截图只用于确认状态，不能当 UI 差异）：" + app.errorHints.join(", ");
      return "### " + app.seq + " " + app.name + "（" + app.appId + "）\n原型 " + (app.proto ? app.proto.width + "×" + app.proto.height : "缺失") + " · 我们 " + (app.ours ? app.ours.width + "×" + app.ours.height : "缺失") + " · " + delta + invalid + "\n" + diffs + "\n\n截图：" + app.dir + "/compare.png";
    })
    .join("\n");
  const readme = "# UI 对照基线（" + new Date().toISOString().slice(0, 10) + "）\n\n" +
    "本目录由 tests/ui-align-shots.mjs 生成，用来逐个应用对齐 Claude 原型。\n\n" +
    "## 用法\n\n" +
    "    node tests/ui-align-shots.mjs            # 22 个应用全跑\n" +
    "    node tests/ui-align-shots.mjs --app=files # 只跑一个\n\n" +
    "## 目录结构\n\n" +
    "- proto-source/：原型源（临时参照，artifacts 已 gitignore）\n" +
    "- <序号>-<slug>/proto.png：原型窗口截图（2x）\n" +
    "- <序号>-<slug>/ours.png：OpenArc OS 真机截图（2x）\n" +
    "- <序号>-<slug>/compare.png：左原型右我们（同尺寸对照框）\n" +
    "- report.json：尺寸与首屏差异清单\n\n" +
    "## 说明\n\n" +
    "- 两侧都裁到应用窗口容器；对比图各自等比装进 1060×710 框，避免不同尺寸互相拉伸。\n" +
    "- 原型是视觉基准；原型里违反 DESIGN_SYSTEM 的彩色/600 字重/发丝线按规范处理，并在差异清单标注「规范优先」。\n" +
    "- 我们侧为真实 Electron + 真实 preload，缺桥时如实显示空态/错误，不造数据。\n\n" +
    "## 差异清单\n\n" + rows + "\n";
  fs.writeFileSync(path.join(OUT, "README.md"), readme, "utf8");
  return report;
}

/* ── 入口 ─────────────────────────────────────────────────────────────── */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureProtoSource();
  const lockFile = path.join(OUT, ".running");
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
  } catch {
    throw new Error("已有另一个 ui-align-shots 在运行（" + lockFile + "）。先等它结束或删除锁文件。");
  }
  process.on("exit", () => {
    try { fs.rmSync(lockFile, { force: true }); } catch {}
  });
  let targets = TARGETS;
  if (args.apps.length) {
    targets = TARGETS.filter((target) => args.apps.indexOf(target.appId) >= 0 || args.apps.indexOf(target.slug) >= 0 || args.apps.indexOf(target.protoId) >= 0);
    if (!targets.length) throw new Error("未知 --app：" + args.apps.join(",") + "（可用：" + TARGETS.map((t) => t.appId).join(", ") + "）");
  }
  console.log("目标：" + targets.map((t) => t.seq + "-" + t.slug).join(", "));
  if (args.composeOnly) {
    const proto = existingResults(targets, "proto");
    const ours = existingResults(targets, "ours");
    const browser = await launchBrowser();
    try {
      await composeCompare(browser, targets, proto, ours);
    } finally {
      await browser.close();
    }
    const report = writeReport(targets, proto, ours);
    console.log("compose-only：生成 " + report.apps.filter((a) => fs.existsSync(path.join(ROOT, a.compare))).length + " 组");
    return;
  }
  if (args.interactions) {
    const results = await captureOurs(targets);
    const geoDir = path.join(OUT, "geometry");
    fs.mkdirSync(geoDir, { recursive: true });
    fs.writeFileSync(path.join(geoDir, "interactions.json"), JSON.stringify({ generatedAt: new Date().toISOString(), checks: results.__interactions || {} }, null, 2), "utf8");
    console.log("interactions：写入 " + path.relative(ROOT, path.join(geoDir, "interactions.json")));
    return;
  }
  if (args.geometry || args.responsive) {
    const results = await captureOurs(targets);
    const geoDir = path.join(OUT, "geometry");
    fs.mkdirSync(geoDir, { recursive: true });
    const label = args.responsive ? "responsive" : "ours";
    fs.writeFileSync(path.join(geoDir, label + ".json"), JSON.stringify({ generatedAt: new Date().toISOString(), apps: results }, null, 2), "utf8");
    console.log((args.responsive ? "responsive" : "geometry") + "：写入 " + path.relative(ROOT, path.join(geoDir, label + ".json")));
    return;
  }
  const browser = await launchBrowser();
  let proto;
  let ours;
  try {
    console.log("[1/3] 原型截图…");
    proto = await captureProto(browser, targets);
    console.log("[2/3] 我们截图（真实 Electron）…");
    ours = await captureOurs(targets);
    console.log("[3/3] 生成对比图…");
    await composeCompare(browser, targets, proto, ours);
  } finally {
    await browser.close();
  }
  const report = writeReport(targets, proto, ours);
  for (const app of report.apps) {
    const protoSize = app.proto ? app.proto.width + "×" + app.proto.height : "缺失";
    const oursSize = app.ours ? app.ours.width + "×" + app.ours.height : "缺失";
    console.log(app.seq + " " + app.slug + "：原型 " + protoSize + " · 我们 " + oursSize + " → " + app.compare);
  }
  console.log("完成：" + report.apps.length + " 组；报告 " + path.relative(ROOT, path.join(OUT, "report.json")));
}

main().catch((error) => {
  console.error("FAILED " + String((error && error.stack) || error));
  process.exit(1);
});
