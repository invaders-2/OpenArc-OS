/**
 * 照片应用 · 三通道契约类型（photos / photocraft / appExchange）。
 *
 * 字段名逐字对齐已冻结的后端：
 *   · electron/photos-domain.cjs（PHOTOS_COMMANDS / 分页 / base64url 出口）
 *   · electron/photos-store.cjs:317-341（photos/sources/list 的 value 形状）
 *   · electron/photos-service.cjs:335/:538/:559/:640/:665/:689（library / thumbnail / file / removal / import / health）
 *   · electron/photocraft-domain.cjs:260-283（ProjectSummary）、:110（Group）
 *   · electron/app-exchange-domain.cjs:83-117（Target）、:240-246（消息形状）与 service:267（ExchangeResult）
 *
 * 本文件只放类型，不放逻辑；界面真正在用的规则在 photosLogic.ts / studioLogic.ts（可用 node:test 离线断言）。
 */

/* ══════════════════════════════════════════════════════════════════════════
   IPC 信封（三通道同形）
   入站 { command, payload? }；成功 { ok:true, value }；
   失败 { ok:false, error, message, detail? }（normalizeXxxError 的出口）
   ══════════════════════════════════════════════════════════════════════════ */
export type DomainFailure = {
  ok: false;
  error: string;
  message: string;
  detail?: unknown;
};
export type DomainSuccess<T> = { ok: true; value: T };
export type DomainResult<T> = DomainSuccess<T> | DomainFailure;

/** preload 暴露的域命令面（window.openarc.<domain>.command）。 */
export type DomainBridge = {
  command: (cmd: { command: string; payload?: Record<string, unknown> }) => Promise<unknown>;
};

export type DomainName = "photos" | "photocraft" | "appExchange";

/* ══════════════════════════════════════════════════════════════════════════
   photos 域
   ══════════════════════════════════════════════════════════════════════════ */
export type PhotoSource = {
  id: string;
  name: string;
  available: boolean;
};

/** 真实目录里的子目录（id = local-folder:<sourceId>:<relativePath>）。 */
export type PhotoLocalFolder = {
  id: string;
  name: string;
  parentId: string;
  sourceId: string;
  path: string;
};

/** 用户自建的虚拟文件夹（跨来源归类）。 */
export type PhotoVirtualFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

export type PhotoItem = {
  id: string;
  name: string;
  sourceId: string;
  relativePath: string;
  folderPath: string;
  mime: string;
  kind: "image" | "video";
  size: number;
  updated_ts: number;
  virtualFolderId: string | null;
};

