"use strict";
/**
 * task-25 B02 · 相册共享区判定（源 index.ts:6028-6036 / 6064-6071 的 shareZoneOf → canSeeShare）。
 * 纯函数 + 只读端口注入：public / department: 之外，补 canvas:<id> 与 asset-library:<id>。
 * 不新造 ACL：canvas 用 board owner / share / visibility；asset-library 用库 ACL（owner/public/org/member）。
 */
function createPhotosShareAccess({ canvasStore = null, assetLibraryStore = null } = {}) {
  function canSeeCanvas(user, canvasId) {
    if (!canvasStore || typeof canvasStore.boardById !== "function" || !user) return false;
    const board = canvasStore.boardById(canvasId);
    if (!board) return false;
    const userId = String(user.id != null ? user.id : "");
    if (board.owner_user_id != null && String(board.owner_user_id) === userId) return true;
    if (typeof canvasStore.boardsShared === "function") {
      const shared = canvasStore.boardsShared(userId);
      if (Array.isArray(shared) && shared.some((row) => String(row.id) === String(canvasId))) return true;
    }
    if (board.visibility === "ORGANIZATION" && board.organization_id != null && String(board.organization_id) === String(user.team_id || "")) return true;
    return false;
  }
  function canSeeAssetLibrary(user, libraryId) {
    if (!assetLibraryStore || typeof assetLibraryStore.libraryById !== "function" || !user) return false;
    const library = assetLibraryStore.libraryById(libraryId);
    if (!library || library.deleted_at) return false;
    const userId = String(user.id != null ? user.id : "");
    if (library.owner_user_id != null && String(library.owner_user_id) === userId) return true;
    if (library.visibility === "PUBLIC") return true;
    if (library.visibility === "ORGANIZATION" && library.organization_id != null && String(library.organization_id) === String(user.team_id || "")) return true;
    if (library.visibility === "RESTRICTED" && typeof assetLibraryStore.memberOfLibrary === "function") {
      const member = assetLibraryStore.memberOfLibrary(library.id, userId);
      if (member && (member.role === "read" || member.role === "edit")) return true;
    }
    return false;
  }
  return function shareAccess(user, share) {
    const value = String(share || "");
    if (value === "public") return true;
    if (value.startsWith("department:")) {
      if (!user) return false;
      return user.role === "superadmin" || user.role === "ADMIN" || String(user.departmentId || "") === value.slice("department:".length);
    }
    if (value.startsWith("canvas:")) return canSeeCanvas(user, value.slice("canvas:".length));
    if (value.startsWith("asset-library:")) return canSeeAssetLibrary(user, value.slice("asset-library:".length));
    return false;
  };
}

module.exports = { createPhotosShareAccess };
