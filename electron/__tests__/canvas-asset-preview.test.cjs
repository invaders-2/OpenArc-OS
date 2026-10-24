"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CanvasAssetLibraryService } = require("../canvas-dxos-asset-library.cjs");
test("itemView returns real previewUrl/url from readAsset", () => {
  const library = { id: "lib1", owner_user_id: "u1", organization_id: "t1", visibility: "PRIVATE", public_access: "READ" };
  const items = [{ id: "i1", library_id: "lib1", kind: "asset", title: "图", resource_ref: "r1", cover_ref: "c1", tags_json: "[]", created_at: 1, updated_at: 1 }];
  const store = { libraryById: () => library, memberOfLibrary: () => null, itemsOfLibrary: () => items, countItems: () => 1, itemById: (id) => items.find((i) => i.id === id) || null, countResourceRefs: () => 0, insertItem: (r) => r, updateItem: () => null, deleteItem: () => true };
  const service = new CanvasAssetLibraryService({ identity: { validateSession: () => ({ ok: true, user: { id: "u1" } }) }, store, canvasService: { readAsset: ({ ref }) => ({ ok: true, dataUrl: "data:image/png;base64," + ref }) } });
  const got = service.getLibrary({ context: {}, libraryId: "lib1" });
  assert.equal(got.ok, true);
  assert.equal(got.items[0].url, "data:image/png;base64,openarc-asset:r1");
  assert.equal(got.items[0].previewUrl, "data:image/png;base64,openarc-asset:c1");
  const empty = { ...items[0], resource_ref: null, cover_ref: null };
  items[0] = empty;
  const none = service.getLibrary({ context: {}, libraryId: "lib1" });
  assert.equal(none.items[0].url, undefined);
  assert.equal(none.items[0].previewUrl, undefined);
});
