/** 桌面虚拟文件夹回收站规划逻辑的类型声明（渲染进程用；运行时由 folder-trash.cjs 提供）。 */

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

declare const folderTrash: {
  collectSubtree: (folders: FolderLike[], rootId: string) => FolderLike[];
  buildFolderTrashRecord: (input: {
    folders: FolderLike[];
    rootId: string;
    groupId: string;
    deletedAt?: number;
  }) => FolderTrashRecord | null;
  planFolderRestore: (
    record: FolderTrashRecord,
    existingFolders: FolderLike[],
  ) => { added: FolderLike[]; reparented: number; renamed: number };
  buildTrashSections: (input: {
    fileEntries?: TrashFileEntry[];
    folderRecords?: FolderTrashRecord[];
    resourceItems?: unknown[];
  }) => {
    folders: (FolderTrashRecord & { fileCount: number })[];
    files: TrashFileEntry[];
    resources: unknown[];
    isEmpty: boolean;
  };
  trashIdsOfGroup: (fileEntries: TrashFileEntry[] | undefined, groupId: string) => string[];
};
export default folderTrash;
