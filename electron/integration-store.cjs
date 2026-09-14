/**
 * D3-04D · Projects / Canvas 集成持久层。
 *
 * 这里只存"引用关系"，不存第二套 ACL：
 * - project_resources 存 ResourceRef（resource_id），授权时逐资源重新走 D3-02。
 * - canvas_resource_nodes 存 ResourceRef + resource_version + version_mode，绝不存绝对路径。
 */
"use strict";

const crypto = require("node:crypto");

const SQL = {
  insertProject:
    "INSERT INTO projects (id, organization_id, department_id, owner_user_id, name, description, status, scope, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  projectById: "SELECT * FROM projects WHERE id = ?",
  projectsOfOrg: "SELECT * FROM projects WHERE organization_id = ? AND status = 'active' ORDER BY updated_at DESC, id",
  projectsOfDepartment: "SELECT * FROM projects WHERE organization_id = ? AND department_id = ? AND status = 'active' ORDER BY updated_at DESC, id",
  projectsOwnedBy: "SELECT * FROM projects WHERE owner_user_id = ? AND status = 'active' ORDER BY updated_at DESC, id",
  updateProject: "UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
  insertMember: "INSERT OR REPLACE INTO project_members (project_id, user_id, role, created_at) VALUES (?,?,?,?)",
  memberByPair: "SELECT * FROM project_members WHERE project_id = ? AND user_id = ?",
  membersOfProject: "SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at, user_id",
  projectsOfMember: "SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? AND p.status = 'active' ORDER BY p.updated_at DESC, p.id",
  removeMember: "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
  insertProjectResource: "INSERT OR IGNORE INTO project_resources (project_id, resource_id, added_by, created_at) VALUES (?,?,?,?)",
  projectResourceByPair: "SELECT * FROM project_resources WHERE project_id = ? AND resource_id = ?",
  resourcesOfProject: "SELECT * FROM project_resources WHERE project_id = ? ORDER BY created_at, resource_id",
  projectsOfResource: "SELECT p.* FROM projects p JOIN project_resources r ON r.project_id = p.id WHERE r.resource_id = ? ORDER BY p.updated_at DESC, p.id",
  removeProjectResource: "DELETE FROM project_resources WHERE project_id = ? AND resource_id = ?",
  removeResourceEverywhere: "DELETE FROM project_resources WHERE resource_id = ?",

  insertBoard:
    "INSERT INTO canvas_boards (id, organization_id, owner_user_id, name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  boardById: "SELECT * FROM canvas_boards WHERE id = ?",
  boardsOfOrg: "SELECT * FROM canvas_boards WHERE organization_id = ? ORDER BY updated_at DESC, id",
  renameBoard: "UPDATE canvas_boards SET name = ?, updated_at = ? WHERE id = ?",
  deleteBoard: "DELETE FROM canvas_boards WHERE id = ?",
  insertNode:
    "INSERT INTO canvas_resource_nodes (id, board_id, resource_id, resource_version, version_mode, x, y, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  nodeById: "SELECT * FROM canvas_resource_nodes WHERE id = ?",
  nodesOfBoard: "SELECT * FROM canvas_resource_nodes WHERE board_id = ? ORDER BY created_at, id",
  updateNodeVersion: "UPDATE canvas_resource_nodes SET resource_version = ?, version_mode = ?, updated_at = ? WHERE id = ?",
  moveNode: "UPDATE canvas_resource_nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?",
  deleteNode: "DELETE FROM canvas_resource_nodes WHERE id = ?",
  nodesOfResource: "SELECT * FROM canvas_resource_nodes WHERE resource_id = ?",
};

class IntegrationStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("IntegrationStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }

  transact(fn) { return this.identity.transact(fn); }
  transactSync(fn) { return this.identity.transactSync(fn); }

  // --- projects ---

  insertProject({ organizationId, departmentId = null, ownerUserId, name, description = "", scope = "PERSONAL", status = "active", id = null } = {}) {
    const pid = id || "prj_" + crypto.randomBytes(10).toString("base64url");
    const now = this.clock();
    this.db.prepare(SQL.insertProject).run(pid, String(organizationId), departmentId, String(ownerUserId), String(name || ""), String(description || ""), String(status), String(scope), now, now);
    return this.projectById(pid);
  }
  projectById(id) { return this.db.prepare(SQL.projectById).get(String(id || "")) || null; }
  projectsOfOrg(organizationId) { return this.db.prepare(SQL.projectsOfOrg).all(String(organizationId || "")); }
  projectsOfDepartment(organizationId, departmentId) { return this.db.prepare(SQL.projectsOfDepartment).all(String(organizationId || ""), String(departmentId || "")); }
  projectsOwnedBy(userId) { return this.db.prepare(SQL.projectsOwnedBy).all(String(userId || "")); }
  updateProject(id, { name, description, status } = {}) {
    const current = this.projectById(id);
    if (!current) return null;
    this.db.prepare(SQL.updateProject).run(
      name == null ? current.name : String(name),
      description == null ? current.description : String(description),
      status == null ? current.status : String(status),
      this.clock(),
      String(id),
    );
    return this.projectById(id);
  }
  upsertMember(projectId, userId, role = "viewer") {
    this.db.prepare(SQL.insertMember).run(String(projectId), String(userId), String(role), this.clock());
    return this.memberByPair(projectId, userId);
  }
  memberByPair(projectId, userId) { return this.db.prepare(SQL.memberByPair).get(String(projectId || ""), String(userId || "")) || null; }
  membersOfProject(projectId) { return this.db.prepare(SQL.membersOfProject).all(String(projectId || "")); }
  projectsOfMember(userId) { return this.db.prepare(SQL.projectsOfMember).all(String(userId || "")); }
  removeMember(projectId, userId) { return { changed: this.db.prepare(SQL.removeMember).run(String(projectId || ""), String(userId || "")).changes > 0 }; }

  addProjectResource(projectId, resourceId, addedBy = null) {
    this.db.prepare(SQL.insertProjectResource).run(String(projectId), String(resourceId), addedBy, this.clock());
    return this.projectResourceByPair(projectId, resourceId);
  }
  projectResourceByPair(projectId, resourceId) { return this.db.prepare(SQL.projectResourceByPair).get(String(projectId || ""), String(resourceId || "")) || null; }
  resourcesOfProject(projectId) { return this.db.prepare(SQL.resourcesOfProject).all(String(projectId || "")); }
  projectsOfResource(resourceId) { return this.db.prepare(SQL.projectsOfResource).all(String(resourceId || "")); }
  removeProjectResource(projectId, resourceId) { return { changed: this.db.prepare(SQL.removeProjectResource).run(String(projectId || ""), String(resourceId || "")).changes > 0 }; }
  removeResourceEverywhere(resourceId) { return { changed: this.db.prepare(SQL.removeResourceEverywhere).run(String(resourceId || "")).changes > 0 }; }

  // --- canvas ---

  insertBoard({ organizationId, ownerUserId, name, id = null } = {}) {
    const bid = id || "cvs_" + crypto.randomBytes(10).toString("base64url");
    const now = this.clock();
    this.db.prepare(SQL.insertBoard).run(bid, String(organizationId), String(ownerUserId), String(name || ""), now, now);
    return this.boardById(bid);
  }
  boardById(id) { return this.db.prepare(SQL.boardById).get(String(id || "")) || null; }
  boardsOfOrg(organizationId) { return this.db.prepare(SQL.boardsOfOrg).all(String(organizationId || "")); }
  renameBoard(id, name) { this.db.prepare(SQL.renameBoard).run(String(name || ""), this.clock(), String(id)); return this.boardById(id); }
  deleteBoard(id) { return { changed: this.db.prepare(SQL.deleteBoard).run(String(id || "")).changes > 0 }; }

  insertNode({ boardId, resourceId, resourceVersion, versionMode = "PIN_VERSION", x = 0, y = 0, createdBy = null, id = null } = {}) {
    const nid = id || "cnd_" + crypto.randomBytes(10).toString("base64url");
    const now = this.clock();
    this.db.prepare(SQL.insertNode).run(nid, String(boardId), String(resourceId), Number(resourceVersion || 1), String(versionMode), Number(x) || 0, Number(y) || 0, createdBy, now, now);
    return this.nodeById(nid);
  }
  nodeById(id) { return this.db.prepare(SQL.nodeById).get(String(id || "")) || null; }
  nodesOfBoard(boardId) { return this.db.prepare(SQL.nodesOfBoard).all(String(boardId || "")); }
  updateNodeVersion(id, { resourceVersion, versionMode }) {
    this.db.prepare(SQL.updateNodeVersion).run(Number(resourceVersion || 1), String(versionMode || "PIN_VERSION"), this.clock(), String(id));
    return this.nodeById(id);
  }
  moveNode(id, { x, y }) { this.db.prepare(SQL.moveNode).run(Number(x) || 0, Number(y) || 0, this.clock(), String(id)); return this.nodeById(id); }
  deleteNode(id) { return { changed: this.db.prepare(SQL.deleteNode).run(String(id || "")).changes > 0 }; }
  nodesOfResource(resourceId) { return this.db.prepare(SQL.nodesOfResource).all(String(resourceId || "")); }
}

module.exports = { IntegrationStore, SQL };
