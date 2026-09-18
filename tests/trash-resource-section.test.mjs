/**
 * 系统回收站「来自资源库」分区的数据源与授权测试。
 *
 * 回收站窗口的分区只调既有 resource/command：
 *   resource/query({ category: "trash" })  →  ResourceService.queryResources
 *   resource/restore / resource/permanentDelete
 * 本测试直接打真实 ResourceService，验证：
 *   · 已 TRASHED 的授权资源会出现在 category="trash"（列表非空、分区才会出现）
 *   · 未授权用户（同组织无 grant / 跨组织）**看不到**，且 total=0、响应里不含资源名 —— “无权限不出现、不提示存在”
 *   · restore 后不再出现在 trash 分区；再删 + permanentDelete 后彻底消失
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";

const f = await createResourceFixture();
after(() => f.close());
const alice = f.ctx("alice");
const dana = f.ctx("dana");
const bob = f.ctx("bob"); // 跨组织

test("已授权的 TRASHED 资源出现在 category=trash；恢复后消失", async () => {
  const created = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "回收站分区验证", content: "resource trash" });
  assert.equal(created.ok, true);
  const ref = created.resource.resourceRef;

  assert.equal(f.resourceService.delete({ context: alice, resourceRef: ref }).ok, true);
  const trash = f.resourceService.queryResources({ context: alice, category: "trash", limit: 60 });
  assert.equal(trash.ok, true);
  assert.ok(trash.items.some((i) => i.resourceRef === ref), "已授权的已删除资源应出现在回收站分区数据源里");
  assert.ok(trash.items.find((i) => i.resourceRef === ref).trashed === true);

  assert.equal(f.resourceService.restore({ context: alice, resourceRef: ref }).ok, true);
  const afterRestore = f.resourceService.queryResources({ context: alice, category: "trash", limit: 60 });
  assert.equal(afterRestore.items.some((i) => i.resourceRef === ref), false, "恢复后不应再出现在回收站分区");
});

test("未授权用户看不到别人的 TRASHED 资源（同组织无 grant / 跨组织），且不提示存在", async () => {
  const created = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "秘密回收站资源", content: "secret" });
  const ref = created.resource.resourceRef;
  f.resourceService.delete({ context: alice, resourceRef: ref });

  const danaTrash = f.resourceService.queryResources({ context: dana, category: "trash", limit: 60 });
  assert.equal(danaTrash.items.some((i) => i.resourceRef === ref), false, "同组织未授权用户不应看到");
  assert.equal(JSON.stringify(danaTrash).includes("秘密回收站资源"), false, "未授权时连名字都不应出现");

  const bobTrash = f.resourceService.queryResources({ context: bob, category: "trash", limit: 60 });
  assert.equal(bobTrash.total, 0, "跨组织用户看不到任何资源");
  assert.equal(JSON.stringify(bobTrash).includes("秘密回收站资源"), false);

  // 未授权用户也不能用分区里的动作恢复/永久删除它
  assert.equal(f.resourceService.restore({ context: dana, resourceRef: ref }).ok, false);
  assert.equal(f.resourceService.permanentDelete({ context: dana, resourceRef: ref }).ok, false);
});

test("永久删除后彻底消失（走 resource/permanentDelete）", async () => {
  const created = await f.resourceService.createResource({ context: alice, resourceType: "text", name: "待永久删除", content: "bye" });
  const ref = created.resource.resourceRef;
  f.resourceService.delete({ context: alice, resourceRef: ref });
  assert.equal(f.resourceService.permanentDelete({ context: alice, resourceRef: ref }).ok, true);
  const trash = f.resourceService.queryResources({ context: alice, category: "trash", limit: 60 });
  assert.equal(trash.items.some((i) => i.resourceRef === ref), false);
  assert.equal(f.resourceService.get({ context: alice, resourceRef: ref }).ok, false);
});
