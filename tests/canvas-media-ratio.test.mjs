import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("拖入 / 上传的图片与视频：节点按素材原比例定尺寸，不再只夹高度", () => {
  const model = read("src/canvas/canvas-next/model.ts");
  assert.match(model, /export function fitMediaBox\(/);
  const actions = read("src/canvas/canvas-next/actions.ts");
  // 新建节点和传进已有节点两条路径都走 fitMediaBox
  assert.equal((actions.match(/fitMediaBox\(/g) || []).length, 2);
  assert.doesNotMatch(actions, /Math\.min\(520, w \* wh\[1\] \/ wh\[0\]\)/);
  // 读不到视频宽高时不再写死 16:9
  assert.doesNotMatch(actions, /: \[16, 9\];/);
  assert.match(read("src/canvas/canvas-next/engine.ts"), /fitMediaBox\(o\.w, o\.h, n\.w\)/);
  // 视频元素加载后补真实宽高
  assert.match(read("src/canvas/canvas-next/ui/NodeView.tsx"), /onLoadedMetadata=\{\(e\) => learnSize\(e\.currentTarget\)\}/);
});

test("快捷键文案按平台显示", () => {
  const keys = read("src/canvas/canvas-next/keys.ts");
  assert.match(keys, /export function kbd\(/);
  assert.match(read("src/canvas/canvas-next/ui/Chrome.tsx"), /<kbd>\{kbd\(b\)\}<\/kbd>/);
});
