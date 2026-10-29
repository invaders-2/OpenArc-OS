/**
 * 对话侧栏「插件 / 应用」：
 *   ① 应用页标的「要批准」动作，必须正好落在 dsh-tool-profile 的写工具里；其余都在读工具里
 *   ② ChatApp 接好了两个入口，插件页「在对话中使用」走 Composer.addPick
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { READ_TOOL_IDS, WRITE_TOOL_IDS } = require("../electron/dsh-tool-profile.cjs");
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");

function caps(src, field) {
  const out = [];
  for (const m of src.matchAll(new RegExp(field + ": \\[((?:\\[\"[^\"]+\", \"[^\"]+\"\\](?:, )?)*)\\]", "g"))) {
    for (const t of m[1].matchAll(/\["[^"]+", "([^"]+)"\]/g)) out.push(t[1]);
  }
  return out;
}

test("应用页的读 / 写标注与工具分组一致", () => {
  const src = read("src-vue/apps/chat/AppsPanel.vue");
  const reads = caps(src, "reads");
  const writes = caps(src, "writes");
  assert.ok(reads.length >= 10 && writes.length >= 5);
  for (const id of reads) assert.ok(READ_TOOL_IDS.includes(id), "不需批准的动作必须是读工具：" + id);
  for (const id of writes) assert.ok(WRITE_TOOL_IDS.includes(id), "要批准的动作必须是写工具：" + id);
  assert.deepEqual([...writes].sort(), [...WRITE_TOOL_IDS].sort(), "每个写工具都要在应用页标出来");
});

test("ChatApp 接好插件 / 应用入口", () => {
  const app = read("src-vue/apps/ChatApp.vue");
  assert.match(app, /data-chat-nav-plugins/);
  assert.match(app, /data-chat-nav-apps/);
  assert.match(app, /<PluginsPanel @use="useInChat"/);
  assert.match(app, /<AppsPanel @try="tryInChat"/);
  assert.match(app, /composer\.value\?\.addPick\(pick\)/);
  assert.match(read("src-vue/apps/chat/Composer.vue"), /defineExpose\(\{[^}]*addPick/);
});
