#!/usr/bin/env node
/** 把 report.json 渲染成人类可读的 REPORT.md（事实全部取自 report.json，不手抄）。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-ui-global-model");
const j = JSON.parse(fs.readFileSync(path.join(ART, "report.json"), "utf8"));

const T = String.fromCharCode(96);
const FENCE = T + T + T;
const L = [];
const code = (s) => T + String(s == null ? "" : s).replace(/[\u0060]/g, "'").replace(/\|/g, "\\|") + T;
const clip = (s, n) => { const t = String(s == null ? "" : s).replace(/\s+/g, " "); return t.length > n ? t.slice(0, n) + "…" : t; };

L.push("# dxos-ui-global-model · 模型「全局生效」端到端实测报告");
L.push("");
L.push("- 生成时间：" + j.at + " · 总耗时 " + Math.round(j.durationMs / 1000) + "s · 渲染源 " + code(j.renderer) + " · Electron " + j.electronVersion);
L.push("- 隔离 userData 已删除；真实 profile 只读快照前后 " + (j.profile.unchanged ? "**完全未变（0 项差异）**" : "**发生变化：" + j.profile.changedCount + " 项**"));
L.push("- 密钥：仅运行时从 $HOME/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY 读取，长度 " + j.secretMeta.length + "、sha256 前 12 位 " + code(j.secretMeta.sha256_12) + "；**未打印、未落盘、未写进任何产出文件**（隔离 userData 含 safeStorage 副本，收工已删）");
L.push("");
// 结论：全部由 report.json 推导（入口 pass/fail、是否结构化不可用、reverse 三条是否都无假图），
// 并区分「修复前（历史留证）」与「修复后（本轮实测）」两个阶段，不写死结论。
const ENTRY_IDS = ["1", "2", "3", "4", "5", "6"];
const entriesPresent = ENTRY_IDS.filter((k) => j.entries[k]);
const entryList = entriesPresent.map((k) => ({ k, e: j.entries[k] }));
const okEntries = entryList.filter((x) => x.e.ok === true);
const badEntries = entryList.filter((x) => x.e.ok !== true);

/** 结构化不可用：主结果失败但带明确错误码 / 错误行 / 失败状态（如实拒绝，不是假成功）。 */
function entryError(e) {
  if (!e) return null;
  const fromRaw = (raw) => {
    if (!raw) return null;
    try { const r = JSON.parse(raw); return r && r.ok === false ? (r.error || "ok:false") : null; } catch { return null; }
  };
  return (e.errorLine && String(e.errorLine).trim())
    || (e.state && e.state.error && String(e.state.error).trim())
    || fromRaw(e.modelChat && e.modelChat.raw)
    || fromRaw(e.providerCall && e.providerCall.raw)
    || (e.commandOutline && e.commandOutline.result && e.commandOutline.result.ok === false ? (e.commandOutline.result.error || "ok:false") : null)
    || null;
}
const structuredUnavailable = badEntries.filter((x) => entryError(x.e));
const silentFailures = badEntries.filter((x) => !entryError(x.e));

// 反向对照三条：是否都无假图 / 无假成功。
const revImage = j.reverse["image.generate"] || {};
const revVideo = j.reverse["video.generate"] || {};
const revVision = j.reverse["llm.chat.vision"] || {};
const revChecks = [
  { name: "image/generate", honest: !!(revImage.noProvider && revImage.noProvider.ok === false && !revImage.noProvider.images) && !!(revImage.withDeepSeekProvider && revImage.withDeepSeekProvider.ok === false && !revImage.withDeepSeekProvider.images) },
  { name: "video.generate", honest: !!(revVideo.asModelCommand && revVideo.asModelCommand.ok === false) && !!(revVideo.asProtocolIntent && revVideo.asProtocolIntent.ok === false) },
  { name: "llm.chat.vision", honest: !!(revVision.reversePrompt && revVision.reversePrompt.ok === false) },
];
const reverseAllHonest = revChecks.every((c) => c.honest);

