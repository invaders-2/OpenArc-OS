/**
 * 画布前端「模型规格驱动」纯逻辑回归（tasks/model-spec）：
 *
 *   ① 有 uiSpec（specSource='spec'）→ **以规格为准**，不再从名字 PRESETS 继承
 *      search / style / camera / batch / maxRefs / i2i 这些可选能力（"假可用"的根源）；
 *   ② 没有 uiSpec → 才用 PRESETS 按名字兜底，并标 specSource='guess'（面板显示「未验证」）；
 *   ③ 规格里明确 false 的选项不出现；缺省的可选能力按「不支持」，不回落名字猜测；
 *   ④ 后端显式给的 specSource 优先，但『标了 spec 却没带可用规格』不许冒充已验证。
 *
 * 直接 import 画布前端的 TS 源（Node 22 自带类型擦除），跑的是真实现，不是复制品。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { specFor, clampParams } = await import("../src/canvas/canvas-next/model.ts");

const pick = (spec) => ({
  specSource: spec.specSource,
  search: spec.search,
  style: spec.style,
  camera: spec.camera,
  batch: spec.batch,
  maxRefs: spec.maxRefs,
  i2i: spec.i2i,
  ratios: spec.ratios,
  sizes: spec.sizes,
});

/** 名字会命中 banana / nano 预设（该预设自带 search/style/camera/maxRefs=14/batch=[1,2,4]） */
const BANANA_LABEL = "Gemini Nano Banana Pro";

test("有规格：以 uiSpec 为准，完全不继承名字 PRESETS 的可选能力", () => {
  const spec = pick(specFor({
    configId: "cfg_spec", label: BANANA_LABEL, kind: "image",
    ui: { kind: "image", ratios: ["1:1", "3:4"], sizes: ["2K"], batch: [1], maxRefs: 2, i2i: true },
  }));
  assert.deepEqual(spec, {
    specSource: "spec",
    search: false, style: false, camera: false, // 名字命中 banana 也不会打开
    batch: [1], // 不是预设的 [1,2,4]
    maxRefs: 2, // 不是预设的 14
    i2i: true,
    ratios: ["1:1", "3:4"], // 规格里的比例原样
    sizes: ["2K"],
  });
});

test("无规格：才走 PRESETS 名字兜底，并标 specSource='guess'", () => {
  const spec = pick(specFor({ configId: "cfg_guess", label: BANANA_LABEL, kind: "image" }));
  assert.equal(spec.specSource, "guess");
  assert.equal(spec.search, true, "猜测模型保留名字推断出的联网");
  assert.equal(spec.style, true);
  assert.equal(spec.camera, true);
  assert.deepEqual(spec.batch, [1, 2, 4]);
  assert.equal(spec.maxRefs, 14);
});

test("规格明确 false 的选项不出现；明确 true 的才保留", () => {
  const off = specFor({ configId: "c1", label: BANANA_LABEL, kind: "image", ui: { kind: "image", ratios: ["1:1"], sizes: ["1K"], search: false, style: false, camera: false } });
  assert.equal(off.search, false);
  assert.equal(off.style, false);
  assert.equal(off.camera, false);
  const on = specFor({ configId: "c2", label: BANANA_LABEL, kind: "image", ui: { kind: "image", ratios: ["1:1"], sizes: ["1K"], search: true, style: true, camera: true } });
  assert.equal(on.search, true);
  assert.equal(on.style, true);
  assert.equal(on.camera, true);
  assert.equal(on.specSource, "spec");
});

test("规格缺省的可选能力按「不支持」，不回落名字猜测", () => {
  const spec = pick(specFor({ configId: "c3", label: BANANA_LABEL, kind: "image", ui: { kind: "image", ratios: ["1:1"], sizes: ["1K"] } }));
  assert.equal(spec.specSource, "spec");
  assert.equal(spec.search, false);
  assert.equal(spec.style, false);
  assert.equal(spec.camera, false);
  assert.deepEqual(spec.batch, [1], "没声明批量 → 只能 1×");
  assert.equal(spec.maxRefs, 0, "没声明参考图上限 → 不给参考图");
  assert.equal(spec.i2i, false);
});

