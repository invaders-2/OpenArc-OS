"use strict";
/**
 * B6b · fsAdapter —— 把 dxos-fs.cjs 的 DX 虚拟文件树包装成 B3 / B4 / B5 一直在等的注入面。
 *
 * ==== 形状来源（逐项对齐调用方真实用法，未发明字段）====
 *   · electron/agent-runtime-workspace.cjs:17-33 契约头 + 实际调用点：
 *       :71  readBlob(id)
 *       :84  listChildren(parentId).nodes
 *       :115/143/257/260 getNode(id)
 *       :155 ensureSystemRoot()
 *       :156-158 ensureFolder(name, parentId, ownerId?) -> parentId 直接用
 *       :159/323 copyNode(nodeId, targetParentId)
 *       :238/271/320/404/406/457/459 findByPath(rootId, path)
 *       :359 getFsCommitState()
 *       :363/420 prepareFsArtifactBatchPlan(rootId, writes, record?)
 *       :365/424/428 serializeFsArtifactBatchPlan(plan) / publishFsArtifactBatchPlan(plan, commitId, onPublished)
 *       :388/414/416 stageContentAddressedBlob(data, sha256)
 *       :388 collectOrphanContentBlobs({ minAgeMs, dryRun, protectedHashes })
 *   · electron/agent-builtin-tools.cjs:125-334：isWithinRoot / findByPath / resolvePath /
 *       getNode / listChildren / createNode / setContent / renameNode / moveNode / copyNode / removeNode
 *   · electron/agent-project-snapshot.cjs:24-51：createNode / findByPath / getNode / setContent
 *   · electron/skill-runner.cjs:534-687、:907-908：resolvePath / ensureFolder / createNode /
 *       saveBlob / getNode / readBlob / findByPath
 *   · electron/agent-task-store.cjs:31、:1553：getNode / isWithinRoot / findByPath / createNode / setContent
 *   · electron/canvas-dxos-agent-attachments.cjs 全文未引用 fsAdapter（它经既有 canvas/resource 域落地），
 *     本适配器不为它新增任何字段。
 *
 * ==== 两个必须说清的返回值语义 ====
 *   · ensureFolder 返回 **文件夹 id（string）**，不是 FsNode。源 fs.ts:685-691 就是 return found.id /
 *     createNode(...).id；agent-runtime-workspace.cjs:156-158 正是把返回值直接当 parentId 用
 *     （契约头注释 :23 写作 FsNode 与调用方实际用法不符，以源与调用点为准）；
 *   · listChildren 返回 { nodes, path }，调用方只取 .nodes（源 fs.ts:485-500）。
 *
 * ==== 依赖注入 ====
 *   createDxosFsAdapter({ dataDir, userDataDir, clock, idFactory })
 *     dataDir / userDataDir 交给 createDxosFs 解析（默认 <userData>/dxos/fs，
 *     见 dxos-foundation-paths.cjs 的 directory.fs）。
 *   适配器只暴露上面五个调用方真正用到的字段；完整源函数面保留在适配器的 .store 上，
 *   供回收站 / 快照 / 存储统计等非契约调用点使用（不属于五个调用方的契约面）。
 */
const { createDxosFs } = require("./dxos-fs.cjs");

function createDxosFsAdapter(options) {
  const store = createDxosFs(options || {});

  const adapter = {
    // 只读（agent-runtime-workspace / agent-builtin-tools / agent-project-snapshot / skill-runner）
    getNode: store.getNode,
    listChildren: store.listChildren,
    findByPath: store.findByPath,
    isWithinRoot: store.isWithinRoot,
    readBlob: store.readBlob,
    getFsRevision: store.getFsRevision,
    getFsCommitState: store.getFsCommitState,
    // 树写（agent-runtime-workspace / agent-builtin-tools / agent-project-snapshot）
    ensureSystemRoot: store.ensureSystemRoot,
    ensureFolder: store.ensureFolder,
    createNode: store.createNode,
    resolvePath: store.resolvePath,
    copyNode: store.copyNode,
    renameNode: store.renameNode,
    moveNode: store.moveNode,
    removeNode: store.removeNode,
    setContent: store.setContent,
    // Blob（skill-runner / agent-runtime-workspace）
    saveBlob: store.saveBlob,
    stageContentAddressedBlob: store.stageContentAddressedBlob,
    hasBlob: store.hasBlob,
    // Journal 批量提交（agent-runtime-workspace）
    prepareFsArtifactBatchPlan: store.prepareFsArtifactBatchPlan,
    serializeFsArtifactBatchPlan: store.serializeFsArtifactBatchPlan,
    publishFsArtifactBatchPlan: store.publishFsArtifactBatchPlan,
    collectOrphanContentBlobs: store.collectOrphanContentBlobs,
  };

  // 非契约面：完整 dxos-fs 源函数（回收站 / 快照 / 存储统计 / 共享盘）+ 数据目录。
  adapter.store = store;
  adapter.dataDir = store.dataDir;
  return adapter;
}

module.exports = { createDxosFsAdapter };
