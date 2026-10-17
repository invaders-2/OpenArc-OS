/** task-36 · 媒体/集成后端：Figma/Illustrator MCP 注册、在线 Skill 来源、紫鸟 Python 依赖。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPluginRegistry, optionalPlugins, integrationPlugins } = require("../electron/plugin-registry.cjs");
const { createOnlineSourceConfig, normalizeSource } = require("../electron/skill-online-source.cjs");
const { createSkillBundle } = require("../electron/skill-service.cjs");

const dirs = [];
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-task36-")); dirs.push(dir); return dir; }
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

test("B15 · Figma/Illustrator 登记为可选集成，MCP 模板进 registry，未安装结构化不可用", async () => {
  const ids = optionalPlugins().map((plugin) => plugin.id).sort();
  assert.deepEqual(ids, ["agnes", "figma", "illustrator", "modelscope", "runninghub"]);
  const figma = optionalPlugins().find((plugin) => plugin.id === "figma");
  assert.equal(figma.mcp.serverId, "figma");
  assert.equal(figma.mcp.transport, "stdio");
  assert.ok(figma.dependencies.some((dep) => dep.id === "figma.mcp" && dep.required === true));
  const illustrator = optionalPlugins().find((plugin) => plugin.id === "illustrator");
  assert.equal(illustrator.mcp.serverId, "illustrator");
  assert.ok(illustrator.dependencies.some((dep) => dep.id === "illustrator.adobe" && dep.required === true));

  const dir = tempDir();
  const probes = {
    binary: (target) => (target === "figma-developer-mcp" || target === "illustrator-mcp" ? { ok: true, status: "ok", detail: "" } : { ok: false, status: "missing", detail: "找不到 " + target }),
    credential: () => ({ ok: true, status: "ok", detail: "" }),
  };
  const registry = createPluginRegistry({ userDataDir: dir, plugins: optionalPlugins(), probes, capabilities: { fetch: async () => ({}) } });
  const figmaEnabled = await registry.enable("figma");
  assert.equal(figmaEnabled.ok, true, JSON.stringify(figmaEnabled));
  const figmaHealth = await registry.health("figma");
  assert.equal(figmaHealth.mcp.serverId, "figma");
  assert.equal(figmaHealth.mcp.command, "npx");
  assert.deepEqual(figmaHealth.mcp.args, ["-y", "figma-developer-mcp", "--stdio"]);

  const illustratorEnabled = await registry.enable("illustrator");
  assert.equal(illustratorEnabled.ok, false, "缺 Adobe 时不得启用");
  assert.equal(illustratorEnabled.error, "INTEGRATION_UNAVAILABLE");
  const illustratorHealth = await registry.health("illustrator");
  assert.equal(illustratorHealth.status, "disabled");
  assert.ok(illustratorHealth.missingRequired.includes("illustrator.adobe"));
});

test("D09 · 在线 Skill 来源查询/设置/清理；不新增命令，非法来源结构化拒绝", async () => {
  const dir = tempDir();
  const config = createOnlineSourceConfig({ userDataDir: dir });
  assert.deepEqual(config.get(), { version: 1, enabled: false, source: "", updatedAt: 0 });
  const set = config.set({ enabled: true, source: "npx skills add https://modelscope.cn/skills/owner/collection" });
  assert.equal(set.enabled, true);
  assert.match(config.get().source, /modelscope\.cn/);
  assert.throws(() => config.set({ enabled: true, source: "https://evil.example.com/x" }), /ModelScope/);
  assert.equal(config.clear().enabled, false);
  assert.throws(() => normalizeSource("x".repeat(13000)), /过长/);
  const service = fs.readFileSync(path.join(process.cwd(), "electron", "skill-service.cjs"), "utf8");
  assert.ok(service.includes("onlineSourceAction"));
  assert.equal(Object.keys(require("../electron/skill-domain.cjs").SKILL_COMMANDS).length, 15, "不得扩冻结命令白名单");
});

test("D09 · skill/pack/list|install 复用命令完成在线来源查询/设置（不新增白名单）", async () => {
  const dir = tempDir();
  const authorization = { resolveActor: () => ({ ok: true, user: { id: "u1", role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) };
  const bundle = createSkillBundle({ userDataDir: dir, authorization });
  const ctx = { sessionRef: "s1" };
  const before = await bundle.execute("skill/pack/list", { onlineSourceAction: "get" }, ctx);
  assert.equal(before.ok, true, JSON.stringify(before));
  assert.equal(before.value.onlineSource.enabled, false);
  const set = await bundle.execute("skill/pack/install", { onlineSourceAction: "set", enabled: true, source: "npx skills add https://modelscope.cn/skills/owner/collection" }, ctx);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.value.onlineSource.enabled, true);
  const after = await bundle.execute("skill/pack/list", { onlineSourceAction: "get" }, ctx);
  assert.match(after.value.onlineSource.source, /modelscope\.cn/);
  const clear = await bundle.execute("skill/pack/install", { onlineSourceAction: "clear" }, ctx);
  assert.equal(clear.value.onlineSource.enabled, false);
});

test("E03 · 紫鸟 Python 依赖：python3 必需、requests/selenium/openpyxl 缺失如实结构化", async () => {
  const dir = tempDir();
  const probes = {
    binary: (target) => (target === "python3" ? { ok: true, status: "ok", detail: "" } : { ok: false, status: "missing", detail: "找不到 " + target }),
    python: (target) => ({ ok: false, status: "missing", detail: "python3 -c \"import " + target + "\" 失败" }),
  };
  const registry = createPluginRegistry({ userDataDir: dir, plugins: integrationPlugins(), probes, capabilities: { fetch: async () => ({}) } });
  const enabled = await registry.enable("ziniao");
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.equal(enabled.value.status, "degraded");
  const report = await registry.health("ziniao");
  for (const id of ["ziniao.requests", "ziniao.selenium", "ziniao.openpyxl"]) {
    const dep = report.dependencies.find((item) => item.id === id);
    assert.equal(dep.status, "missing");
    assert.equal(dep.required, false);
  }
  assert.equal(report.missingRequired.includes("ziniao.python3"), false);
});