test("视频规格：times / audio / multiShot 同样只认规格声明", () => {
  const bare = specFor({ configId: "v1", label: "Seedance 2.5", kind: "video", ui: { kind: "video", ratios: ["16:9"], res: ["720p"], durs: [5], modes: ["文生视频", "首帧"], maxRefs: 2 } });
  assert.equal(bare.specSource, "spec");
  assert.deepEqual(bare.times, [1]);
  assert.equal(bare.audio, false);
  assert.equal(bare.multiShot, false);
  const rich = specFor({ configId: "v2", label: "Seedance 2.5", kind: "video", ui: { kind: "video", ratios: ["16:9"], res: ["1080p"], durs: [5, 10], modes: ["文生视频"], maxRefs: 2, times: [1, 2], audio: true, multiShot: true } });
  assert.deepEqual(rich.times, [1, 2]);
  assert.equal(rich.audio, true);
  assert.equal(rich.multiShot, true);
});

test("文本模型：有规格的 search/style 不靠名字猜；没规格的才猜", () => {
  const spec = specFor({ configId: "t1", label: "gemini-3.1-flash", kind: "text", ui: { kind: "text", search: false } });
  assert.equal(spec.specSource, "spec");
  assert.equal(spec.search, false, "规格说不能联网，名字里的 gemini 不能打开它");
  const guess = specFor({ configId: "t2", label: "gemini-3.1-flash", kind: "text" });
  assert.equal(guess.specSource, "guess");
  assert.equal(guess.search, true);
});

test("specSource 优先级：后端显式值优先，但标了 spec 却没带规格不许冒充", () => {
  const ui = { kind: "image", ratios: ["1:1"], sizes: ["1K"] };
  assert.equal(specFor({ configId: "a", label: "x", kind: "image", ui, specSource: "guess" }).specSource, "guess", "后端说这行是猜的，就标 guess");
  assert.equal(specFor({ configId: "b", label: "x", kind: "image", ui, specSource: "spec" }).specSource, "spec");
  assert.equal(specFor({ configId: "c", label: "x", kind: "image", specSource: "spec" }).specSource, "guess", "没有可用规格时不能冒充已验证");
  assert.equal(specFor({ configId: "d", label: "x", kind: "image" }).specSource, "guess");
});

test("规格里的 kind 与行不符时视为没有规格（不拿别类型规格套）", () => {
  const spec = specFor({ configId: "m1", label: BANANA_LABEL, kind: "image", ui: { kind: "video", ratios: ["16:9"], res: ["720p"] } });
  assert.equal(spec.specSource, "guess", "video 规格不能套到 image 行上");
  assert.equal(spec.maxRefs, 14, "此时才回落到名字预设");
});

test("切换模型：clampParams 把规格不支持的风格 / 摄影机 / 联网 / 批量收回去", () => {
  const spec = specFor({ configId: "c9", label: BANANA_LABEL, kind: "image", ui: { kind: "image", ratios: ["1:1", "3:4"], sizes: ["2K"], batch: [1], maxRefs: 1, i2i: true } });
  const before = { model: "old", ratio: "1:1", size: "4K", count: 4, search: true, style: "电影感", camera: { on: true, body: 0, lens: 0, focal: 2, aperture: 3 } };
  const after = clampParams("image", before, spec);
  assert.equal(after.search, false);
  assert.equal(after.style, "无");
  assert.equal(after.camera.on, false);
  assert.equal(after.count, 1);
  assert.equal(after.size, "2K", "4K 不在规格档位里 → 收到最近的 2K");
});

test("被排除的视频族（规格声明 unsupported）不套通用参数", () => {
  const spec = specFor({ configId: "vx", label: "kling-v4", kind: "video", ui: { kind: "video", unsupported: true, ratios: [], res: [], durs: [], modes: [], maxRefs: 0, times: [1] } });
  assert.equal(spec.specSource, "spec");
  assert.deepEqual(spec.modes, []);
  assert.deepEqual(spec.ratios, []);
  assert.equal(spec.audio, false);
  assert.equal(spec.multiShot, false);
});
