/**
 * task-68 · 内置 App 的工具/文件/浏览器/画布/MCP/网络基线权限。
 *
 * 只补 App Grant（app_resource_grants），不创建 approval / lease，也不替用户批准任何受控写：
 * 受控写仍由 Tool Facade / SideEffectAuthority 逐次审批。播种一次（tool-baseline-v1 记录），
 * 幂等；撤销后不因重启再次补回。
 */
"use strict";

const authz = require("./authorization-domain.cjs");

// app_policy_provisions.policy_key 有 CHECK 约束，只允许 resource/model/mcp/tool；工具族就是 "tool"。
const BASELINE_POLICY_KEY = "tool";
const FILES_READ = "files.read";
const FILES_WRITE = "files.write";
const MUSIC_PLAY = "music.play";
const MCP_CALL = "mcp.call";
const NETWORK_FETCH = "network.fetch";
const TOOL = authz.TOOL_ACTION;

const ALL_TOOL_ACTIONS = Object.freeze([...authz.TOOL_ACTIONS]);
const RESOURCE_TOOL_ACTIONS = Object.freeze([
  TOOL.RESOURCE_READ_METADATA, TOOL.RESOURCE_SEARCH, TOOL.RESOURCE_TRASH, TOOL.RESOURCE_READ_CONTENT, TOOL.RESOURCE_SAVE_TEXT,
]);

/**
 * 内置应用 → 基线权限。
 * 说明：全局 AI（ai）是 agent 工具调用的宿主 App，必须具备全部内置工具 action；
 * 其余内置应用只拿自己域内需要的部分，避免"所有 App 都拿全部权限"。
 */
const BUILTIN_APP_PERMISSIONS = Object.freeze({
  ai: Object.freeze([...ALL_TOOL_ACTIONS, FILES_READ, FILES_WRITE, MUSIC_PLAY, MCP_CALL, NETWORK_FETCH]),
  canvas: Object.freeze([TOOL.CANVAS_READ, TOOL.CANVAS_EDIT, FILES_READ, FILES_WRITE]),
  browser: Object.freeze([TOOL.BROWSER_READ, TOOL.BROWSER_NAVIGATE, FILES_READ]),
  "resource-library": Object.freeze([...RESOURCE_TOOL_ACTIONS, FILES_READ, FILES_WRITE]),
  "skill-runtime": Object.freeze([...ALL_TOOL_ACTIONS, FILES_READ, FILES_WRITE, MCP_CALL, NETWORK_FETCH]),
  "image-generator": Object.freeze([FILES_READ, FILES_WRITE]),
  "video-generator": Object.freeze([FILES_READ, FILES_WRITE]),
  photoshop: Object.freeze([FILES_READ, FILES_WRITE]),
  illustrator: Object.freeze([FILES_READ, FILES_WRITE]),
});

function parseActions(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  try { const parsed = JSON.parse(raw || "[]"); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

/**
 * 幂等种入。返回 { ok, seeded, skipped, changed }。
 * 只写 app_resource_grants + authorization_audit + app_policy_provisions(tool-baseline-v1)。
 */
function seedBuiltinAppToolGrants({ authStore, organizationId, grantedBy = null, now = null } = {}) {
  const org = String(organizationId || "");
  if (!authStore || !org) return { ok: false, error: "INVALID_INPUT", seeded: [], skipped: [], changed: [] };
  const at = typeof now === "function" ? now() : (now == null ? Date.now() : Number(now));
  const seeded = [];
  const skipped = [];
  const changed = [];
  try {
    authStore.transactSync(() => {
      for (const [appId, permissions] of Object.entries(BUILTIN_APP_PERMISSIONS)) {
        if (!authStore.appById(appId)) { skipped.push({ appId, reason: "APP_NOT_FOUND" }); continue; }
        const provision = authStore.policyProvisionByKey({ organizationId: org, appId, policyKey: "tool" });
        const grants = authStore.appGrantsForApp(appId, org) || [];
        const toolGrant = grants.find((grant) => String(grant.scope || "") === "TOOL" && String(grant.resource_type || "") === "tool" && !grant.resource_id && !grant.collection_id && !grant.department_id) || null;
        // 已播种过且 grant 已被用户撤销：不因重启/登录再次补回（墓碑语义）。
        if (provision && provision.provisioned_at != null && !toolGrant) { skipped.push({ appId, reason: "REVOKED_OR_ALREADY_SEEDED" }); continue; }
        const existing = toolGrant ? parseActions(toolGrant.actions) : [];
        const merged = [...existing];
        for (const permission of permissions) if (!merged.includes(permission)) merged.push(permission);
        const added = merged.filter((action) => !existing.includes(action));
        if (added.length) {
          authStore.upsertAppGrant({ appId, scope: "TOOL", resourceType: "tool", actions: merged, grantedBy, organizationId: org });
          authStore.auditAuthorization({
            actorUserId: grantedBy || null,
            appId,
            action: "app.toolBaselineSeed",
            decision: "ALLOW",
            reasonCode: "ALLOW",
            permissionSource: authz.ALLOW_SOURCE.SUPER_ADMIN,
            oldPermissions: existing,
            newPermissions: merged,
          });
          changed.push({ appId, added });
        }
        authStore.upsertPolicyProvision({ organizationId: org, appId, policyKey: BASELINE_POLICY_KEY, provisionedAt: at, provisionedBy: grantedBy || "system:builtin-tool-baseline" });
        seeded.push({ appId, actions: merged });
      }
    });
    return { ok: true, seeded, skipped, changed };
  } catch (error) {
    return { ok: false, error: "SEED_FAILED", detail: String((error && error.message) || error).slice(0, 200), seeded, skipped, changed };
  }
}

module.exports = { BASELINE_POLICY_KEY, BUILTIN_APP_PERMISSIONS, ALL_TOOL_ACTIONS, RESOURCE_TOOL_ACTIONS, seedBuiltinAppToolGrants };
