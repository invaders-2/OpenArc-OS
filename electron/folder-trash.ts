export type FolderLike = { id: string; name: string; x: number; y: number; parentId?: string };
export type FolderTrashRecord = {
  groupId: string;
  rootId: string;
  name: string;
  deletedAt: number;
  folders: FolderLike[];
};
export type TrashFileEntry = {
  id: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  folderId?: string;
  deletedAt?: number;
  groupId?: string;
};

export function collectSubtree(folders: FolderLike[], rootId: string): FolderLike[] {
  const list = Array.isArray(folders) ? folders : [];
  const out: FolderLike[] = [];
  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const folder = list.find((item) => item.id === id);
    if (!folder) continue;
    out.push(folder.parentId ? { id: folder.id, name: folder.name, x: folder.x, y: folder.y, parentId: folder.parentId } : { id: folder.id, name: folder.name, x: folder.x, y: folder.y });
    for (const child of list) if (child.parentId === id && !seen.has(child.id)) queue.push(child.id);
  }
  return out;
}

export function buildFolderTrashRecord({ folders, rootId, groupId, deletedAt }: {
  folders: FolderLike[];
  rootId: string;
  groupId: string;
  deletedAt?: number;
}): FolderTrashRecord | null {
  const subtree = collectSubtree(folders, rootId);
  if (!subtree.length || !groupId) return null;
  return { groupId, rootId, name: subtree[0].name, deletedAt: typeof deletedAt === "number" ? deletedAt : Date.now(), folders: subtree };
}

/** 父级缺失时归到根；同父级重名时自动追加序号，不覆盖现有文件夹。 */
export function planFolderRestore(record: FolderTrashRecord, existingFolders: FolderLike[]): { added: FolderLike[]; reparented: number; renamed: number } {
  const source = (record && Array.isArray(record.folders) ? record.folders : []).slice();
  const restoreIds = new Set(source.map((folder) => folder.id));
  const working = (Array.isArray(existingFolders) ? existingFolders : []).map((folder) => ({ ...folder }));
  const added: FolderLike[] = [];
  let reparented = 0;
  let renamed = 0;
  for (const folder of source) {
    const parentOk = !!folder.parentId && (restoreIds.has(folder.parentId) || working.some((item) => item.id === folder.parentId));
    if (folder.parentId && !parentOk) reparented += 1;
    const parentId = parentOk ? folder.parentId : undefined;
    const used = new Set(working.filter((item) => (item.parentId ?? null) === (parentId ?? null)).map((item) => item.name));
    let name = folder.name;
    if (used.has(name)) {
      renamed += 1;
      for (let index = 2; ; index += 1) {
        const candidate = folder.name + " " + index;
        if (!used.has(candidate)) {
          name = candidate;
          break;
        }
      }
    }
    const restored = parentId ? { id: folder.id, name, x: folder.x, y: folder.y, parentId } : { id: folder.id, name, x: folder.x, y: folder.y };
    working.push(restored);
    added.push(restored);
  }
  return { added, reparented, renamed };
}

export function buildTrashSections({ fileEntries, folderRecords, resourceItems }: {
  fileEntries?: TrashFileEntry[];
  folderRecords?: FolderTrashRecord[];
  resourceItems?: unknown[];
} = {}): {
  folders: (FolderTrashRecord & { fileCount: number })[];
  files: TrashFileEntry[];
  resources: unknown[];
  isEmpty: boolean;
} {
  const entries = Array.isArray(fileEntries) ? fileEntries : [];
  const records = Array.isArray(folderRecords) ? folderRecords : [];
  const grouped = new Set(records.map((record) => record.groupId));
  const files = entries.filter((entry) => !entry.groupId || !grouped.has(entry.groupId));
  const folders = records.map((record) => ({ ...record, fileCount: entries.filter((entry) => entry.groupId === record.groupId).length }));
  const resources = Array.isArray(resourceItems) ? resourceItems : [];
  return { folders, files, resources, isEmpty: !folders.length && !files.length && !resources.length };
}

export function trashIdsOfGroup(fileEntries: TrashFileEntry[] | undefined, groupId: string): string[] {
  return (Array.isArray(fileEntries) ? fileEntries : []).filter((entry) => entry.groupId === groupId).map((entry) => entry.id);
}
