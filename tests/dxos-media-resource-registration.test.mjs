/**
 * task-9 · 短剧出图 → OpenArc 资源库登记（幂等 / 可见 / 失败如实）。
 *
 * 真实资源域：tests/resource-fixtures.mjs（真实 IdentityStore + ResourceStore + ManagedStore +
 * ResourceService）；真实媒体域：createMediaBundle + media:command；真实 dxos-fs 虚拟文件树。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createMediaBundle } = require("../electron/media-service.cjs");
const { createMediaResourceRegistrar } = require("../electron/media-resource-registrar.cjs");
const { createDxosFsAdapterForUserData } = require("../electron/agent-service.cjs");
const mediaStore = require("../electron/media-store.cjs");
const mediaLibrary = require("../electron/media-library.cjs");
const mediaShortDrama = require("../electron/media-short-drama.cjs");

const tempDirs = [];
const openFixtures = [];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

afterEach(() => {
  mediaStore.resetMediaStoreForTests();
  mediaLibrary.resetLibraryForTests();
  mediaShortDrama.configureShortDrama({ dataDir: null, fsAdapter: null, fetchImpl: null, providerStore: null, modelGateway: null, mediaStore: null, renderSubmit: null, resourceRegistrar: null });
  while (openFixtures.length) { try { openFixtures.pop().close(); } catch { /* 已关 */ } }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeHarness({ withRegistrar = true } = {}) {
  const fixture = await createResourceFixture();
  openFixtures.push(fixture);
  const dir = tempDir("oa-media-resource-");
  const admin = fixture.identity.validateSession(fixture.sessions.admin, { sensitive: false }).user;
  const registrar = withRegistrar
    ? createMediaResourceRegistrar({ resourceService: fixture.resourceService, resourceStore: fixture.resourceStore, identity: fixture.identity, tempDir: path.join(dir, "tmp") })
    : null;
  const providerStore = {
    firstUsableProvider(caps) {
      return caps === "image"
        ? { id: "p-img", name: "图像站点", base_url: "http://127.0.0.1:9/v1", protocol: "openai", models: [{ model: "m-image", caps: ["image"], protocol: "openai" }] }
        : null;
    },
  };
  const generated = [];
  const modelGateway = {
    async generateImages(provider, model, params) {
      generated.push({ provider, model, params });
      return { images: [{ type: "b64", value: PNG.toString("base64"), mime: "image/png" }] };
    },
  };
  const bundle = createMediaBundle({
    userDataDir: dir,
    identityStore: fixture.identity,
    authorization: { resolveActor: () => ({ ok: true, user: { id: admin.id, team_id: admin.team_id } }) },
    fsAdapter: createDxosFsAdapterForUserData(dir),
    providerStore,
    modelGateway,
    resourceRegistrar: registrar,
    clock: () => Date.now(),
  });
  const context = { sessionRef: fixture.sessions.admin, appId: "ai" };
  return {
    fixture, dir, admin, registrar, bundle, context, generated,
    call: (command, payload = {}) => bundle.execute(command, payload, context),
    fixtureContext: fixture.adminCtx(),
  };
}

