/** task-25 B02 · 相册共享区：canvas: / asset-library: 进入图库可见性判定。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPhotosShareAccess } = require("../electron/photos-share-access.cjs");

const board = { id: "cv_1", owner_user_id: "u1", organization_id: "org1", visibility: "PRIVATE" };
const lib = { id: "lib_1", owner_user_id: "u2", organization_id: "org1", visibility: "RESTRICTED", deleted_at: null };
const canvasStore = {
  boardById: (id) => (id === board.id ? board : null),
  boardsShared: (userId) => (userId === "u3" ? [board] : []),
};
const assetLibraryStore = {
  libraryById: (id) => (id === lib.id ? lib : null),
  memberOfLibrary: (libraryId, userId) => (libraryId === lib.id && userId === "u4" ? { role: "read" } : null),
};
const access = createPhotosShareAccess({ canvasStore, assetLibraryStore });

test("B02 · public / department 保持原语义", () => {
  assert.equal(access({ id: "u1", role: "member", departmentId: "d1" }, "public"), true);
  assert.equal(access({ id: "u1", role: "member", departmentId: "d1" }, "department:d1"), true);
  assert.equal(access({ id: "u1", role: "member", departmentId: "d1" }, "department:d2"), false);
  assert.equal(access({ id: "u1", role: "ADMIN" }, "department:d2"), true);
  assert.equal(access({ id: "u1" }, "unknown"), false);
});

test("B02 · canvas：owner / 共享成员 / 同组织可见；其他不可见", () => {
  assert.equal(access({ id: "u1", team_id: "org1" }, "canvas:cv_1"), true, "owner");
  assert.equal(access({ id: "u3", team_id: "org1" }, "canvas:cv_1"), true, "共享成员");
  assert.equal(access({ id: "u9", team_id: "org1" }, "canvas:cv_1"), false, "同组织不等于可见（PRIVATE）");
  assert.equal(access({ id: "u9", team_id: "org2" }, "canvas:cv_1"), false);
  assert.equal(access({ id: "u1" }, "canvas:missing"), false);
});

test("B02 · asset-library：owner / public / restricted 成员；非成员拒绝", () => {
  assert.equal(access({ id: "u2" }, "asset-library:lib_1"), true, "owner");
  assert.equal(access({ id: "u4" }, "asset-library:lib_1"), true, "restricted 成员");
  assert.equal(access({ id: "u9" }, "asset-library:lib_1"), false, "非成员");
  lib.visibility = "PUBLIC";
  assert.equal(access({ id: "u9" }, "asset-library:lib_1"), true);
  lib.visibility = "ORGANIZATION";
  assert.equal(access({ id: "u9", team_id: "org1" }, "asset-library:lib_1"), true);
  lib.visibility = "RESTRICTED";
});
