/**
 * 10-16 · 画布「素材库」面板 = OpenArc 资源库：libraryList 只列画布可引用的图片、带缩略图、不带原图；
 * 他人 PERSONAL 资源不出现；进回收站后消失。插入画布仍按引用经 readAsset 读取。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";

test("libraryList：本人图片可见（缩略图 + 引用）、他人不可见、进回收站后消失", async () => {
  const fx = await createResourceFixture();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-lib-"));
  try {
    const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    let thumbCalls = 0;
    const thumbnailer = {
      createFromBuffer: (buf) => ({
        isEmpty: () => buf.length === 0,
        getSize: () => ({ width: 1024, height: 768 }),
        resize: () => ({ toJPEG: () => { thumbCalls += 1; return Buffer.from("thumb"); } }),
        toJPEG: () => Buffer.from("thumb"),
      }),
    };
    const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, resourceService: fx.resourceService, clock: fx.clock, thumbnailer });
    service.attachRuntime({ tempDir });
    const ctx = (key) => ({ sessionRef: fx.sessions[key], appId: "canvas", source: "ui" });
    const cv = service.createCanvas({ context: ctx("admin"), title: "素材" });
    const imported = await service.importAsset({ context: ctx("admin"), canvasId: cv.canvas.canvasId, name: "主图.png", dataUrl: "data:image/png;base64," + PNG });
    assert.equal(imported.ok, true, JSON.stringify(imported));

    const mine = service.libraryList({ context: ctx("admin") });
    assert.equal(mine.ok, true, JSON.stringify(mine));
    const hit = mine.items.find((it) => it.ref === imported.ref);
    assert.ok(hit, "刚导入的图片应出现在素材面板");
    assert.equal(hit.name, "主图.png", "中文名保留原文");
    assert.equal(hit.thumbnail, "data:image/jpeg;base64," + Buffer.from("thumb").toString("base64"));
    assert.ok(!("dataUrl" in hit), "列表不带原图");
    // 缓存：同一版本不重复生成缩略图
    service.libraryList({ context: ctx("admin") });
    assert.equal(thumbCalls, 1);
    // 按名字筛选
    assert.equal(service.libraryList({ context: ctx("admin"), query: "不存在" }).items.length, 0);

    // 他人（同组织、非本人 PERSONAL）看不到
    const other = service.libraryList({ context: ctx("dana") });
    assert.equal(other.ok, true);
    assert.ok(!other.items.some((it) => it.ref === imported.ref));

    // 进回收站后消失
    fx.resourceService.delete({ context: fx.ctx("admin"), resourceRef: String(imported.ref).replace("openarc-asset:", "") });
    assert.ok(!service.libraryList({ context: ctx("admin") }).items.some((it) => it.ref === imported.ref));
  } finally {
    fx.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("libraryList：未登录 → 拒绝", async () => {
  const fx = await createResourceFixture();
  try {
    const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, resourceService: fx.resourceService, clock: fx.clock });
    const r = service.libraryList({ context: { sessionRef: "nope", appId: "canvas" } });
    assert.equal(r.ok, false);
  } finally { fx.close(); }
});
