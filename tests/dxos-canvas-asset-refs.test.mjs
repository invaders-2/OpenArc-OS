/**
 * 画布资源引用 ⇄ 显示数据 · 纯逻辑单测。
 * 被测：src/canvas/canvasAssetRefs.ts（产品真实代码，宿主 CanvasHost 的 resolveRefs / refsBack 唯一实现）。
 *
 * 覆盖四类真实缺陷条件：
 *   ① 多引用（>20）必须全部转换（原实现 slice(0,20) 后剩下的以原始 ref 落到 <img> → CSP 违规 + 图裂）；
 *   ② 引用不只在 node.url：node.refs[] / node.inputs[].url / 封面缩略图 / 嵌套 params 都要覆盖；
 *   ③ 保存必须换回 openarc-asset: ref，旧 data URL 原样保留（不静默丢图）；
 *   ④ 读不出来的引用必须如实处理：换成 CSP 安全的占位值、引用可还原、绝不把 openarc-asset: 留给页面。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSET_PREFIX,
  ASSET_RESOLVE_BATCH,
  MISSING_ASSET_DATA_URL_PREFIX,
  collectAssetRefs,
  mapDocStrings,
  missingAssetPlaceholder,
  refFromMissingAssetPlaceholder,
  resolveAssetRefsInDoc,
  restoreAssetRefsInDoc,
} from "../src/canvas/canvasAssetRefs.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const pngDataUrl = (tag) => "data:image/png;base64," + Buffer.from("fake-" + tag).toString("base64");

/** 每本画布文档只在这些字段上出现资源引用（与 electron/canvas-exchange-ports.cjs 的写入口径一致）。*/
function sampleDoc(refs) {
  return {
    nodes: [
      { id: "n_url", type: "image", x: 0, y: 0, url: ASSET_PREFIX + refs[0], name: "主图" },
      { id: "n_refs_str", type: "image", url: "", refs: [ASSET_PREFIX + refs[1]], name: "refs 字符串" },
      { id: "n_refs_obj", type: "video", url: "", refs: [{ url: ASSET_PREFIX + refs[2], name: "输入1", role: "first_frame" }] },
      { id: "n_inputs", type: "image", url: pngDataUrl("cover"), inputs: [{ nodeId: "src", url: ASSET_PREFIX + refs[3], w: 100, h: 50 }], thumbnail: ASSET_PREFIX + refs[4] },
      { id: "n_params", type: "generator", url: "", params: { seed: 7, nested: { source: ASSET_PREFIX + refs[5] } } },
    ],
    connections: [],
    viewport: { x: 0, y: 0, scale: 1 },
    logs: [{ id: "l1", refs: [{ url: ASSET_PREFIX + refs[6], name: "run ref" }] }],
  };
}

test("① 多引用分批转换：41 个引用全部转成 data URL，批次上限内并发，且 0 个 openarc-asset: 残留", async () => {
  const refs = Array.from({ length: 41 }, (_, i) => "res_batch_" + i);
  const doc = { nodes: refs.map((r, i) => ({ id: "n" + i, type: "image", url: ASSET_PREFIX + r })), connections: [], logs: [] };
  const cache = new Map();
  const reverse = new Map();
  let active = 0, maxActive = 0, calls = 0;
  const result = await resolveAssetRefsInDoc(doc, {
    cache,
    reverse,
    resolve: async (ref) => {
      calls += 1; active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return pngDataUrl(ref);
    },
  });
  assert.equal(calls, 41, "41 个引用都要真的读一次（不能被 20 之类的上限截断）");
  assert.equal(result.fetched, 41);
  assert.equal(result.unavailable.length, 0);
  assert.ok(maxActive > 1, "要并行分批，不是全串行");
  assert.ok(maxActive <= ASSET_RESOLVE_BATCH, "并发不得超过批次上限，实际 " + maxActive);
  assert.equal(JSON.stringify(result.doc).includes(ASSET_PREFIX), false, "解析后的页面文档里不得再有 openarc-asset:");
  assert.equal(collectAssetRefs(result.doc).length, 0);
  assert.equal(result.doc.nodes[40].url, pngDataUrl("res_batch_40"));
});

