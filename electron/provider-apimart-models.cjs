"use strict";
/**
 * APIMart 模型规格表 —— 逐条摘自官方文档 docs.apimart.ai（2026-10-23 版本）。
 * 同一张表同时决定：
 *   · 画布面板能选什么（uiSpec：比例 / 档位 / 时长 / 生成方式 / 参考图上限）
 *   · 请求体怎么写（字段名各家不同：size 或 aspect_ratio，resolution 或 mode，首尾帧有 image_with_roles /
 *     image_urls 顺序 / first_frame_image 三种写法，生成音频叫 generate_audio 或 audio）
 * 表里没有的模型：面板用前端按名字的预设，请求体走通用写法（size + resolution + duration + image_urls）。
 *
 * 字段说明（图片）：
 *   ratioKey  比例字段名；ratios 文档允许的比例（auto 显示为「自适应」）
 *   resKey    档位字段名（null = 不传）；res [[面板显示, 接口值]...]
 *   nMax      单次最多张数（1 = 要多张时并发提交）；perReq = 每次请求实际只要几张（面板仍按 nMax）；noN = 文档没有 n 参数
 *   refs      参考图上限（0 = 只能文生图）；mask = 支持 mask_url
 *   headers   额外请求头
 * 字段说明（视频）：
 *   dur       [最小, 最大] 或固定列表；durKey=null 表示文档没有时长参数
 *   frames    首尾帧写法：roles(image_with_roles) / urls(image_urls 顺序) / fields(first_frame_image + lastKey) / first(只有首帧字段) / urlsFirst(image_urls 只取首帧) / null
 *   refsBy    参考图写法：urls / roles / img_references / null；refs 参考图上限
 *   videoKey  参考视频字段（video_urls / null）；extendKey 视频延长字段
 *   audioRefKey 参考音频字段；audioKey 生成音频开关字段（null = 没有）
 *   modes     面板「生成方式」
 *   vMax      参考视频上限（默认 5）；urlOnly = 文档写明不收 base64，参考图必须先上传成公网 URL
 *   ratioT2vOnly = 带图时不能传比例；refRole = refsBy:roles 时参考图的 role 名（默认 reference）
 */

