/**
 * D3-04D · 治理 / 集成装配 + IPC。
 *
 * 产品主进程与 UI 探针共用这一份接线：
 * - governance:command  —— 治理（Users / Departments / Apps / Audit / Scope / Ownership / Bulk）
 * - resource:command    —— Projects / Canvas / Picker / Export（在 resource-bootstrap 内扩展）
 */
"use strict";

const { IntegrationStore } = require("./integration-store.cjs");
const { ProjectService, CanvasService } = require("./integration-service.cjs");
const { GovernanceService } = require("./governance-service.cjs");
const { ResourcePickerService } = require("./picker-service.cjs");

function createGovernanceBundle({ identityStore, authorization, authStore, resourceStore, searchService, clock = null, logger = null } = {}) {
  if (!identityStore) throw new Error("createGovernanceBundle 需要 identityStore");
  if (!authorization) throw new Error("createGovernanceBundle 需要 authorization");
  if (!authStore) throw new Error("createGovernanceBundle 需要 authStore");
  if (!resourceStore) throw new Error("createGovernanceBundle 需要 resourceStore");
  const integrationStore = new IntegrationStore({ identity: identityStore, clock });
  const projectService = new ProjectService({ identity: identityStore, integrationStore, authService: authorization, resourceStore, logger });
  const canvasService = new CanvasService({ identity: identityStore, integrationStore, authService: authorization, resourceStore, logger });
  const governanceService = new GovernanceService({ identity: identityStore, authService: authorization, authStore, resourceStore, integrationStore, logger });
  const pickerService = new ResourcePickerService({ identity: identityStore, authService: authorization, searchService, resourceStore, logger, clock });
  return { integrationStore, projectService, canvasService, governanceService, pickerService };
}

/** 渲染进程可下发的治理命令白名单。新增能力必须显式登记。 */
const GOVERNANCE_COMMANDS = Object.freeze([
  "governance/listUsers",
  "governance/getUser",
  "governance/createUser",
  "governance/setUserStatus",
  "governance/setUserRole",
  "governance/moveUserDepartment",
  "governance/resetPassword",
  "governance/listDepartments",
  "governance/getDepartment",
  "governance/createDepartment",
  "governance/updateDepartment",
  "governance/deleteDepartment",
  "governance/addDepartmentMember",
  "governance/removeDepartmentMember",
  "governance/listResourceAccess",
  "governance/previewScopeChange",
  "governance/changeScope",
  "governance/grantResourceAccess",
  "governance/revokeResourceAccess",
  "governance/bulkGrant",
  "governance/bulkRevoke",
  "governance/transferOwnership",
  "governance/bulkTransferOwnership",
  "governance/listApps",
  "governance/getAppAccess",
  "governance/grantAppAccess",
  "governance/revokeAppAccess",
  "governance/setAppStatus",
  "governance/listAudit",
]);