test("② 非 url 字段引用全覆盖：refs[]（string / {url}）、inputs[].url、thumbnail、嵌套 params、logs[].refs", async () => {
  const refs = Array.from({ length: 7 }, (_, i) => "res_field_" + i);
  const doc = sampleDoc(refs);
  const cache = new Map();
  const reverse = new Map();
  const read = [];
  const result = await resolveAssetRefsInDoc(doc, {
    cache, reverse,
    resolve: async (ref) => { read.push(ref); return pngDataUrl(ref); },
  });
  assert.deepEqual([...read].sort(), [...refs].sort(), "每个承载字段里的引用都必须被读到");
  const out = JSON.stringify(result.doc);
  assert.equal(out.includes(ASSET_PREFIX), false, "所有承载字段都必须换掉，不能只处理 node.url");
  // 逐字段确认换成了对应的 data URL
  assert.equal(result.doc.nodes[0].url, pngDataUrl(refs[0]));
  assert.equal(result.doc.nodes[1].refs[0], pngDataUrl(refs[1]));
  assert.equal(result.doc.nodes[2].refs[0].url, pngDataUrl(refs[2]));
  assert.equal(result.doc.nodes[3].inputs[0].url, pngDataUrl(refs[3]));
  assert.equal(result.doc.nodes[3].thumbnail, pngDataUrl(refs[4]));
  assert.equal(result.doc.nodes[4].params.nested.source, pngDataUrl(refs[5]));
  assert.equal(result.doc.logs[0].refs[0].url, pngDataUrl(refs[6]));
});

test("③ 保存回写：所有字段的 data URL / 占位值都换回稳定 ref，用户旧 data URL 原样保留", async () => {
  const refs = Array.from({ length: 7 }, (_, i) => "res_back_" + i);
  const cache = new Map();
  const reverse = new Map();
  const resolved = (await resolveAssetRefsInDoc(sampleDoc(refs), { cache, reverse, resolve: async (r) => pngDataUrl(r) })).doc;
  // 用户自己粘进来、宿主没登记过的旧 data URL：不得被当成引用丢掉
  resolved.nodes.push({ id: "n_user", type: "image", url: pngDataUrl("user-upload"), refs: [pngDataUrl("user-extra")] });
  const back = restoreAssetRefsInDoc(resolved, reverse);
  assert.equal(back.nodes[0].url, ASSET_PREFIX + refs[0]);
  assert.equal(back.nodes[1].refs[0], ASSET_PREFIX + refs[1]);
  assert.equal(back.nodes[2].refs[0].url, ASSET_PREFIX + refs[2]);
  assert.equal(back.nodes[3].inputs[0].url, ASSET_PREFIX + refs[3]);
  assert.equal(back.nodes[3].thumbnail, ASSET_PREFIX + refs[4]);
  assert.equal(back.nodes[4].params.nested.source, ASSET_PREFIX + refs[5]);
  assert.equal(back.logs[0].refs[0].url, ASSET_PREFIX + refs[6]);
  assert.equal(back.nodes[5].url, pngDataUrl("user-upload"), "旧 data URL 必须原样保留");
  assert.equal(back.nodes[5].refs[0], pngDataUrl("user-extra"));
});

test("④ 读不出来的引用：换成 CSP 安全占位值（不是 openarc-asset: / 不是 data:image），保存可还原", async () => {
  const okRef = "res_ok", deadRef = "res_deleted";
  const doc = { nodes: [{ id: "n1", type: "image", url: ASSET_PREFIX + okRef }, { id: "n2", type: "image", url: ASSET_PREFIX + deadRef }], connections: [], logs: [] };
  const cache = new Map();
  const reverse = new Map();
  const result = await resolveAssetRefsInDoc(doc, { cache, reverse, resolve: async (ref) => (ref === deadRef ? null : pngDataUrl(ref)) });
  assert.deepEqual(result.unavailable, [deadRef]);
  const dead = result.doc.nodes[1].url;
  assert.ok(dead.startsWith(MISSING_ASSET_DATA_URL_PREFIX), "读不出来的引用要给占位值");
  assert.equal(dead.startsWith("data:image"), false, "占位值不能是 data:image（否则会覆盖 F3c 的『不复活旧图』判定）");
  assert.equal(refFromMissingAssetPlaceholder(dead), deadRef);
  // F3c 口径：页面里的值不含 "data:image"
  assert.equal(String(dead).slice(0, 24).indexOf("data:image"), -1);
  // 交给页面的那一份（保存回写之前）任何位置都不得残留 openarc-asset:（页面会拿去做 <img src>）
  assert.equal(JSON.stringify(result.doc).includes(ASSET_PREFIX), false);
  const back = restoreAssetRefsInDoc(result.doc, reverse);
  assert.equal(back.nodes[1].url, ASSET_PREFIX + deadRef, "占位值必须还原成原引用，保存不丢");
  assert.equal(back.nodes[0].url, ASSET_PREFIX + okRef);
});

