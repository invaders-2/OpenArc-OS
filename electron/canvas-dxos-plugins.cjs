"use strict";
/**
 * 画布插件宿主（数据 + 网络，来源：DX server/canvasPlugins.ts:176-257、
 * server/developerNetwork.ts 的受控出网口径）。
 *
 * 边界：
 *   · 插件必须是**已安装且启用**的开发者 App，且清单声明了 canvas（画布插件）；
 *   · 数据落 <dxos>/canvas-plugins/data/<user>/<plugin>/<key>.json，key 白名单字符、原子写、
 *     容量取该插件 canvas 节点 Manifest 里 host.storage.maxBytes（未声明即拒绝，不兜底）；
 *   · 网络不在这里另造策略：委托既有 developer/network/request（App 声明白名单 + DNS 公网校验 +
 *     限流 + app_network_audit 审计），画布只做插件身份/启用校验；
 *   · 返回值不含绝对路径；错误结构化为 { ok:false, error, detail }。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR_NAME = "canvas-plugins";
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const USER_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const DATA_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_VALUE_BYTES_DEFAULT = 1024 * 1024;
const ACTIONS = Object.freeze(["list", "get", "set", "delete"]);

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, detail = null) => ({ ok: false, error: String(error), detail });

function createCanvasPluginHost({ developerStore = null, developerService = null, dataRoot = null, clock = null, pluginExecutor = null } = {}) {
  if (!developerStore || typeof developerStore.currentRelease !== "function" || typeof developerStore.readRelease !== "function") {
    throw new Error("createCanvasPluginHost 需要 developerStore");
  }
  if (!dataRoot) throw new Error("createCanvasPluginHost 需要 dataRoot");
  const root = path.resolve(String(dataRoot), DATA_DIR_NAME, "data");
  const now = typeof clock === "function" ? clock : () => Date.now();

  function manifestStorageLimit(release, current) {
    const manifest = release && release.manifest ? release.manifest : null;
    const canvas = manifest && manifest.canvas ? manifest.canvas : null;
    if (!canvas) return null;
    let sourceDir = null;
    try { sourceDir = path.resolve(String(dataRoot), String(current.packagePath || "")); } catch { sourceDir = null; }
    if (!sourceDir) return null;
    const limits = [];
    for (const relative of Array.isArray(canvas.nodeManifests) ? canvas.nodeManifests : []) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(path.join(sourceDir, relative), "utf8")); } catch { continue; }
      const nodes = Array.isArray(parsed && parsed.nodes) ? parsed.nodes : [];
      for (const node of nodes) {
        const storage = node && node.host && node.host.storage;
        if (!storage || storage.enabled !== true) continue;
        const maxBytes = Number.isFinite(Number(storage.maxBytes)) && Number(storage.maxBytes) >= 1024 ? Math.min(Number(storage.maxBytes), 5 * 1024 * 1024) : MAX_VALUE_BYTES_DEFAULT;
        limits.push(maxBytes);
      }
    }
    return limits.length ? Math.min(...limits) : null;
  }

  /**
   * 已安装 + 已启用 + 有 canvas 声明的插件策略。
   * requireStorage：数据命令需要 host.storage 声明；网络命令走 developerNetwork 的白名单，
   * 不要求插件同时声明本地存储。
   */
  function policyOf(userId, pluginId, { requireStorage = false } = {}) {
    const id = String(pluginId || "").trim();
    if (!PLUGIN_ID_RE.test(id)) return fail("INVALID_INPUT", "pluginId");
    const installed = developerStore.getInstalled(userId, id);
    if (!installed) return fail("FORBIDDEN", "插件未安装或未启用：" + id);
    const current = developerStore.currentRelease(id);
    if (!current) return fail("NOT_FOUND", "插件版本不存在：" + id);
    let release;
    try { release = developerStore.readRelease(id, current.packagePath); }
    catch (error) { return fail("NOT_FOUND", String((error && error.message) || error)); }
    const manifest = release && release.manifest ? release.manifest : null;
    if (!manifest || !manifest.canvas) return fail("FORBIDDEN", "不是画布插件：" + id);
    const storageLimit = manifestStorageLimit(release, current);
    if (requireStorage && !storageLimit) return fail("FORBIDDEN", "插件 Manifest 未声明 host.storage.enabled");
    return ok({ pluginId: id, manifest, storageLimit });
  }

  function dataFile(userId, pluginId, key) {
    const user = String(userId || "");
    if (!USER_ID_RE.test(user)) return fail("INVALID_INPUT", "userId");
    const safeKey = String(key || "").trim();
    if (!DATA_KEY_RE.test(safeKey) || safeKey.includes("..")) return fail("INVALID_INPUT", "插件数据 key 不合法");
    const userRoot = path.resolve(root, user);
    const pluginRoot = path.resolve(userRoot, pluginId);
    const target = path.resolve(pluginRoot, safeKey + ".json");
    if (userRoot !== root && !userRoot.startsWith(root + path.sep)) return fail("FORBIDDEN", "插件数据路径越界");
    if (!pluginRoot.startsWith(userRoot + path.sep) || !target.startsWith(pluginRoot + path.sep)) return fail("FORBIDDEN", "插件数据路径越界");
    return ok({ userRoot, pluginRoot, target, key: safeKey });
  }

  /** 数据访问：action ∈ list / get / set / delete。 */
  function data({ userId, pluginId, action, key, value } = {}) {
    const auth = policyOf(userId, pluginId, { requireStorage: true });
    if (!auth.ok) return auth;
    const act = String(action || "");
    if (!ACTIONS.includes(act)) return fail("INVALID_INPUT", "插件数据 action 只支持 get、set、delete、list");
    const file = dataFile(userId, pluginId, act === "list" ? "list" : key);
    if (!file.ok) return file;
    if (act === "list") {
      let entries = [];
      try { entries = fs.readdirSync(file.pluginRoot, { withFileTypes: true }); } catch { entries = []; }
      return ok({ keys: entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -5)).sort() });
    }
    if (act === "get") {
      if (!fs.existsSync(file.target)) return ok({ key: file.key, exists: false, value: null });
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(file.target, "utf8")); }
      catch { return fail("INTERNAL_ERROR", "插件数据不是有效 JSON"); }
      return ok({ key: file.key, exists: true, value: parsed });
    }
    if (act === "delete") {
      try { fs.rmSync(file.target, { force: true }); } catch { return fail("INTERNAL_ERROR", "插件数据删除失败"); }
      return ok({ key: file.key, deleted: true });
    }
    let content;
    try { content = Buffer.from(JSON.stringify(value == null ? null : value), "utf8"); }
    catch { return fail("INVALID_INPUT", "插件数据 value 不能序列化为 JSON"); }
    if (content.length > auth.storageLimit) return fail("LIMIT_EXCEEDED", "插件数据超过容量限制（" + auth.storageLimit + " bytes）");
    try {
      fs.mkdirSync(file.pluginRoot, { recursive: true });
      const temporary = file.target + "." + process.pid + "." + now().toString(36) + ".tmp";
      fs.writeFileSync(temporary, content);
      fs.renameSync(temporary, file.target);
    } catch (error) {
      return fail("INTERNAL_ERROR", String((error && error.message) || error));
    }
    return ok({ key: file.key, saved: true, bytes: content.length });
  }

  /** 网络：只委托既有 developer/network/request；插件身份先过 policyOf。 */
  async function network({ sessionRef, userId, pluginId, request = {} } = {}) {
    const auth = policyOf(userId, pluginId);
    if (!auth.ok) return auth;
    if (!developerService || typeof developerService.execute !== "function") return fail("DEPENDENCY_UNAVAILABLE", "developerService");
    const input = request && typeof request === "object" ? request : {};
    let result;
    try {
      result = await developerService.execute("developer/network/request", {
        appId: auth.pluginId,
        url: input.url,
        method: input.method,
        headers: input.headers,
        body: input.body,
        responseType: input.responseType,
      }, { sessionRef, appId: "canvas", requestId: input.requestId });
    } catch (error) {
      return fail(String((error && error.code) || "NETWORK_FAILED"), String((error && error.message) || error));
    }
    if (!result || result.ok !== true) return fail((result && result.error) || "NETWORK_FAILED", (result && result.detail) || null);
    return ok({ response: result.value });
  }

  // -------------------------------------------------------------------------
  // task-25 A15：插件运行期注册表（registry.json + tombstone）与 execute 分派
  // -------------------------------------------------------------------------
  const registryFile = path.join(path.resolve(String(dataRoot), DATA_DIR_NAME), "registry.json");

  function readRegistry() {
    try { return JSON.parse(fs.readFileSync(registryFile, "utf8")); }
    catch { return { version: 1, updatedAt: 0, plugins: [], tombstones: [] }; }
  }

  function rebuildRegistry(userId) {
    const current = readRegistry();
    const previous = new Map((current.plugins || []).map((entry) => [entry.pluginId, entry]));
    const seen = new Set();
    const plugins = [];
    let installed = [];
    try { installed = developerStore.listInstalled(userId) || []; } catch { installed = []; }
    for (const item of installed) {
      const id = String(item && (item.appId || item.id) || "");
      if (!PLUGIN_ID_RE.test(id) || item.enabled === false) continue;
      const release = developerStore.currentRelease(id);
      if (!release) continue;
      let read;
      try { read = developerStore.readRelease(id, release.packagePath); } catch { continue; }
      const manifest = read && read.manifest ? read.manifest : null;
      if (!manifest || !manifest.canvas) continue;
      const sourceDir = path.resolve(String(dataRoot), String(release.packagePath || ""));
      const nodeTypes = [];
      const templates = [];
      for (const relative of Array.isArray(manifest.canvas.nodeManifests) ? manifest.canvas.nodeManifests : []) {
        let parsed;
        try { parsed = JSON.parse(fs.readFileSync(path.join(sourceDir, relative), "utf8")); } catch { continue; }
        for (const node of Array.isArray(parsed.nodes) ? parsed.nodes : []) {
          const type = String((node && (node.nodeType || node.type)) || "").trim();
          if (type) nodeTypes.push({ type, title: String(node.title || type), manifest: relative });
        }
      }
      for (const relative of Array.isArray(manifest.canvas.templateManifests) ? manifest.canvas.templateManifests : []) {
        let parsed;
        try { parsed = JSON.parse(fs.readFileSync(path.join(sourceDir, relative), "utf8")); } catch { continue; }
        for (const template of Array.isArray(parsed.templates) ? parsed.templates : []) {
          const id = String((template && (template.id || template.templateId)) || "").trim();
          if (id) templates.push({ id, title: String(template.title || id), manifest: relative });
        }
      }
      if (!nodeTypes.length && !templates.length) continue;
      seen.add(id);
      plugins.push({ pluginId: id, appId: id, version: String(release.version || ""), nodeTypes, templates, updatedAt: now() });
    }
    const tombstones = [];
    for (const entry of previous.values()) if (!seen.has(entry.pluginId) && !(current.tombstones || []).some((t) => t.pluginId === entry.pluginId)) tombstones.push({ pluginId: entry.pluginId, removedAt: now() });
    tombstones.push(...(current.tombstones || []));
    const next = { version: 1, updatedAt: now(), plugins, tombstones };
    try {
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      const temporary = registryFile + "." + process.pid + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
      fs.renameSync(temporary, registryFile);
    } catch (error) { return fail("INTERNAL_ERROR", String((error && error.message) || error)); }
    return ok({ registry: next });
  }

  function registry({ rebuild = false, userId = null } = {}) {
    if (rebuild) { const rebuilt = rebuildRegistry(userId); if (!rebuilt.ok) return rebuilt; }
    return ok({ registry: readRegistry() });
  }

  async function execute({ userId, pluginId, executorType = "workflow", action = "execute", input = null } = {}) {
    const auth = policyOf(userId, pluginId);
    if (!auth.ok) return auth;
    const kind = String(executorType || "workflow").toLowerCase();
    if (kind === "builtin") return fail("FORBIDDEN", "builtin 执行器不可由插件调用");
    if (kind === "app-bridge" || kind === "app_bridge") return fail("CONFLICT", "app-bridge 执行器不可用");
    if (!["skill", "mcp-tool", "mcp_tool", "agent-tool", "agent_tool", "workflow"].includes(kind)) return fail("INVALID_INPUT", "executorType 只支持 skill / mcp-tool / agent-tool / workflow");
    if (typeof pluginExecutor !== "function") return fail("DEPENDENCY_UNAVAILABLE", "pluginExecutor");
    try {
      const result = await pluginExecutor({ pluginId: auth.pluginId, manifest: auth.manifest, executorType: kind, action: String(action || "execute"), input });
      return ok({ result: result == null ? null : result });
    } catch (error) {
      return fail(String((error && error.code) || "PLUGIN_EXECUTION_FAILED"), String((error && error.message) || error));
    }
  }

  return Object.freeze({ data, network, policyOf, registry, rebuildRegistry, execute });
}

module.exports = { createCanvasPluginHost };