const IMG_RATIO = {
  gpt2: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"],
  ext: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"],
  gem: ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
  gem31: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1"],
  seedream: ["auto", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9", "9:21"],
  seed5: ["auto", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9"],
  flux: ["auto", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "9:21"],
  flux3: ["auto", "21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21"],
  basic7: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
};
const R = (list) => list.map((x) => [x.toUpperCase(), x]); // 面板显示大写，接口值原样
const K = { "1K": "1K", "2K": "2K", "4K": "4K" };

/** 图片模型（顺序 = 匹配优先级，具体的在前） */
const IMAGE = [
  { re: /^gpt-image-2\.5-ext/, ratioKey: "size", ratios: IMG_RATIO.ext, resKey: "resolution", res: R(["1K", "2K", "4K"]), nMax: 4, refs: 16 },
  { re: /^gpt-image-2\.5/, ratioKey: "size", ratios: IMG_RATIO.gpt2, resKey: "resolution", res: [["1K", "1k"], ["2K", "2k"], ["4K", "4k"]], nMax: 4, refs: 16, mask: true },
  { re: /^gpt-image-2-official/, ratioKey: "size", ratios: IMG_RATIO.gpt2, resKey: "resolution", res: [["1K", "1k"], ["2K", "2k"], ["4K", "4k"]], nMax: 4, refs: 16, mask: true },
  { re: /^gpt-image-2/, ratioKey: "size", ratios: IMG_RATIO.gpt2, resKey: "resolution", res: [["1K", "1k"], ["2K", "2k"], ["4K", "4k"]], nMax: 4, refs: 15, mask: true },
  { re: /^gpt-image-1/, ratioKey: "size", ratios: ["1:1", "3:2", "2:3"], resKey: null, res: [["1K", null]], nMax: 4, refs: 15, mask: true },
  { re: /^(gemini-nano-banana-2\.1-ext)/, ratioKey: "size", ratios: IMG_RATIO.gem31.filter((r) => r !== "auto").concat("auto"), resKey: "resolution", res: R(["1K", "2K", "4K"]), nMax: 1, refs: 14 },
  { re: /^(gemini-nano-banana-2\.1)/, ratioKey: "size", ratios: IMG_RATIO.gem31, resKey: "resolution", res: R(["1K", "2K", "4K"]), nMax: 4, refs: 14 },
  { re: /^(gemini-3\.1-flash-lite-image|nano-banana-2-lite)/, ratioKey: "size", ratios: IMG_RATIO.ext, resKey: "resolution", res: R(["1K"]), nMax: 4, refs: 14 },
  { re: /^(gemini-3\.1-flash-image|nano-banana-2)/, ratioKey: "size", ratios: IMG_RATIO.gem31, resKey: "resolution", res: [["0.5K", "0.5K"], ["1K", "1K"], ["2K", "2K"], ["4K", "4K"]], nMax: 1, refs: 14 },
  { re: /^(gemini-3-pro-image|nano-banana-pro)/, ratioKey: "size", ratios: IMG_RATIO.gem, resKey: "resolution", res: R(["1K", "2K", "4K"]), nMax: 1, refs: 14 },
  { re: /^(gemini-2\.5-flash-image|nano-banana)/, ratioKey: "size", ratios: IMG_RATIO.gem, resKey: "resolution", res: R(["1K"]), nMax: 1, refs: 14 },
  { re: /^imagen-4/, ratioKey: "size", ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"], resKey: null, res: [["1K", null]], nMax: 1, refs: 0 },
  // Seedream 4.x / 5.0-lite：n>1 会切成组图（sequential），纯文生图出不了多张，且 参考图+n ≤ 15 → 面板仍可选 1–4 张，但每次请求只要 1 张、并发提交（perReq）。
  { re: /^seedream-5[.-]0-lite/, ratioKey: "size", ratios: IMG_RATIO.seed5, resKey: "resolution", res: R(["2K", "3K", "4K"]), nMax: 4, perReq: 1, refs: 14, autoNeedsRef: true },
  { re: /^seedream-5[.-]0-(pro|flash)/, ratioKey: "size", ratios: IMG_RATIO.seed5, resKey: "resolution", res: R(["1K", "1.5K", "2K"]), nMax: 1, refs: 10 },
  { re: /^seedream-4[.-]5/, ratioKey: "size", ratios: IMG_RATIO.seedream, resKey: "resolution", res: R(["2K", "4K"]), nMax: 4, perReq: 1, refs: 14, autoNeedsRef: true },
  { re: /^seedream-4/, ratioKey: "size", ratios: IMG_RATIO.seedream, resKey: "resolution", res: R(["1K", "2K", "4K"]), nMax: 4, perReq: 1, refs: 14, autoNeedsRef: true },
  { re: /^flux-kontext/, ratioKey: "size", ratios: IMG_RATIO.flux, resKey: null, res: [["1MP", null]], nMax: 1, refs: 4 },
  { re: /^flux-2-/, ratioKey: "size", ratios: IMG_RATIO.flux, resKey: "resolution", res: R(["1MP", "2MP", "3MP", "4MP"]), nMax: 1, refs: 8 },
  { re: /^flux-3-image/, ratioKey: "aspect_ratio", ratios: IMG_RATIO.flux3, resKey: "resolution", res: [["1K", "1k"], ["1.5K", "1.5k"], ["2K", "2k"], ["4K", "4k"]], nMax: 1, refs: 10, noN: true },
  { re: /^hy-image/, ratioKey: "size", ratios: ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], resKey: "resolution", res: R(["1K", "2K", "4K"]), nMax: 1, refs: 5 },
  { re: /^mai-image/, ratioKey: "size", ratios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "4:1", "1:4"], resKey: "resolution", res: R(["1K", "2K"]), nMax: 1, refs: 5 },
  { re: /^qwen-image-3/, ratioKey: "size", ratios: IMG_RATIO.basic7, resKey: "resolution", res: R(["1K", "2K"]), nMax: 4, refs: 3 },
  { re: /^qwen-image/, ratioKey: "size", ratios: IMG_RATIO.basic7, resKey: "resolution", res: R(["1K", "2K"]), nMax: 4, refs: 3 },
  { re: /^z-image/, ratioKey: "size", ratios: IMG_RATIO.basic7, resKey: "resolution", res: R(["1K", "2K"]), nMax: 1, refs: 0, noN: true },
  { re: /^grok-imagine-2\.0-ext/, ratioKey: "size", ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"], resKey: "resolution", res: [["高清", "quality"]], nMax: 4, refs: 0, extra: { response_format: "url" } },
  // 官方 Grok Imagine Image 2.0：最多 3 张参考图，比例多了 9:19.5 / 19.5:9 / 9:20 / 20:9
  { re: /^grok-imagine-image-2/, ratioKey: "aspect_ratio", ratios: ["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1"], resKey: "resolution", res: [["1K", "1k"], ["2K", "2k"]], nMax: 4, refs: 3, official: true },
  { re: /^grok-imagine-image-quality/, ratioKey: "aspect_ratio", ratios: ["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "1:2", "2:1"], resKey: "resolution", res: [["1K", "1k"], ["2K", "2k"]], nMax: 4, refs: 3, official: true },
  { re: /^grok-imagine-image/, ratioKey: "aspect_ratio", ratios: ["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "1:2", "2:1"], resKey: "resolution", res: [["1K", "1k"], ["2K", "2k"]], nMax: 4, refs: 5, official: true },
  { re: /^grok-imagine-1\.5(?!-video)/, ratioKey: "size", ratios: ["1:1", "16:9", "9:16", "3:2", "2:3"], resKey: null, res: [["1K", null]], nMax: 4, refs: 5 },
  // 4K 只有 wan2.7-image-pro 文生图支持；标准版全场景 1K / 2K
  { re: /^wan2\.7-image-pro/, ratioKey: "size", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], resKey: "resolution", res: R(["1K", "2K", "4K"]), nMax: 4, refs: 9 },
  { re: /^wan2\.7-image/, ratioKey: "size", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], resKey: "resolution", res: R(["1K", "2K"]), nMax: 4, refs: 9 },
];

const V = {
  wide6: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  adaptive7: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  basic3: ["16:9", "9:16", "1:1"],
  basic5: ["16:9", "9:16", "1:1", "4:3", "3:4"],
};
const ALL = ["文生视频", "首帧", "首尾帧", "参考生视频", "参考视频生视频"];
const lo = (list) => list.map((x) => [x, x]);
const rg = (min, max) => ({ min, max }); // 时长区间（数组 = 只有这几个值）

/** 视频模型（顺序 = 匹配优先级） */
const VIDEO = [
  // —— 字节 Seedance
  { re: /^seedance-2\.5/, ratioKey: "size", ratios: V.adaptive7, resKey: "resolution", res: lo(["480p", "720p", "1080p"]), dur: rg(4, 30), frames: "roles", refsBy: "urls", refs: 30, videoKey: "video_urls", audioRefKey: "audio_urls", audioKey: "generate_audio", modes: ALL },
  { re: /^seedance-2\.0-(mini|fast)/, ratioKey: "size", ratios: V.adaptive7, resKey: "resolution", res: lo(["480p", "720p"]), dur: rg(4, 15), frames: "roles", refsBy: "urls", refs: 9, videoKey: "video_urls", vMax: 3, audioRefKey: "audio_urls", audioKey: "generate_audio", modes: ALL },
  { re: /^seedance-2/, ratioKey: "size", ratios: V.adaptive7, resKey: "resolution", res: lo(["480p", "720p", "1080p", "4k"]), dur: rg(4, 15), frames: "roles", refsBy: "urls", refs: 9, videoKey: "video_urls", vMax: 3, audioRefKey: "audio_urls", audioKey: "generate_audio", modes: ALL },
  { re: /^seedance-1-5/, ratioKey: "aspect_ratio", ratios: V.wide6, resKey: "resolution", res: lo(["480p", "720p", "1080p"]), dur: rg(4, 12), frames: "roles", refsBy: null, refs: 2, audioKey: "audio", modes: ["文生视频", "首帧", "首尾帧"] },
  { re: /^seedance-1-0-pro-quality/, ratioKey: "aspect_ratio", ratios: V.wide6, resKey: "resolution", res: lo(["480p", "720p", "1080p"]), dur: rg(2, 12), frames: "roles", refsBy: null, refs: 2, modes: ["文生视频", "首帧", "首尾帧"] },
  { re: /^seedance-1-0/, ratioKey: "aspect_ratio", ratios: V.wide6, resKey: "resolution", res: lo(["480p", "720p", "1080p"]), dur: rg(2, 12), frames: "roles", noLast: true, refsBy: null, refs: 1, modes: ["文生视频", "首帧"] },
  // —— Google VEO（时长固定 8 秒；image_urls：2 张=首尾帧，3 张=参考）
  // 官方渠道（-official）：首尾帧走 first_frame_image / last_frame_image，时长 4/6/8，4K 大写，音频开关 generate_audio
  { re: /^veo3\.1-(fast|quality)-official/, ratioKey: "aspect_ratio", ratios: ["16:9", "9:16"], resKey: "resolution", res: [["720p", "720p"], ["1080p", "1080p"], ["4k", "4K"]], dur: [4, 6, 8], frames: "fields", lastKey: "last_frame_image", refsBy: null, refs: 2, audioKey: "generate_audio", modes: ["文生视频", "首帧", "首尾帧"] },
  { re: /^veo3\.1-lite/, ratioKey: "aspect_ratio", ratios: ["16:9", "9:16"], resKey: "resolution", res: lo(["720p", "1080p", "4k"]), dur: [8], frames: null, refsBy: null, refs: 0, veo: true, modes: ["文生视频"] },
  { re: /^veo3\.1-quality/, ratioKey: "aspect_ratio", ratios: ["16:9", "9:16"], resKey: "resolution", res: lo(["720p", "1080p", "4k"]), dur: [8], frames: "urls", refsBy: null, refs: 2, veo: true, modes: ["文生视频", "首帧", "首尾帧"] },
  { re: /^veo3/, ratioKey: "aspect_ratio", ratios: ["16:9", "9:16"], resKey: "resolution", res: lo(["720p", "1080p", "4k"]), dur: [8], frames: "urls", refsBy: "urls", refs: 3, veo: true, modes: ["文生视频", "首帧", "首尾帧", "参考生视频"] },
  // —— MiniMax / 海螺
  // 这两个是同族的非生成任务：Context-IR 产提示词、Regeneration 用 source_task_id 重生成；
  // 之前被 /^minimax-h3/ 命中当普通视频生成，字段与语义都不对 → 显式排除（不编参数）。
  { re: /^minimax-h3-(?:context-ir|regeneration)/, excluded: "MiniMax-H3 的 Context-IR 只产提示词、Regeneration 需要 source_task_id，不是可直接调用的视频生成任务" },
  { re: /^minimax-h3-max/, ratioKey: "aspect_ratio", ratios: V.adaptive7, resKey: "resolution", res: [["480p", "480P"], ["768p", "768P"], ["1080p", "1080P"]], dur: rg(5, 15), frames: "roles", refsBy: "urls", refs: 9, videoKey: "video_urls", vMax: 3, audioRefKey: "audio_urls", modes: ALL },
  { re: /^minimax-h3/, ratioKey: "aspect_ratio", ratios: V.adaptive7, resKey: "resolution", res: [["768p", "768P"], ["2K", "2K"]], dur: rg(4, 15), frames: "roles", refsBy: "urls", refs: 9, videoKey: "video_urls", vMax: 3, audioRefKey: "audio_urls", modes: ALL },
  // 海螺 02 / 2.3 的 resolution 是小写 p（768p / 1080p），和 H3 的大写 P 不同
  { re: /^minimax-hailuo-2\.3-fast/, ratioKey: null, ratios: [], resKey: "resolution", res: lo(["768p", "1080p"]), dur: [6, 10], frames: "first", refsBy: null, refs: 1, hdDur: 6, modes: ["首帧"] },
  { re: /^minimax-hailuo-2\.3/, ratioKey: null, ratios: [], resKey: "resolution", res: lo(["768p", "1080p"]), dur: [6, 10], frames: "first", refsBy: null, refs: 1, hdDur: 6, modes: ["文生视频", "首帧"] },
  { re: /^minimax-hailuo-02/, ratioKey: null, ratios: [], resKey: "resolution", res: lo(["512p", "768p", "1080p"]), dur: [5, 10], frames: "fields", lastKey: "last_frame_image", refsBy: null, refs: 2, hdDur: 5, modes: ["文生视频", "首帧", "首尾帧"] },
  // —— FLUX 3 视频（image_urls 顺序：1=首帧，2=首尾帧）
  { re: /^flux-3-video/, ratioKey: "aspect_ratio", ratios: ["auto", "21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16"], resKey: "resolution", res: [["720p", "hd"], ["1080p", "fhd"]], dur: rg(5, 20), frames: "urls", refsBy: null, refs: 10, extendKey: "video_url", audioKey: "audio", modes: ["文生视频", "首帧", "首尾帧", "视频延长"] },
  // —— 通义万相
  { re: /^wan3\.0-video/, ratioKey: "size", ratios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"], resKey: "resolution", res: [["480p", "480P"], ["720p", "720P"], ["1080p", "1080P"]], dur: rg(2, 30), frames: "roles", refsBy: "urls", refs: 10, videoKey: "video_urls", audioRefKey: "audio_urls", audioKey: "audio", urlOnly: true, modes: ALL },
  // R2V 没有 image_urls：参考图放 image_with_roles，role = reference_image（图 + 视频合计 ≤ 5）
  { re: /^wan2\.7-r2v/, ratioKey: "size", ratios: V.basic5, resKey: "resolution", res: [["720p", "720P"], ["1080p", "1080P"]], dur: rg(2, 10), frames: null, refsBy: "roles", refRole: "reference_image", refs: 5, videoKey: "video_urls", modes: ["参考生视频", "参考视频生视频"] },
  { re: /^wan2\.7-videoedit/, ratioKey: null, ratios: [], resKey: "resolution", res: [["720p", "720P"], ["1080p", "1080P"]], dur: rg(2, 10), frames: null, refsBy: "urls", refs: 4, videoKey: "video_urls", modes: ["视频编辑"] },
  { re: /^wan2\.7/, ratioKey: "size", ratios: V.basic5, resKey: "resolution", res: [["720p", "720P"], ["1080p", "1080P"]], dur: rg(2, 15), frames: "urls", refsBy: null, refs: 2, videoKey: "video_urls", audioRefKey: "audio_url", modes: ["文生视频", "首帧", "首尾帧", "视频延长"], extendKey: "video_urls" },
  { re: /^wan2\.6-i2v-flash/, ratioKey: null, ratios: [], resKey: "resolution", res: lo(["720p", "1080p"]), dur: rg(2, 15), frames: "urlsFirst", refsBy: null, refs: 1, audioKey: "audio", modes: ["首帧"] },
  { re: /^wan2\.6-i2v/, ratioKey: null, ratios: [], resKey: "resolution", res: lo(["720p", "1080p"]), dur: rg(2, 15), frames: "urlsFirst", refsBy: null, refs: 1, modes: ["首帧"] },
  { re: /^wan2\.6/, ratioKey: "aspect_ratio", ratios: V.basic5, resKey: "resolution", res: lo(["720p", "1080p"]), dur: [5, 10, 15], frames: "urlsFirst", refsBy: null, refs: 1, audioKey: "audio", modes: ["文生视频", "首帧"] },
  // wan2.5-preview：比例字段是 size；时长只有 5 / 10；audio 只能 true（不下发开关）
  { re: /^wan2\.5/, ratioKey: "size", ratios: V.basic5, resKey: "resolution", res: lo(["480p", "720p", "1080p"]), dur: [5, 10], frames: "urlsFirst", refsBy: null, refs: 1, modes: ["文生视频", "首帧"] },
  // —— 可灵（v3 / omni / o1 / 2.6 的清晰度放在 mode：std=720P、pro=1080P）
  { re: /^kling-v4/, ratioKey: "aspect_ratio", ratios: ["auto", "16:9", "9:16", "1:1", "21:9"], resKey: "resolution", res: lo(["720p", "1080p"]), dur: rg(3, 30), frames: "roles", refsBy: "urls", refs: 10, videoKey: "video_urls", audioRefKey: "audio_urls", kling4: true, modes: ["文生视频", "首帧", "首尾帧", "参考生视频", "参考视频生视频", "视频编辑", "视频延长"] },
  // 动作控制两条：契约是 image_url + video_url + character_orientation + keep_original_sound，不是普通文生/图生视频。
  // 必填 mode（std / pro）与 character_orientation（image / video）；keep_original_sound 是字符串 yes / no；没有 duration（按参考视频实际时长）
  { re: /^kling-v2-6-motion-control/, ratioKey: null, ratios: [], resKey: "mode", res: [["720p", "std"], ["1080p", "pro"]], dur: [], durKey: null, frames: null, refsBy: null, refs: 1, audioKey: "keep_original_sound", motionControl: true, modes: ["视频动作控制"] },
  { re: /^kling-v3-motion-control/, ratioKey: null, ratios: [], resKey: "mode", res: [["720p", "std"], ["1080p", "pro"]], dur: [], durKey: null, frames: null, refsBy: null, refs: 1, audioKey: "keep_original_sound", motionControl: true, modes: ["视频动作控制"] },
  { re: /^kling-v3-omni/, ratioKey: "aspect_ratio", ratios: V.basic3, resKey: "mode", res: [["720p", "std"], ["1080p", "pro"], ["4k", "4k"]], dur: rg(3, 15), frames: "roles", refsBy: "roles", refs: 7, audioKey: "audio", modes: ["文生视频", "首帧", "首尾帧", "参考生视频"] },
  { re: /^kling-v3/, ratioKey: "aspect_ratio", ratios: V.basic3, resKey: "mode", res: [["720p", "std"], ["1080p", "pro"], ["4k", "4k"]], dur: rg(3, 15), frames: "urls", refsBy: null, refs: 2, audioKey: "audio", modes: ["文生视频", "首帧", "首尾帧"] },
  { re: /^kling-3\.0-turbo/, ratioKey: "aspect_ratio", ratios: V.basic3, resKey: "resolution", res: lo(["720p", "1080p"]), dur: rg(3, 15), frames: "first", refsBy: null, refs: 1, modes: ["文生视频", "首帧"] },
  { re: /^kling-video-o1/, ratioKey: "aspect_ratio", ratios: V.basic3, resKey: "mode", res: [["720p", "std"], ["1080p", "pro"]], dur: [5, 10], frames: "roles", refsBy: "roles", refs: 7, modes: ["文生视频", "首帧", "首尾帧", "参考生视频"] },
  { re: /^kling-v2-6(?!-motion)/, ratioKey: "aspect_ratio", ratios: V.basic3, resKey: "mode", res: [["720p", "std"], ["1080p", "pro"]], dur: [5, 10], frames: "urls", refsBy: null, refs: 2, audioKey: "audio", modes: ["文生视频", "首帧", "首尾帧"] },
  // —— Vidu
  { re: /^viduq4/, ratioKey: "aspect_ratio", ratios: V.basic5, resKey: "resolution", res: [["540p", "540p"], ["720p", "720p"], ["1080p", "1080p"], ["2K", "2K"], ["4K", "4K"]], dur: rg(3, 16), frames: "roles", noLast: true, refsBy: "urls", refs: 15, audioRefKey: "audio_urls", audioKey: "audio", modes: ["首帧", "参考生视频"] },
  // 传了 image_urls 就不能再带 aspect_ratio（比例取自图片）
  { re: /^viduq3-(pro|turbo)/, ratioKey: "aspect_ratio", ratios: V.basic5, resKey: "resolution", res: lo(["540p", "720p", "1080p"]), dur: rg(1, 16), frames: "urls", refsBy: null, refs: 2, audioKey: "audio", ratioT2vOnly: true, modes: ["文生视频", "首帧", "首尾帧"] },
  { re: /^viduq3-mix/, ratioKey: "aspect_ratio", ratios: V.basic5, resKey: "resolution", res: lo(["720p", "1080p"]), dur: rg(1, 16), frames: null, refsBy: "urls", refs: 7, urlOnly: true, modes: ["参考生视频"] },
  { re: /^viduq3/, ratioKey: "aspect_ratio", ratios: V.basic5, resKey: "resolution", res: lo(["540p", "720p", "1080p"]), dur: rg(3, 16), frames: null, refsBy: "urls", refs: 7, urlOnly: true, modes: ["参考生视频"] },
  // —— 其它
  // Grok 视频只收公网 URL（不收 base64）
  { re: /^grok-imagine-1\.5-video/, ratioKey: "size", ratios: ["16:9", "9:16", "1:1", "3:2", "2:3"], resKey: "resolution", res: lo(["480p", "720p"]), dur: rg(6, 15), frames: "urlsFirst", refsBy: "urls", refs: 7, urlOnly: true, modes: ["文生视频", "首帧", "参考生视频"] },
  // Grok 官方视频：字段是 aspect_ratio（没有 size）；1.5 多一档 1080p
  { re: /^grok-imagine-video-1\.5/, ratioKey: "aspect_ratio", ratios: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], resKey: "resolution", res: lo(["480p", "720p", "1080p"]), dur: rg(1, 15), frames: null, refsBy: "urls", refs: 7, urlOnly: true, modes: ["文生视频", "参考生视频"] },
  { re: /^grok-imagine-video/, ratioKey: "aspect_ratio", ratios: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], resKey: "resolution", res: lo(["480p", "720p"]), dur: rg(1, 15), frames: null, refsBy: "urls", refs: 7, urlOnly: true, modes: ["文生视频", "参考生视频"] },
  // PixVerse V6 Max：只有文生 / 单图图生（image_urls 1 张），比例字段 aspect_ratio；首尾帧与 img_references 都会 400
  { re: /^pixverse-v6-max/, ratioKey: "aspect_ratio", ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "2:3", "3:2", "21:9"], resKey: "resolution", res: lo(["360p", "540p", "720p", "1080p"]), dur: rg(1, 15), frames: "urlsFirst", noLast: true, refsBy: null, refs: 1, audioKey: "audio", urlOnly: true, modes: ["文生视频", "首帧"] },
  { re: /^pixverse-v6/, ratioKey: "size", ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"], resKey: "resolution", res: lo(["360p", "540p", "720p", "1080p"]), dur: rg(1, 15), frames: "fields", lastKey: "last_frame_image", pairFrames: true, refsBy: "img_references", refs: 7, audioKey: "audio", urlOnly: true, modes: ["文生视频", "首帧", "首尾帧", "参考生视频"] },
  { re: /^happyhorse/, ratioKey: "size", ratios: V.basic5, resKey: "resolution", res: [["720p", "720P"], ["1080p", "1080P"]], dur: rg(3, 15), frames: "first", refsBy: "urls", refs: 9, modes: ["文生视频", "首帧", "参考生视频"] },
  { re: /^skyreels-v4/, ratioKey: "aspect_ratio", ratios: ["16:9", "4:3", "1:1", "9:16", "3:4"], resKey: "resolution", res: lo(["480p", "720p", "1080p"]), dur: rg(3, 15), frames: "fields", lastKey: "end_frame_image", refsBy: null, refs: 2, modes: ["文生视频", "首帧", "首尾帧"] },
  // gemini-omni-1.1-flash-ext：没有首尾帧字段；首帧 = generation_type:"frame" + image_urls 1 张；参考图 1 或 3 张；时长 4/6/8/10（带视频时不能传）
  { re: /^gemini-omni-1\.1-flash-ext/, ratioKey: "aspect_ratio", ratios: ["16:9", "9:16"], resKey: "resolution", res: lo(["720p", "1080p", "4k"]), dur: [4, 6, 8, 10], frames: "typedFirst", noLast: true, refsBy: "urls", refs: 3, refCounts: [1, 3], videoKey: "video_urls", vMax: 1, noDurWithVideo: true, modes: ["文生视频", "首帧", "参考生视频", "参考视频生视频"] },
  // gemini-omni-flash-preview：只有 image_urls（≤16）/ video_urls（≤1），没有首尾帧与时长，只有 720p，必须带参考素材
  { re: /^gemini-omni-flash-preview/, ratioKey: "aspect_ratio", ratios: ["16:9", "9:16"], resKey: "resolution", res: lo(["720p"]), dur: [], durKey: null, frames: null, refsBy: "urls", refs: 16, videoKey: "video_urls", vMax: 1, needsMedia: true, modes: ["参考生视频", "参考视频生视频"] },
  { re: /^(gemini-omni|omni-flash)/, ratioKey: "aspect_ratio", ratios: ["16:9", "9:16"], resKey: "resolution", res: lo(["360p", "720p", "1080p", "4k"]), dur: [], durKey: null, frames: "fields", lastKey: "last_frame_image", refsBy: "urls", refs: 10, videoKey: "video_urls", vMax: 1, modes: ["文生视频", "首帧", "首尾帧", "参考生视频", "参考视频生视频"] },
];

/**
 * 音频模型。面板上「类型」就是 kinds，「时长」就是 adurs。
 *   tts    POST /v1/audio/speech，同步返回音频文件；kinds 用来选音色（voice）
 *   suno   POST /v1/music/generations（音效走 /v1/music/generations/sounds），查询 /v1/music/tasks/{id}
 *   flow   POST /v1/music/generations（model=flowmusic，length 1–240 秒）
 */
const TTS_VOICES = [["女声 · 活力", "nova"], ["女声 · 温柔", "shimmer"], ["男声 · 沉稳", "echo"], ["男声 · 深沉", "onyx"], ["中性", "alloy"], ["英式 · 叙述", "fable"]];
const AUDIO = [
  { re: /^(gpt-4o-mini-tts|tts-1)/, api: "tts", kinds: TTS_VOICES.map((v) => v[0]), voices: TTS_VOICES, adurs: ["自适应"] },
  { re: /^suno/, api: "suno", kinds: ["音乐", "纯音乐", "音效", "循环音效"], adurs: ["自适应"] },
  { re: /^flowmusic/, api: "flow", kinds: ["音乐"], adurs: ["自适应", "30s", "60s", "120s", "180s", "240s"] },
];

const lc = (s) => String(s || "").trim().toLowerCase();
const audioModel = (model) => AUDIO.find((x) => x.re.test(lc(model))) || null;
const imageModel = (model) => IMAGE.find((x) => x.re.test(lc(model))) || null;
/** 明确不当作视频生成的族（Context-IR / Regeneration）：单独查，避免被当成普通视频模型 */
const excludedVideoModel = (model) => VIDEO.find((x) => x.excluded && x.re.test(lc(model))) || null;
/** 命中排除族就返回 null（排除规则更具体，优先于通用 /^minimax-h3/ 之类的族前缀） */
const videoModel = (model) => (excludedVideoModel(model) ? null : VIDEO.find((x) => x.re.test(lc(model))) || null);

/** 时长 → 面板上的档位：数组原样；区间挑常用的几档 */
function durList(dur) {
  if (Array.isArray(dur)) return dur.slice();
  if (!dur || typeof dur !== "object") return [];
  const { min: a, max: b } = dur;
  if (b - a <= 4) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  return [...new Set([a, 5, 6, 8, 10, 12, 15, 20, 25, 30, b].filter((x) => x >= a && x <= b))].sort((x, y) => x - y);
}
/** 把请求的秒数收进模型允许的范围；-1 = 由模型自动决定时长（seedance-2.5 / wan3.0），原样透传 */
function clampDur(dur, want) {
  if (Number(want) === -1) return -1;
  const w = Math.round(Number(want) || 5);
  if (Array.isArray(dur)) return dur.length ? dur.reduce((x, y) => (Math.abs(y - w) < Math.abs(x - w) ? y : x), dur[0]) : null;
  if (dur && typeof dur === "object") return Math.max(dur.min, Math.min(dur.max, w));
  return w;
}
const uiRatio = (list) => list.map((r) => (r === "auto" || r === "adaptive" ? "自适应" : r));

/** 面板规格（交给 canvas/models 的 uiSpec）；不认识的模型返回 null */
function uiSpec(model) {
  const img = imageModel(model);
  if (img) return { kind: "image", ratios: uiRatio(img.ratios), sizes: img.res.map((r) => r[0]), batch: [1, 2, 3, 4], maxRefs: img.refs, i2i: img.refs > 0, ...(img.mask ? { mask: true } : {}) };
  const au = audioModel(model);
  if (au) return { kind: "audio", kinds: au.kinds, adurs: au.adurs };
  // 排除族：仍然是视频类目，但本仓没有它的可调用契约 → 面板如实说不能用，不套通用参数
  const excluded = excludedVideoModel(model);
  if (excluded) return { kind: "video", unsupported: true, reason: excluded.excluded, ratios: [], res: [], durs: [], modes: [], maxRefs: 0, times: [1] };
  const v = videoModel(model);
  if (v) return { kind: "video", ratios: uiRatio(v.ratios), res: v.res.map((r) => r[0]), durs: durList(v.dur), modes: v.modes, maxRefs: v.refs, audio: !!v.audioKey, times: [1] };
  return null;
}

module.exports = { IMAGE, VIDEO, AUDIO, imageModel, videoModel, audioModel, excludedVideoModel, uiSpec, durList, clampDur, uiRatio };
