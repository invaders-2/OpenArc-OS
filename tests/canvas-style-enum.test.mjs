/**
 * 画布风格取值收敛（task-30）。
 *
 * 后端把 style 当 ≤40 字自由文本原样拼进提示词，所以画布必须自己守住枚举：
 *   ① 合法风格（STYLES 里的名字）原样发送；
 *   ② 未知 / 自定义风格一律不进请求（styleForRequest → null）；
 *   ③ 清空 / 「无」/ 非法值在读参数与切模型时回退成「无」。
 * 直接 import 画布前端的 TS 源（Node 22 类型擦除），跑真实现。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { STYLES, normalizeStyle, styleForRequest, clampParams, genOf } = await import("../src/canvas/canvas-next/model.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = STYLES.map(([name]) => name);
const NON_EMPTY = NAMES.filter((name) => name !== "无");

test("枚举自身健康：STYLES 导出、名字唯一、每项都有预览", () => {
  assert.ok(Array.isArray(STYLES) && STYLES.length >= 6, JSON.stringify(NAMES));
  assert.equal(new Set(NAMES).size, NAMES.length, "风格名不能重复");
  for (const [name, preview] of STYLES) {
    assert.ok(typeof name === "string" && name.length > 0);
    assert.ok(typeof preview === "string" && preview.length > 0, name + " 缺预览");
  }
  assert.ok(NAMES.includes("无"), "「无」是回退值，必须在枚举里");
  assert.ok(NON_EMPTY.length >= 5, JSON.stringify(NON_EMPTY));
});

test("合法风格原样发送（顺带收敛首尾空格）", () => {
  for (const name of NON_EMPTY) {
    assert.equal(styleForRequest(name), name);
    assert.equal(styleForRequest("  " + name + "  "), name);
  }
});

test("未知 / 自定义风格不发送", () => {
  for (const bad of ["赛博朋克", "custom:vivid", "电影感2", "FLUX", "无风格", "<script>"]) {
    assert.equal(styleForRequest(bad), null, bad + " 不该进请求");
  }
  // 只发枚举本身，不做模糊匹配
  assert.equal(styleForRequest("电影"), null);
});

test("清空 / 无 / 空值回退成「无」（请求里不带风格）", () => {
  for (const empty of ["", "   ", null, undefined, "无"]) {
    assert.equal(styleForRequest(empty), null, JSON.stringify(empty));
    assert.equal(normalizeStyle(empty), "无");
  }
  assert.equal(normalizeStyle("赛博朋克"), "无", "非法值回退「无」");
  assert.equal(normalizeStyle("水彩"), "水彩");
});

test("切模型：clampParams 把非枚举风格收回「无」，合法风格保留", () => {
  const spec = { id: "m1", name: "Banana", vendor: "", tags: [], kind: "image", secs: 10, style: true, ratios: ["1:1"], sizes: ["1K"], batch: [1], maxRefs: 1, i2i: true };
  const base = { model: "m1", ratio: "1:1", size: "1K", count: 1, search: false, style: "赛博朋克", camera: { on: false, body: 0, lens: 0, focal: 2, aperture: 3 } };
  assert.equal(clampParams("image", base, spec).style, "无", "未知风格不能留在参数里");
  assert.equal(clampParams("image", { ...base, style: "胶片" }, spec).style, "胶片");
  assert.equal(clampParams("image", { ...base, style: "胶片" }, { ...spec, style: false }).style, "无", "模型不支持风格时回退「无」");
});

test("读旧文档：params.style 里的自定义串收敛成「无」，且不改写原节点", () => {
  const node = { id: "n1", kind: "image", x: 0, y: 0, w: 240, h: 240, text: "图片", data: { gen: { params: { model: "m1", ratio: "1:1", size: "1K", count: 1, search: false, style: "赛博朋克", camera: { on: false, body: 0, lens: 0, focal: 2, aperture: 3 } } } } };
  assert.equal(genOf(node).params.style, "无");
  assert.equal(node.data.gen.params.style, "赛博朋克", "genOf 是只读投影，不能改写文档");
  const ok = { ...node, data: { gen: { params: { ...node.data.gen.params, style: "电影感" } } } };
  assert.equal(genOf(ok).params.style, "电影感");
});

test("契约：画布发请求时必须经 styleForRequest（回归护栏）", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/canvas/canvas-next/backend/bridge.ts"), "utf8");
  assert.match(source, /style:\s*styleForRequest\(p\.style\)/, "bridge 的 style 必须走枚举收敛");
  assert.equal(/style:\s*p\.style === "无"/.test(source), false, "不能再是「不是无就原样发」的旧写法");
});