async function createShot(h) {
  const created = await h.call("media/short-drama/create", { name: "登记短剧" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const projectId = created.value.project.id;
  const added = await h.call("media/short-drama/shot/add", { projectId, shot: { title: "开场", prompt: "雨夜街道，人物撑伞", duration: 2 } });
  assert.equal(added.ok, true, JSON.stringify(added));
  return { projectId, shotId: added.value.shot.id };
}

test("登记幂等：同一份字节重复登记复用同一 ResourceRef，只落一行资源", async () => {
  const h = await makeHarness();
  const first = await h.registrar.registerBuffer({ context: { sessionRef: h.fixture.sessions.admin, appId: "ai" }, buffer: PNG, name: "分镜-1.png", mime: "image/png" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.dedupe, false);
  assert.match(first.resourceRef, /^resource:\/\/res_/);
  const second = await h.registrar.registerBuffer({ context: { sessionRef: h.fixture.sessions.admin, appId: "ai" }, buffer: PNG, name: "分镜-1.png", mime: "image/png" });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.dedupe, true);
  assert.equal(second.resourceRef, first.resourceRef);
  const rows = h.fixture.identity.connection.prepare("SELECT COUNT(*) AS c FROM library_resources").get().c;
  assert.equal(rows, 1, "同 checksum 不得重复插入 library_resources");
  const list = h.fixture.resourceService.list({ context: h.fixtureContext, filter: { resourceType: "image" } });
  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  assert.equal(list.items[0].resourceRef, first.resourceRef);
});

test("短剧出图：落盘同时登记资源库，分镜视图带 resourceRef，资源库可读", async () => {
  const h = await makeHarness();
  const { projectId, shotId } = await createShot(h);
  const image = await h.call("media/short-drama/shot/image", { projectId, shotId });
  assert.equal(image.ok, true, JSON.stringify(image));
  assert.equal(h.generated.length, 1);

  const view = await h.call("media/short-drama/get", { projectId });
  assert.equal(view.ok, true, JSON.stringify(view));
  const shotImage = view.value.images.find((entry) => entry.owner === "shot" && entry.ownerId === shotId);
  assert.ok(shotImage, "分镜视图应拍平出这张画面");
  assert.match(String(shotImage.resourceRef), /^resource:\/\/res_/);
  assert.equal(shotImage.resourceStatus, "registered");

  const list = h.fixture.resourceService.list({ context: h.fixtureContext, filter: { resourceType: "image" } });
  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  assert.equal(list.items[0].resourceRef, shotImage.resourceRef);
  assert.equal(list.items[0].mimeType, "image/png");
  assert.ok(list.items[0].size > 0);
  // IPC 返回值不得包含绝对路径。
  assert.equal(JSON.stringify(view.value).includes(h.dir), false);
});

test("短剧出图幂等：再次生成同一份字节复用同一 ResourceRef，资源行不翻倍", async () => {
  const h = await makeHarness();
  const { projectId, shotId } = await createShot(h);
  const first = await h.call("media/short-drama/shot/image", { projectId, shotId });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await h.call("media/short-drama/shot/image", { projectId, shotId });
  assert.equal(second.ok, true, JSON.stringify(second));
  const view = await h.call("media/short-drama/get", { projectId });
  const refs = view.value.images.map((entry) => entry.resourceRef);
  assert.equal(refs.length, 2);
  assert.equal(new Set(refs).size, 1, "同一内容应复用同一 ResourceRef");
  assert.ok(view.value.images.every((entry) => entry.resourceStatus === "deduped" || entry.resourceStatus === "registered"));
  const rows = h.fixture.identity.connection.prepare("SELECT COUNT(*) AS c FROM library_resources").get().c;
  assert.equal(rows, 1);
});

test("短剧渲染：真实 mediaStore 先把分镜登记为 video_assets（不再报服务端缺少素材）", async () => {
  const h = await makeHarness();
  const { projectId, shotId } = await createShot(h);
  assert.equal((await h.call("media/short-drama/shot/image", { projectId, shotId })).ok, true);
  const first = await h.call("media/short-drama/render", { projectId });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.job.status, "queued");
  assert.ok(first.value.job.id);
  const assets = mediaStore.listVideoAssetRows(projectId, h.admin.id);
  assert.equal(assets.length, 1, "选中分镜图必须落成 video_assets");
  assert.equal(assets[0].kind, "image");
  assert.ok(fs.existsSync(assets[0].file_path), "video_asset 文件必须真实落盘");
  // 再次提交渲染复用同一个 renderAssetId，不重复写素材。
  const second = await h.call("media/short-drama/render", { projectId });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(mediaStore.listVideoAssetRows(projectId, h.admin.id).length, 1);
});

test("未注入 registrar：出图仍成功，但 resourceRef 如实为 null（不假装已登记）", async () => {
  const h = await makeHarness({ withRegistrar: false });
  const { projectId, shotId } = await createShot(h);
  const image = await h.call("media/short-drama/shot/image", { projectId, shotId });
  assert.equal(image.ok, true, JSON.stringify(image));
  const view = await h.call("media/short-drama/get", { projectId });
  const shotImage = view.value.images.find((entry) => entry.owner === "shot" && entry.ownerId === shotId);
  assert.equal(shotImage.resourceRef, null);
  assert.equal(shotImage.resourceStatus, "unavailable");
});
