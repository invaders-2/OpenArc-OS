"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.OPENARC_ASSET_FOLDERS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "asset-folders-")), "folders.json");
const { CanvasAssetLibraryService } = require("../canvas-dxos-asset-library.cjs");

function makeService() {
  const library = { id: "lib1", owner_user_id: "u1", organization_id: null, visibility: "PRIVATE", public_access: "READ", format: "dx-canvas-asset-library/v1", version: 1, created_at: 1, updated_at: 1 };
  const items = [{ id: "i1", library_id: "lib1", kind: "asset", title: "A", group_name: "场景", tags_json: "[]", created_by: "u1", created_at: 1, updated_at: 1 }];
  const store = {
    libraryById: (id) => id === "lib1" ? library : null,
    memberOfLibrary: () => null,
    itemsOfLibrary: (id) => id === "lib1" ? items : [],
    countItems: () => items.length,
    itemById: (id) => items.find((item) => item.id === id) || null,
    updateItem: (id, patch) => { const item = items.find((row) => row.id === id); if (!item) return null; if (patch.group != null) item.group_name = patch.group; return item; },
  };
  const identity = { validateSession: (ref) => ({ ok: true, user: { id: ref === "u2" ? "u2" : "u1" } }) };
  return new CanvasAssetLibraryService({ identity, store, clock: () => 1000 });
}
const ctx = { sessionRef: "u1" };

test("folder create/list/rename/move", () => {
  const service = makeService();
  assert.equal(service.folderCreate({ context: ctx, libraryId: "lib1", name: "角色" }).ok, true);
  assert.equal(service.folderCreate({ context: ctx, libraryId: "lib1", name: "角色" }).error, "CONFLICT");
  assert.ok(service.folderList({ context: ctx, libraryId: "lib1" }).folders.some((folder) => folder.name === "角色"));
  assert.equal(service.folderRename({ context: ctx, libraryId: "lib1", from: "场景", to: "背景" }).ok, true);
  assert.equal(service.folderMove({ context: ctx, libraryId: "lib1", itemId: "i1", folder: "角色" }).ok, true);
  assert.equal(service.folderList({ context: ctx, libraryId: "lib1" }).folders.find((folder) => folder.name === "角色").count, 1);
});

test("folder move rejects missing folder and non-editor", () => {
  const service = makeService();
  assert.equal(service.folderMove({ context: ctx, libraryId: "lib1", itemId: "i1", folder: "不存在" }).error, "INVALID_INPUT");
  assert.equal(service.folderCreate({ context: { sessionRef: "u2" }, libraryId: "lib1", name: "X" }).error, "NOT_FOUND_OR_FORBIDDEN");
});


test("folder registry survives restart", () => {
  const first = makeService();
  assert.equal(first.folderCreate({ context: ctx, libraryId: "lib1", name: "重启保留" }).ok, true);
  const second = makeService();
  const folders = second.folderList({ context: ctx, libraryId: "lib1" }).folders;
  assert.ok(folders.some((folder) => folder.name === "重启保留" && folder.count === 0));
});