function registerGovernanceIpc({ ipcMain, service, authorization, identity, isTrusted }) {
  const gov = service && service.governanceService ? service.governanceService : service;
  ipcMain.handle("governance:command", async (e, command) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!gov) return { ok: false, error: "INTERNAL_ERROR", detail: "governance-not-ready" };
    if (!command || typeof command !== "object") return { ok: false, error: "INVALID_INPUT" };
    const type = String(command.type || "");
    if (!GOVERNANCE_COMMANDS.includes(type)) return { ok: false, error: "INVALID_INPUT" };
    const context = { sessionRef: identity?.current ?? null, appId: command.appId ? String(command.appId) : "resource-library", source: "ui", requestId: command.requestId };
    try {
      switch (type) {
        case "governance/listUsers": return gov.listUsers({ context });
        case "governance/getUser": return gov.getUserDetail({ context, userId: command.userId });
        case "governance/createUser": return authorization.createUser({ context, identifier: command.identifier, password: command.password, displayName: command.displayName, role: command.role });
        case "governance/setUserStatus": return authorization.setUserStatus({ context, userId: command.userId, status: command.status });
        case "governance/setUserRole": return authorization.setUserRole({ context, userId: command.userId, role: command.role });
        case "governance/moveUserDepartment": return gov.moveUserDepartment({ context, userId: command.userId, fromDepartmentId: command.fromDepartmentId, toDepartmentId: command.toDepartmentId });
        case "governance/resetPassword": return gov.initiatePasswordReset({ context, userId: command.userId });
        case "governance/listDepartments": return gov.listDepartments({ context });
        case "governance/getDepartment": return gov.getDepartmentDetail({ context, departmentId: command.departmentId });
        case "governance/createDepartment": return authorization.createDepartment({ context, name: command.name, description: command.description });
        case "governance/updateDepartment": return authorization.updateDepartment({ context, departmentId: command.departmentId, name: command.name, description: command.description, status: command.status });
        case "governance/deleteDepartment": return gov.deleteDepartment({ context, departmentId: command.departmentId });
        case "governance/addDepartmentMember": return authorization.addDepartmentMember({ context, departmentId: command.departmentId, userId: command.userId, membershipRole: command.membershipRole });
        case "governance/removeDepartmentMember": return authorization.removeDepartmentMember({ context, departmentId: command.departmentId, userId: command.userId });
        case "governance/listResourceAccess": return gov.listResourceAccess({ context, resourceRef: command.resourceRef || command.resourceId });
        case "governance/previewScopeChange": return gov.previewScopeChange({ context, resourceRef: command.resourceRef || command.resourceId, scope: command.scope, departmentId: command.departmentId });
        case "governance/changeScope": return gov.changeScope({ context, resourceRef: command.resourceRef || command.resourceId, scope: command.scope, departmentId: command.departmentId, collectionId: command.collectionId });
        case "governance/grantResourceAccess": return gov.grantResourceAccess({ context, principalType: command.principalType, principalId: command.principalId, resourceId: command.resourceId, collectionId: command.collectionId, resourceType: command.resourceType, departmentId: command.departmentId, scope: command.scope, actions: command.actions, permissionSet: command.permissionSet });
        case "governance/revokeResourceAccess": return gov.revokeResourceAccess({ context, grantId: command.grantId });
        case "governance/bulkGrant": return gov.bulkGrant({ context, principalType: command.principalType, principalIds: command.principalIds, resourceId: command.resourceId, collectionId: command.collectionId, resourceType: command.resourceType, departmentId: command.departmentId, actions: command.actions, permissionSet: command.permissionSet });
        case "governance/bulkRevoke": return gov.bulkRevoke({ context, grantIds: command.grantIds });
        case "governance/transferOwnership": return gov.transferOwnership({ context, resourceId: command.resourceId, newOwnerUserId: command.newOwnerUserId });
        case "governance/bulkTransferOwnership": return gov.bulkTransferOwnership({ context, resourceIds: command.resourceIds, newOwnerUserId: command.newOwnerUserId });
        case "governance/listApps": return gov.listApps({ context });
        case "governance/getAppAccess": return gov.getAppAccess({ context, appId: command.appId });
        case "governance/grantAppAccess": return gov.grantAppAccess({ context, appId: command.appId, resourceId: command.resourceId, collectionId: command.collectionId, resourceType: command.resourceType, departmentId: command.departmentId, scope: command.scope, actions: command.actions, permissionSet: command.permissionSet, expiresAt: command.expiresAt });
        case "governance/revokeAppAccess": return gov.revokeAppAccess({ context, grantId: command.grantId });
        case "governance/setAppStatus": return gov.setAppStatus({ context, appId: command.appId, status: command.status });
        case "governance/listAudit": return gov.listAudit({ context, filter: command.filter, limit: command.limit });
        default: return { ok: false, error: "INVALID_INPUT" };
      }
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

module.exports = { createGovernanceBundle, registerGovernanceIpc, GOVERNANCE_COMMANDS };