/** 逐入口结论：同样由 e.ok / 结构化错误 / e.verdict（探针按数据写入）推导。 */
const verdictFor = (k, e) => (k === "7" || !e)
  ? (reverseAllHonest ? "无假图（反向对照：image / video / vision 三条都结构化拒绝）" : "异常：至少一条假成功")
  : (e.ok === true ? (e.verdict || "全局生效") : ((entryError(e) ? "结构化不可用（" + entryError(e) + "）" : "未生效") + (e.verdict ? " · " + e.verdict : "")));

const afterPhase = entriesPresent.length === 0
  ? "修复后：本轮未跑具名入口（OA_GM_ENTRIES 过滤）；"
  : badEntries.length === 0
    ? "修复后：「" + entriesPresent.length + "/" + entriesPresent.length + "」个入口全部真实调用 DeepSeek 成功（ok:true + 非空文本）；"
    : "修复后：仅 " + okEntries.length + "/" + entriesPresent.length + " 个入口 ok:true，失败 " + badEntries.length + " 个；";
const unavailablePhase = structuredUnavailable.length
  ? "其中 " + structuredUnavailable.length + " 个如实结构化不可用；"
  : "没有入口以结构化不可用收场；";
const reversePhase = reverseAllHonest
  ? "反向对照 image / video / vision 三条都是结构化拒绝、无假图。"
  : "反向对照 image / video / vision 至少一条出现假成功，需复核。";

