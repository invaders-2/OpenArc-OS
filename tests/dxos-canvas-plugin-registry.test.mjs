/** task-25 A15 · 画布插件运行期注册表与 execute 分派。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCanvasPluginHost } = require("../electron/canvas-dxos-plugins.cjs");
const commands = require("../electron/canvas-dxos-commands.cjs");

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-canvas-plugin-"));
  return dir;
}

function fakeDeveloperStore({ installed = true } = {}) {
  return {
    getInstalled: (userId, appId) => (installed && appId === "demo-plugin" ? { appId: "demo-plugin", enabled: true } : null),
    listInstalled: () => (installed ? [{ appId: "demo-plugin", enabled: true }] : []),
    currentRelease: () => ({ packagePath: "pkg", version: "1.0.0" }),
    readRelease: () => ({
      manifest: {
        canvas: {
          nodeManifests: ["nodes.json"],
          templateManifests: ["templates.json"],
        },
      },
    }),
  };
}

test("A15 · registry.json 重建幂等；卸载后转 tombstone", () => {
  const dir = tempDir();
  try {
    const pkg = path.join(dir, "pkg");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "nodes.json"), JSON.stringify({ nodes: [{ type: "plugin.image", title: "插件出图", host: { storage: { enabled: true, maxBytes: 4096 } } }] }));
    fs.writeFileSync(path.join(pkg, "templates.json"), JSON.stringify({ templates: [{ id: "tpl-1", title: "模板一" }] }));
    const store = fakeDeveloperStore();
    const host = createCanvasPluginHost({ developerStore: store, dataRoot: dir, pluginExecutor: async ({ executorType, input }) => ({ executorType, echo: input }) });
    const first = host.rebuildRegistry("u1");
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.registry.plugins.length, 1);
    assert.equal(first.registry.plugins[0].pluginId, "demo-plugin");
    assert.deepEqual(first.registry.plugins[0].nodeTypes.map((node) => node.type), ["plugin.image"]);
    assert.deepEqual(first.registry.plugins[0].templates.map((tpl) => tpl.id), ["tpl-1"]);
    const registryPath = path.join(dir, "canvas-plugins", "registry.json");
    assert.ok(fs.existsSync(registryPath));
    const second = host.rebuildRegistry("u1");
    assert.equal(second.ok, true);
    assert.equal(second.registry.plugins.length, 1, "重建必须幂等");
    assert.equal(second.registry.tombstones.length, 0);

    const removedStore = fakeDeveloperStore({ installed: false });
    const removedHost = createCanvasPluginHost({ developerStore: removedStore, dataRoot: dir, pluginExecutor: async () => ({}) });
    const removed = removedHost.rebuildRegistry("u1");
    assert.equal(removed.ok, true);
    assert.equal(removed.registry.plugins.length, 0);
    assert.equal(removed.registry.tombstones.some((entry) => entry.pluginId === "demo-plugin"), true);
    const read = removedHost.registry({});
    assert.equal(read.registry.tombstones.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("A15 · execute 分派：注入执行器可用；builtin 403 / app-bridge 409 / 未注入执行器结构化缺失", async () => {
  const dir = tempDir();
  try {
    const pkg = path.join(dir, "pkg");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "nodes.json"), JSON.stringify({ nodes: [{ type: "plugin.image", host: { storage: { enabled: true, maxBytes: 4096 } } }] }));
    const store = fakeDeveloperStore();
    const host = createCanvasPluginHost({ developerStore: store, dataRoot: dir, pluginExecutor: async ({ executorType, action, input }) => ({ executorType, action, input }) });
    const ok = await host.execute({ userId: "u1", pluginId: "demo-plugin", executorType: "workflow", action: "run", input: { x: 1 } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.result.input, { x: 1 });
    assert.equal((await host.execute({ userId: "u1", pluginId: "demo-plugin", executorType: "builtin" })).error, "FORBIDDEN");
    assert.equal((await host.execute({ userId: "u1", pluginId: "demo-plugin", executorType: "app-bridge" })).error, "CONFLICT");
    assert.equal((await host.execute({ userId: "u1", pluginId: "demo-plugin", executorType: "unknown" })).error, "INVALID_INPUT");
    assert.equal((await host.execute({ userId: "u1", pluginId: "not-installed", executorType: "workflow" })).error, "FORBIDDEN");
    const noExecutor = createCanvasPluginHost({ developerStore: store, dataRoot: dir });
    const missing = await noExecutor.execute({ userId: "u1", pluginId: "demo-plugin", executorType: "workflow" });
    assert.equal(missing.error, "DEPENDENCY_UNAVAILABLE");
    assert.equal(missing.detail, "pluginExecutor");
    const registryCommands = commands.DXOS_CANVAS_COMMANDS.map((entry) => entry.command);
    assert.ok(registryCommands.includes("canvas/plugins/registry"));
    assert.ok(registryCommands.includes("canvas/plugins/execute"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
