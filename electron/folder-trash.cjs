/**
 * 桌面虚拟文件夹的「系统回收站」规划逻辑（纯函数，无 DOM / React / Electron 依赖）。
 *
 * 背景：桌面上的组织用文件夹是 localStorage 里的虚拟对象（Folder = { id, name, x, y, parentId? }），
 * **不是**文件服务对象；但文件夹里的真实文件存在文件服务里，folderId 就是虚拟文件夹的 id。
 * 因此"删文件夹"= 记录整棵子树的元数据（本模块）+ 把每个子树文件夹里的文件走
 * files.trash(folderId, id, groupId) 打成同一组（file-service.cjs 存 groupId）。
 * 这样：回收站窗口能把整组隐藏成一个"文件夹"条目；恢复/永久删除按 groupId 整体处理。
 *
 * 纯函数放在这里是为了能被 node --test 直接覆盖（与 window-domain.cjs 同一惯例）。
 */
"use strict";

/** 收集以 rootId 为根的整棵虚拟文件夹子树（父先于子；含根）。 */
function collectSubtree(folders, rootId) {
  const list = Array.isArray(folders) ? folders : [];
  const out = [];
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const f = list.find((x) => x.id === id);
    if (!f) continue;
    out.push(f.parentId ? { id: f.id, name: f.name, x: f.x, y: f.y, parentId: f.parentId } : { id: f.id, name: f.name, x: f.x, y: f.y });
    for (const c of list) if (c.parentId === id && !seen.has(c.id)) queue.push(c.id);
  }
  return out;
}

/** 建一条可 JSON 持久化的回收站记录；根不存在时返回 null。 */
function buildFolderTrashRecord({ folders, rootId, groupId, deletedAt }) {
  const subtree = collectSubtree(folders, rootId);
  if (!subtree.length || !groupId) return null;
  return { groupId, rootId, name: subtree[0].name, deletedAt: typeof deletedAt === "number" ? deletedAt : Date.now(), folders: subtree };
}

/**
 * 恢复规划：把 record.folders 放回现有 folders。
 *
 * 边界（覆盖任务要求）：
 *  - **父级已被删**：parentId 既不在现有 folders、也不在本次恢复的子树里 → 归到桌面根（省略 parentId）。
 *  - **重名**：与同父级下已有文件夹同名 → 自动加 " 2" / " 3"（不覆盖、不丢）。
 *  - 父先于子返回，因此 added 直接并入 folders 即可（parentId 引用到时已存在）。
 */
function planFolderRestore(record, existingFolders) {
  const src = (record && Array.isArray(record.folders) ? record.folders : []).slice();
  const restoreIds = new Set(src.map((f) => f.id));
  const working = (Array.isArray(existingFolders) ? existingFolders : []).map((f) => ({ ...f }));
  const added = [];
  let reparented = 0;
  let renamed = 0;
  for (const f of src) {
    const parentOk = !!f.parentId && (restoreIds.has(f.parentId) || working.some((x) => x.id === f.parentId));
    if (f.parentId && !parentOk) reparented += 1;
    const parentId = parentOk ? f.parentId : undefined;
    const used = new Set(working.filter((x) => (x.parentId ?? null) === (parentId ?? null)).map((x) => x.name));
    let name = f.name;
    if (used.has(name)) {
      renamed += 1;
      for (let i = 2; ; i += 1) {
        const cand = f.name + " " + i;
        if (!used.has(cand)) {
          name = cand;
          break;
        }
      }
    }
    const folder = parentId ? { id: f.id, name, x: f.x, y: f.y, parentId } : { id: f.id, name, x: f.x, y: f.y };
    working.push(folder);
    added.push(folder);
  }
  return { added, reparented, renamed };
}

/**
 * 回收站窗口的三个分区（纯函数）。
 *  - 文件夹：来自 folderRecords，带 fileCount（组内文件数）。
 *  - 文件：文件服务回收站里**未被任何文件夹分组**的条目。groupId 指向的 folderRecord 已不存在时
 *    （孤儿组）仍当作文件显示 —— 否则会"看不见但没释放"。
 *  - 来自资源库：资源域返回的已授权 TRASHED 资源；空数组 → 不出现该分区（无权限不提示存在）。
 */
function buildTrashSections({ fileEntries, folderRecords, resourceItems } = {}) {
  const entries = Array.isArray(fileEntries) ? fileEntries : [];
  const records = Array.isArray(folderRecords) ? folderRecords : [];
  const grouped = new Set(records.map((r) => r.groupId));
  const files = entries.filter((e) => !e.groupId || !grouped.has(e.groupId));
  const folders = records.map((r) => ({ ...r, fileCount: entries.filter((e) => e.groupId === r.groupId).length }));
  const resources = Array.isArray(resourceItems) ? resourceItems : [];
  return { folders, files, resources, isEmpty: !folders.length && !files.length && !resources.length };
}

/** 某条文件夹记录内全部文件回收站条目的 id（恢复 / 永久删除用）。 */
function trashIdsOfGroup(fileEntries, groupId) {
  return (Array.isArray(fileEntries) ? fileEntries : []).filter((e) => e.groupId === groupId).map((e) => e.id);
}

const folderTrash = { collectSubtree, buildFolderTrashRecord, planFolderRestore, buildTrashSections, trashIdsOfGroup };
module.exports = folderTrash;