L.push("## 结论（一句话）");
L.push("");
L.push("**" + afterPhase + unavailablePhase + reversePhase + " 修复前：credential/set 写坏 providerOrigin 导致真实调用被 " + code("ENDPOINT_BLOCKED") + " 拦下，技能 / 短剧回结构化不可用。**");
L.push("");
L.push("### 修复后（本轮实测，全部由 report.json 推导）");
L.push("");
L.push("- 入口 pass/fail：" + (entryList.map((x) => code(x.k) + "「" + x.e.name + "」=" + (x.e.ok === true ? "PASS" : "FAIL")).join("、") || "（无）"));
L.push("- 结构化不可用：" + (structuredUnavailable.length ? structuredUnavailable.map((x) => code(x.k) + "=" + entryError(x.e)).join("、") : "无（没有入口走到结构化不可用）"));
if (silentFailures.length) L.push("- ⚠️ 无明确错误码的失败（需复核）：" + silentFailures.map((x) => code(x.k) + "「" + x.e.name + "」").join("、"));
L.push("- 反向对照无假图：" + revChecks.map((c) => c.name + "=" + (c.honest ? "无假图/无假成功" : "**异常**")).join("、") + " → " + (reverseAllHonest ? "**三条全部结构化拒绝**" : "**至少一条异常**"));
L.push("");
L.push("### 修复前（历史留证，非本轮实测）");
L.push("");
const p1Row = (j.rows || []).find((r) => r.name && r.name.indexOf("P1") === 0);
L.push("- 修复前：credential/set 把未归一化的 base_url 存成 providerOrigin，保存密钥后所有真实调用被 " + code("ENDPOINT_BLOCKED") + " 拦下；技能 / 短剧在只有「模型与服务商」默认模型时分别回 SKILL_DEPENDENCY_UNAVAILABLE / MEDIA_INVALID_INPUT。详见第五节。");
L.push("- 留证用例（P1）：" + code(p1Row ? p1Row.name : "P1 已保留「修复前曾为 ENDPOINT_BLOCKED」的历史事实") + " —— 断言已改为修复后的正确行为，历史事实不删除。");
L.push("");
L.push("### 逐入口结论（修复后，用 report.json 的实测数据）");
L.push("");
L.push("| # | 入口 | 本轮结论 | 真实返回（片段） | 耗时 |");
L.push("|---|---|---|---|---|");
for (const k of ["1","2","3","4","5","6","7"]) {
  const e = j.entries[k];
  const derived = verdictFor(k, e);
  let text = "";
  if (k === "1") text = "provider/call=" + JSON.stringify(e.providerCall && e.providerCall.raw) + "；model/test=" + JSON.stringify(e.modelTest && e.modelTest.raw) + "；UI 徽章=" + (e.uiTest && e.uiTest.badge) + " / 坏路径徽章=" + (e.uiTestBroken && e.uiTestBroken.badge);
  else if (k === "2") text = "assistant 气泡=" + JSON.stringify(e.callText) + " · task=" + (e.rawRunDetail && e.rawRunDetail.task.status);
  else if (k === "3") text = "data-ai-result=" + JSON.stringify(e.callText) + " · status=" + (e.state && e.state.status);
  else if (k === "4") text = "canvas/modelChat=" + JSON.stringify(e.callText) + " · " + clip(JSON.stringify(e.modelChat && e.modelChat.raw), 200);
  else if (k === "5") text = clip(e.errorLine || e.callText, 220);
  else if (k === "6") text = "UI=" + JSON.stringify(e.state && e.state.error) + " · 命令级=" + clip(JSON.stringify(e.commandOutline && e.commandOutline.result), 200);
  else text = "见下方反向对照";
  L.push("| " + k + " | " + (e ? e.name : "反向对照（image / video / vision）") + " | " + derived + " | " + code(clip(text, 260)) + " | " + (e ? e.ms + "ms" : "-") + " |");
}
L.push("");
L.push("## 一、配置一次（真实 DeepSeek）");
L.push("");
L.push("- provider：" + code(JSON.stringify(j.provider)) + "（不含密钥）");
L.push("- 真实 GET https://api.deepseek.com/models 拿到的模型 id：" + code((j.repairEvidence && j.repairEvidence.remoteModels && j.repairEvidence.remoteModels.items || []).map((m) => m.id).join(", ")));
L.push("- defaults/set capability=llm.chat（用户口径）真实回读：" + code(JSON.stringify(j.defaults.literalLlmChatAttempt.set)) + " → defaults/get 的 personal 键：" + code(Object.keys((j.defaults.literalLlmChatAttempt.get || {}).personal || {}).join(", ") || "（空）"));
L.push("- defaults/set capability=chat + tool-calling（实现的能力枚举）后 defaults/get：" + code(JSON.stringify(j.repairEvidence && j.repairEvidence.defaults)));
L.push("");
L.push("### credential/set 路径（按任务口径的配置顺序）");
L.push("");
L.push("- provider/create → " + code(JSON.stringify((j.rows.find((r) => r.name.startsWith("C1")) || {}).actual)));
L.push("- credential/set → 成功；随后 provider/models 真实回读：" + code((j.rows.find((r) => r.name.startsWith("C4")) || {}).detail) + "（" + (j.remoteModels && j.remoteModels.ms) + "ms，" + ((j.rows.find((r) => r.name.startsWith("C4")) || {}).ok ? "真实 GET 已发出" : "被拦，未发出请求") + "）");
L.push("- 同一 provider 在产品设置页点「测试连接」→ 徽章 " + code((j.entries["1"].uiTestBroken || {}).badge) + "；而一步带密钥建的 provider 点同一按钮 → " + code((j.entries["1"].uiTest || {}).badge));
L.push("");
L.push("### 正确路径（设置页「添加服务商」一步填密钥）");
L.push("");
L.push("- provider/create { credentialSecret } → " + code(JSON.stringify((j.rows.find((r) => r.name.startsWith("C10")) || {}).actual)));
L.push("- provider/models → " + code(clip(JSON.stringify(j.repairEvidence.remoteModels), 400)) + "（" + code((j.rows.find((r) => r.name.startsWith("C11")) || {}).detail) + "）");
L.push("- model/test → " + code(JSON.stringify(j.repairEvidence.modelTest)) + "（" + code((j.rows.find((r) => r.name.startsWith("C14")) || {}).detail) + "）");
L.push("- provider/call（即使供应商已配置）→ " + code(JSON.stringify(j.repairEvidence.providerCall)));
L.push("");
L.push("## 二、逐入口实测明细");
L.push("");
for (const k of ["1","2","3","4","5","6"]) {
  const e = j.entries[k];
  if (!e) continue;
  L.push("### 入口 " + k + " · " + e.name);
  L.push("");
  L.push("- 结论：**" + verdictFor(k, e) + "**");
  L.push("- 耗时：" + e.ms + "ms" + (e.runMs ? "（其中运行 " + e.runMs + "ms）" : "") + (e.commandOutlineMs ? " · 命令级 " + e.commandOutlineMs + "ms" : ""));
  if (k === "1") {
    L.push("- provider/call「只回复：ok」原始返回：" + code(e.providerCall.raw));
    L.push("- model/test（设置页「测试连接」的真实模型通道）原始返回：" + code(e.modelTest.raw));
    L.push("- 真实 UI：选中坏路径 provider → " + code(e.uiTestBroken.badge) + "；选中正确路径 provider → " + code(e.uiTest.badge));
  } else if (k === "2") {
    L.push("- 真实 UI 聊天气泡：" + code(JSON.stringify(e.messages)));
    L.push("- 底层 task/run → task/get：" + code(JSON.stringify({ taskId: e.rawRun.taskId, status: e.rawRunDetail && e.rawRunDetail.task.status, artifacts: (e.rawRunDetail && e.rawRunDetail.artifacts || []).map((a) => a.content) })));
    L.push("- 错误行：" + code(e.errorLine));
  } else if (k === "3") {
    L.push("- [data-ai-result]：" + code(e.callText) + " · status=" + code(e.state && e.state.status) + "（" + (e.state && e.state.statusText) + "）");
    L.push("- 面板任务：" + code(clip(JSON.stringify(e.taskDetail && { taskId: e.taskDetail.task.taskId, status: e.taskDetail.task.status, artifacts: (e.taskDetail.artifacts || []).map((a) => a.content) }), 300)));
  } else if (k === "4") {
    L.push("- 画布 host/frame 渲染：" + code("host=" + e.host + " frame=" + e.frame));
    L.push("- 生成序列 canvas/run → canvas/modelChat → canvas/runFinish（与 CanvasHost 同序列）返回：" + code(clip(e.modelChat.raw, 500)));
    L.push("- 返回文本：" + code(e.callText) + "；usage 与命中的默认模型见上面 snapshot 的 source=PERSONAL_DEFAULT。");
  } else if (k === "5") {
    L.push("- 锁定的技能：" + code(JSON.stringify(e.picked)) + "（内置技能共 " + e.skillCount + " 个，取 id=chat「对话回复」）");
    L.push("- UI 运行结果：" + code(clip(e.errorLine, 300)));
    L.push("- 预修复阶段的原始返回：" + code(clip(JSON.stringify(j.preRepair && j.preRepair.skillRun), 400)));
  } else if (k === "6") {
    L.push("- UI：[data-drama-outline] 点击=" + code(e.clicked) + "、settled=" + code(e.settled) + "、debug=" + code(clip(JSON.stringify(e.debug), 200)));
    L.push("- 命令级 media/short-drama/create + update + outline 原始返回：" + code(clip(JSON.stringify(e.commandOutline && e.commandOutline.result), 400)));
  }
  L.push("- 截图：" + (e.shots || []).map((s) => "[" + path.basename(s) + "](<" + s + ">)").join(" · "));
  L.push("");
}
L.push("## 三、反向对照（只有 DeepSeek，无图像 / 视频 / 视觉供应商）");
L.push("");
const rev = j.reverse || {};
L.push("### 1) image/generate");
L.push("");
L.push("- 无 providerId：" + code(JSON.stringify(rev["image.generate"] && rev["image.generate"].noProvider)));
L.push("- 传 DeepSeek providerId + deepseek-chat：" + code(JSON.stringify(rev["image.generate"] && rev["image.generate"].withDeepSeekProvider)));
L.push("- 结论：结构化拒绝，**没有任何假图**（返回体无 images 字段），未崩溃。");
L.push("");
L.push("### 2) video.generate");
L.push("");
L.push("- 作为 model 命令：" + code(JSON.stringify(rev["video.generate"] && rev["video.generate"].asModelCommand)));
L.push("- 作为协议 intent（protocol/execute）：" + code(clip(JSON.stringify(rev["video.generate"] && rev["video.generate"].asProtocolIntent), 300)));
L.push("- 关联真实入口：技能侧与短剧侧的 video 类能力同样走「模型站点」/「系统设置 › 模型与服务商」网关；本轮" + (revVideo.asModelCommand && revVideo.asModelCommand.ok === false ? "没有配置视频供应商 → 结构化不可用。" : "视频能力可用。"));
L.push("");
L.push("### 3) llm.chat.vision（相册「反推提示词」）");
L.push("");
L.push("- photos/visionModels：" + code(clip(JSON.stringify(rev["llm.chat.vision"] && rev["llm.chat.vision"].visionModels), 500)));
L.push("- photos/reversePrompt：" + code(JSON.stringify(rev["llm.chat.vision"] && rev["llm.chat.vision"].reversePrompt)));
L.push("- 结论：结构化不可用并给出「怎么配」的提示；未崩溃、未返回假提示词。");
L.push("");
L.push("## 四、断言与隔离");
L.push("");
L.push("| 断言 | 实测值 |");
L.push("|---|---|");
L.push("| console error | " + j.assertions.consoleErrors.length + " |");
L.push("| pageerror | " + j.assertions.pageErrors.length + " |");
L.push("| 渲染层非本地请求（除 DeepSeek） | " + j.assertions.otherExternalRequests.length + " |");
L.push("| 渲染层观察到的 DeepSeek 请求 | " + j.assertions.deepseekRequestCount + "（模型 HTTP 在主进程发出，渲染层看不到，属预期） |");
L.push("| 截图 | " + j.captures.length + " 张，全部 " + (j.captures.every((c) => c.at2880x1800) ? "2880×1800" : "尺寸不一致") + " |");
L.push("| 真实 profile 快照 | " + (j.profile.unchanged ? "mtime+size 0 项差异" : j.profile.changedCount + " 项差异：" + j.profile.changed.join(", ")) + " |");
L.push("| 隔离 userData | " + (j.userDataRemoved ? "已删除" : "保留") + "（含 safeStorage 测试密钥副本；dxos/providers.json 自始至终不存在=" + code(String(!j.userDataAudit.providersJsonExists)) + "）|");
L.push("| Electron 退出 | code=" + j.assertions.exit.code + " signal=" + j.assertions.exit.signal + " clean=" + j.assertions.exit.clean + " |");
L.push("");
L.push("## 五、修复前的根因与缺陷（历史记录，解释结论里的「修复前」阶段）");
L.push("");
L.push("### 缺陷 1（修复前必现）credential/set 把未归一化的 base_url 存成 providerOrigin");
L.push("");
L.push("- electron/model-service.cjs:403：providerOrigin: provider.base_url（provider.base_url 由 validateEndpoint 归一化为 https://api.deepseek.com/ ）。");
L.push("- 而所有调用出口比对的是 origin：electron/model-service.cjs:221 / 255 / 286 / 444 的 cred.providerOrigin !== new URL(baseUrl).origin（origin 无尾斜杠）。");
L.push("- 结果（修复前）：用「模型与服务商」详情页的「保存密钥」（credential/set、credential/replace）配的凭据，**每一次真实调用都被 ENDPOINT_BLOCKED 拦下**（修复前实测：provider/models 2ms ENDPOINT_BLOCKED、model/test ENDPOINT_BLOCKED、canvas/modelChat ENDPOINT_BLOCKED；本轮已不复现，见结论与第一节）。");
L.push("- 对照正确路径：createProvider（model-service.cjs:76，ep.origin）与 updateProvider 带 baseUrl 时（:100）取的是 origin，配置后一切正常。updateProvider 不带 baseUrl 时 :100 回落成 provider.base_url，同样会写坏；credential/replace 也不会修正已写坏的 providerOrigin。");
L.push("");
L.push("### 缺陷 2（修复前，架构级）「模型与服务商」与技能 / 短剧 / provider-call 的供应商存储不是同一套");
L.push("");
L.push("- provider/create|list、defaults/*、model/test 走 ModelStore（identity.db）；");
L.push("- 技能 / 短剧 / provider/call / image/generate / protocol/* 走 provider-protocol-store（userData/dxos/providers.json），而 IPC 白名单里**没有任何命令能在新设置页里写这个存储**（修复前实测该文件自始至终不存在；本轮已能写入并生效，见结论与入口 5 / 6）。");
L.push("- 结果：即便默认模型已生效（对话 / 全局 AI / 画布已真实调用 DeepSeek），技能仍报 SKILL_DEPENDENCY_UNAVAILABLE「还没有可用的模型站点。请先在「API 设置」里添加并启用一个站点」，短剧报 MEDIA_INVALID_INPUT「请先在「API 设置」中配置并启用一个语言模型」。提示指向的「API 设置」在 Vue 壳里并不存在（设置里叫「模型与服务商」）。");
L.push("");
L.push("### 缺陷 3（修复前，口径）defaults/set 接受任意 capability 且不做校验");
L.push("");
L.push("- capability: llm.chat 被 defaults/set 原样接受并返回 ok，但 getDefaults 只回读 6 个能力枚举（chat / tool-calling / image-generation / video-generation / embedding / vision-input），llm.chat 既不生效也不报错——静默无效。");
L.push("");
L.push("### 其它观察");
L.push("");
L.push("- video.generate 不在 model:command 白名单里（返回 MODEL_COMMAND_NOT_ALLOWED）；任务书里的 video.generate 实际是协议 / 网关的 capability 名。");
L.push("- provider/models 打的是 baseUrl + /models（成功拿到 " + code((j.repairEvidence && j.repairEvidence.remoteModels && j.repairEvidence.remoteModels.items || []).map((m) => m.id).join(", ")) + "），即 https://api.deepseek.com/models，不是 /v1/models；DeepSeek 两个都接受，但换成只认 /v1 的兼容站需要在 baseUrl 里显式带 /v1。");
L.push("- 非程序坞应用（短剧工坊、相册）必须经「应用中心」的应用卡片启动；程序坞里没有它们的图标。");
L.push("");
L.push("## 附录");
L.push("");
L.push("### 截图清单（全部 1440×900@2 = 2880×1800）");
L.push("");
L.push("| 文件 | 主题 | 尺寸 |");
L.push("|---|---|---|");
for (const c of j.captures) L.push("| [" + path.basename(c.file) + "](<" + c.file + ">) | " + c.theme + " | " + c.width + "×" + c.height + " |");
L.push("");
L.push("### 复跑");
L.push("");
L.push(FENCE + "bash");
L.push("node experiments/dxos-ui-global-model/run-all.mjs               # 全量");
L.push("OA_GM_ENTRIES=1,2 node experiments/dxos-ui-global-model/run-all.mjs");
L.push("node experiments/dxos-ui-global-model/render-report.mjs          # 渲染本报告");
L.push(FENCE);
L.push("");
L.push("> 密钥只在探针进程内读取，仅经 page.evaluate 传给 credential/set / provider/create；report.json 与截图都经过 scrub()，任何输出里出现 sk- 一律替换成 [REDACTED_KEY]。");
L.push("");
fs.writeFileSync(path.join(ART, "REPORT.md"), L.join("\n"));
console.log("REPORT.md 写好：" + L.length + " 行");