export type PhotosSourcesListValue = {
  sources: PhotoSource[];
  sourcesTotal: number;
  sourcesTruncated: boolean;
  folders: PhotoLocalFolder[];
  foldersTotal: number;
  foldersTruncated: boolean;
  virtualFolders: PhotoVirtualFolder[];
  virtualFoldersTotal: number;
  virtualFoldersTruncated: boolean;
  items: PhotoItem[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  walkCapReached: boolean;
};

export type PhotosSourceAddValue = { source: PhotoSource; created: boolean };
export type PhotosSourceRemoveValue = { id: string; removed: true };
export type PhotosFolderCreateValue = { folder: PhotoVirtualFolder };
export type PhotosFolderRemoveValue = { id: string; removed: true; removedFolderIds: string[] };
export type PhotosFolderAssignValue = {
  folderId: string | null;
  folder?: PhotoVirtualFolder | null;
  assigned?: number;
  cleared?: number;
  skipped?: string[];
};

export type PhotosLibraryNode = {
  id: string;
  name: string;
  type: "file";
  parentId: string | null;
  mime: string | null;
  size: number;
  created_ts: number;
  updated_ts: number;
};

export type PhotosLibraryItem = {
  node: PhotosLibraryNode;
  folderId: string | null;
  folderName: string;
  path: string;
  kind: "image" | "video";
};

export type PhotosLibraryValue = {
  items: PhotosLibraryItem[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
};

export type PhotosSourceFileValue = {
  id: string;
  name: string;
  mime: string;
  size: number;
  encoding: "base64url";
  data: string;
};

export type PhotosSourceThumbnailValue = {
  id: string;
  mime: "image/jpeg";
  size: number;
  cached: boolean;
  encoding: "base64url";
  data: string;
};

export type PhotosImportDestination = "canvas" | "library";
export type PhotosImportImageValue = {
  destination: PhotosImportDestination;
  targetId: string;
  cardId?: string;
  itemId?: string;
  nodeId?: string;
};

export type PhotosReversePromptValue = { text: string; providerId: string; model: string };
export type PhotosVisionModel = { providerId: string; providerName: string; model: string };
export type PhotosVisionModelsValue = {
  available: boolean;
  models: PhotosVisionModel[];
  hint: string | null;
};

export type PhotosBackgroundRemovalValue = {
  mime: "image/png";
  bytes: number;
  encoding: "base64url";
  data: string;
};

export type PhotosHealthValue = {
  status: string;
  directory: string;
  sources: number;
  libraryNodes: number;
  pageLimitDefault: number;
  pageLimitMax: number;
  dependencies: Record<string, boolean>;
};

/* ══════════════════════════════════════════════════════════════════════════
   photocraft 域
   ══════════════════════════════════════════════════════════════════════════ */
export type PhotocraftVisibility = "private" | "public" | "restricted";

/** 源 photocraftProjects.ts:61-75 的 summary 投影（回收站多 deletedAt）。 */
export type PhotoCraftProject = {
  id: string;
  groupId: string;
  ownerId: string;
  ownerName: string;
  title: string;
  visibility: PhotocraftVisibility;
  members: string[];
  mine: boolean;
  access: "owner" | "read";
  sourceNodeId: string | null;
  sourceName: string;
  sourceMime: string;
  sourceSize: number;
  sourceSha256: string;
  previewSha256: string;
  previewUrl: string;
  sourceUrl?: string;
  statePath: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type PhotoCraftGroup = {
  id: string;
  name: string;
  mine: boolean;
  isDefault: boolean;
};

export type PhotocraftProjectsListValue = {
  projects: PhotoCraftProject[];
  groups: PhotoCraftGroup[];
};
export type PhotocraftTrashListValue = { projects: PhotoCraftProject[] };
export type PhotocraftProjectValue = { project: PhotoCraftProject };
export type PhotocraftProjectCreateValue = {
  project: PhotoCraftProject;
  source: { id?: string; name?: string } | null;
};
export type PhotocraftNodeValue = { node: { id: string; name?: string }; project: PhotoCraftProject };
export type PhotocraftGroupCreateValue = { group: PhotoCraftGroup };
export type PhotocraftGroupRemoveValue = {
  deleted: string;
  moved: number;
  fallbackGroupId: string;
};
export type PhotocraftReadSourceValue = {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  base64: string;
};

/* ══════════════════════════════════════════════════════════════════════════
   appExchange 域
   ══════════════════════════════════════════════════════════════════════════ */
export type ExchangeTarget = {
  appId: string;
  title: string;
  action: string;
  accepts: string[];
  creates: string;
  /** 本仓只读备注：映射来源（image-studio 由 dev-photocraft 映射而来）。 */
  sourceAppId: string;
  sourceTitle: string;
  mapping: string;
  mappingNote: string;
};

export type ExchangeCanvas = { id: string; title: string };

export type AppExchangeTargetsValue = {
  version: number;
  targets: ExchangeTarget[];
  canvases: ExchangeCanvas[];
};

export type ExchangeAsset = {
  nodeId: string;
  canvasId?: string;
  photoCraftProjectId?: string;
  revision?: string;
};

export type ExchangeRequestTarget = {
  appId: string;
  action: string;
  projectId?: string;
};

export type ExchangeRequest = {
  requestId: string;
  target: ExchangeRequestTarget;
  asset: ExchangeAsset;
};

export type ExchangeResult = {
  id: string;
  status: "completed";
  target: {
    appId: string;
    projectId?: string;
    cardId?: string;
    assetNodeId?: string;
  };
  source: ExchangeAsset & { revision?: string };
  asset: { name: string; mime: string; size: number; sha256: string };
  createdAt: number;
};

export type AppExchangeInspectValue = {
  asset: { nodeId: string; name: string; size: number; mime: string; revision: string };
};