test("⑤ 缓存命中不重复读：同一引用第二次解析 0 次受控读取", async () => {
  const cache = new Map();
  const reverse = new Map();
  let calls = 0;
  const resolve = async (ref) => { calls += 1; return pngDataUrl(ref); };
  const first = await resolveAssetRefsInDoc({ nodes: [{ id: "a", url: ASSET_PREFIX + "res_c" }], connections: [], logs: [] }, { cache, reverse, resolve });
  const second = await resolveAssetRefsInDoc({ nodes: [{ id: "a", url: ASSET_PREFIX + "res_c" }], connections: [], logs: [] }, { cache, reverse, resolve });
  assert.equal(calls, 1, "同一引用只读一次");
  assert.equal(first.doc.nodes[0].url, second.doc.nodes[0].url);
});

test("⑥ 占位值编解码只认自己的前缀：其它 data URL / 普通字符串不受影响", () => {
  assert.equal(refFromMissingAssetPlaceholder(pngDataUrl("x")), null);
  assert.equal(refFromMissingAssetPlaceholder("openarc-asset:res_x"), null);
  assert.equal(refFromMissingAssetPlaceholder(""), null);
  const ref = "res_0Q1ztl1yugZPiPdOeb3eGIDBixfbANZ6";
  assert.equal(refFromMissingAssetPlaceholder(missingAssetPlaceholder(ref)), ref);
  assert.equal(mapDocStrings({ a: [1, { b: "x" }] }, (s) => s + "!").a[1].b, "x!");
});

test("⑦ 安全边界未被放宽：CanvasHost 用本模块，且画布页 CSP 仍只允许 openarc-canvas: data: blob:（无网络来源）", () => {
  const host = fs.readFileSync(path.join(ROOT, "src", "canvas", "CanvasHost.tsx"), "utf8");
  assert.match(host, /from "\.\/canvasAssetRefs"/, "宿主必须复用被测模块");
  assert.match(host, /resolveAssetRefsInDoc\(/, "解析必须走被测模块");
  assert.match(host, /restoreAssetRefsInDoc\(/, "回写必须走被测模块");
  assert.equal(/refs\.slice\(\s*0\s*,\s*20\s*\)/.test(host), false, "20 的上限已去掉");
  // 页面列表 = 本仓**实际发布**的画布页。经典 canvas.html 仍在包内就一起验；
  // 它被删除后（重新 vendor 那一次）这份列表自然只剩保留页 —— 但两个保留页必须在包里，
  // 断言语义不放松：每个实际存在的页面都要过同一套 CSP 检查（不是只验一个、不是跳过）。
  const shippedPages = ["canvas.html", "canvas-list.html", "smart-canvas.html"].filter((page) =>
    fs.existsSync(path.join(ROOT, "public", "novai-canvas", "static", page)),
  );
  assert.ok(
    shippedPages.includes("canvas-list.html") && shippedPages.includes("smart-canvas.html"),
    "列表页与智能画布页必须在包里并受 CSP 断言覆盖",
  );
  for (const page of shippedPages) {
    const html = fs.readFileSync(path.join(ROOT, "public", "novai-canvas", "static", page), "utf8");
    const meta = /Content-Security-Policy" content="([^"]+)"/i.exec(html);
    assert.ok(meta, page + " 有 CSP");
    assert.match(meta[1], /img-src openarc-canvas: data: blob:;/, page + " img-src 仍是原有白名单");
    assert.equal(/https?:|\*/.test(meta[1]), false, page + " CSP 不得新增网络来源 / 通配");
  }
});
