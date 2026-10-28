"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CanvasAssetLibraryService } = require("../canvas-dxos-asset-library.cjs");

function setup() {
  const library = { id: "lib1", owner_user_id: "u1", organization_id: "t1", visibility: "PRIVATE", public_access: "READ", format: "x", version: 1, created_at: 1, updated_at: 1 };
  const items = [{ id: "prompt1", library_id: "lib1", kind: "prompt", title: "系统提示词", prompt: "x", tags_json: "[]", created_at: 1, updated_at: 1 }];
  const store = {
    libraryById: (id) => id === "lib1" ? library : null,
    memberOfLibrary: () => null,
    itemsOfLibrary: (id) => id === "lib1" ? items : [],
    countItems: () => items.length,
    itemById: (id) => items.find((item) => item.id === id) || null,
    insertItem: (row) => { const item = { ...row, library_id: row.libraryId, tags_json: "[]", workflow_json: row.workflowJson }; items.push(item); return item; },
    updateItem: (id, patch) => { const item = items.find((row) => row.id === id); if (!item) return null; if (patch.title != null) item.title = patch.title; if (patch.prompt != null) item.prompt = patch.prompt; if (patch.workflowJson != null) item.workflow_json = patch.workflowJson; return item; },
    deleteItem: (id) => { const index = items.findIndex((row) => row.id === id); if (index >= 0) items.splice(index, 1); return true; },
  };
  const identity = { validateSession: (ref) => ({ ok: true, user: { id: ref === "u2" ? "u2" : "u1" } }) };
  return new CanvasAssetLibraryService({ identity, store, clock: () => 1000 });
}
const ctx = { sessionRef: "u1" };

test("AI character create/list/update/delete", () => {
  const service = setup();
  const created = service.characterCreate({ context: ctx, libraryId: "lib1", name: "小蓝", description: "蓝色角色", prompt: "hero", referenceUrls: ["https://example.com/a.png", "openarc-asset:res_1"] });
  assert.equal(created.ok, true);
  assert.equal(created.character.name, "小蓝");
  assert.equal(created.character.referenceUrls.length, 2);
  const listed = service.characterList({ context: ctx, libraryId: "lib1" });
  assert.equal(listed.characters.length, 1);
  const updated = service.characterUpdate({ context: ctx, libraryId: "lib1", itemId: created.character.id, name: "小蓝2", description: "更新" });
  assert.equal(updated.ok, true);
  assert.equal(updated.character.name, "小蓝2");
  assert.equal(service.characterDelete({ context: ctx, libraryId: "lib1", itemId: created.character.id }).ok, true);
  assert.equal(service.characterList({ context: ctx, libraryId: "lib1" }).characters.length, 0);
});

test("AI character validation and permission", () => {
  const service = setup();
  assert.equal(service.characterCreate({ context: ctx, libraryId: "lib1", name: "" }).error, "INVALID_INPUT");
  assert.equal(service.characterCreate({ context: ctx, libraryId: "lib1", name: "x", description: "d".repeat(501) }).error, "INVALID_INPUT");
  assert.equal(service.characterCreate({ context: ctx, libraryId: "lib1", name: "x", prompt: "p".repeat(4001) }).error, "INVALID_INPUT");
  assert.equal(service.characterCreate({ context: ctx, libraryId: "lib1", name: "x", referenceUrls: ["file:///tmp/a.png"] }).error, "INVALID_INPUT");
  assert.equal(service.characterCreate({ context: { sessionRef: "u2" }, libraryId: "lib1", name: "x" }).error, "NOT_FOUND_OR_FORBIDDEN");
  assert.equal(service.characterList({ context: ctx, libraryId: "lib1" }).characters.length, 0);
});
