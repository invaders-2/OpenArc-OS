/**
 * B3a · 项目快照（移植自 DX OS 0.5.1 server/projectSnapshot.ts，57 行）。
 *
 * 源：<DX OS.app>/Contents/Resources/app.asar.unpacked/server/projectSnapshot.ts
 *   · :1  import { createNode, findByPath, getNode, setContent } from './fs.ts'
 *   · :2  import { getProject, listMemories, listTasks } from './taskStore.ts'
 *   · :9-:16  upsertFile（存在同路径 file 就按内容更新，否则建节点）
 *   · :18-:56 writeProjectSnapshot（写 project.json / memory.md / tasks.md）
 *
 * 适配点：
 *   · taskStore 的函数改从 ./agent-task-store.cjs 取（project 的 root_node_id 由该模块的
 *     dx_project_roots 桥接表提供）；
 *   · fs.ts 的 createNode / findByPath / getNode / setContent 属 B6，走 agent-task-store 的
 *     注入适配器（同一份 configureAgentTaskStore({ fsAdapter })）；未注入时抛结构化
 *     AGENT_DEPENDENCY_UNAVAILABLE，绝不假装成功。
 */
"use strict";

const agentTaskStore = require("./agent-task-store.cjs");

/** 取出快照需要的 fs 适配器；缺方法即判定不可用（fail-closed）。 */
function requireSnapshotFs() {
  const fs = agentTaskStore.getAgentFsAdapter();
  if (!fs || typeof fs.createNode !== "function" || typeof fs.findByPath !== "function" || typeof fs.getNode !== "function" || typeof fs.setContent !== "function") {
    const error = new Error("writeProjectSnapshot 依赖 fs.ts 虚拟文件树（B6），当前未注入 fsAdapter，不能假装成功");
    error.code = agentTaskStore.AGENT_DEPENDENCY_UNAVAILABLE;
    error.dependency = "fsAdapter";
    throw error;
  }
  return fs;
}

/** projectSnapshot.ts:9 */
function upsertFile(fs, dirId, name, content) {
  const existing = fs.findByPath(dirId, name);
  if (existing && existing.type === "file") {
    if (existing.content !== content) fs.setContent(existing.id, content);
    return existing.id;
  }
  return fs.createNode({ name: name, type: "file", parentId: dirId, content: content }).id;
}

/** projectSnapshot.ts:18 */
function writeProjectSnapshot(projectId) {
  const fs = requireSnapshotFs();
  const project = agentTaskStore.getProject(projectId);
  if (!project) return;
  const root = fs.getNode(project.root_node_id);
  if (!root || root.type !== "folder" || root.trashed) return;

  let dir = fs.findByPath(root.id, ".ccs-ai");
  if (!dir) dir = fs.createNode({ name: ".ccs-ai", type: "folder", parentId: root.id });
  else if (dir.type !== "folder") return;

  upsertFile(
    fs,
    dir.id,
    "project.json",
    JSON.stringify(
      {
        schema: 1,
        name: project.name,
        projectId: project.id,
        updatedAt: new Date().toISOString(),
        note: "此目录是 DX OS 项目的可迁移快照；实时任务状态以系统数据库为准。",
      },
      null,
      2,
    ),
  );

  const memories = agentTaskStore.listMemories(projectId);
  upsertFile(
    fs,
    dir.id,
    "memory.md",
    ["# 项目记忆", ""].concat(memories.length ? memories.map((m) => "- " + m.content + "（v" + m.version + " · " + m.source_type + "）") : ["（暂无记忆）"], "").join("\n"),
  );

  const owner = project.created_by || "";
  const tasks = owner ? agentTaskStore.listTasks(owner, projectId) : [];
  upsertFile(
    fs,
    dir.id,
    "tasks.md",
    ["# 任务历史", ""]
      .concat(
        tasks.length
          ? tasks.map((t) => {
              const deliverables = t.deliverables.map((d) => d.name).join("、");
              return (
                "## " + t.title + "\n- 状态：" + t.status + "\n- 目标：" + t.instruction.slice(0, 200) + "\n" +
                (t.result ? "- 结果：" + t.result.slice(0, 300) + "\n" : "") +
                (deliverables ? "- 交付物：" + deliverables + "\n" : "")
              );
            })
          : ["（暂无任务）"],
      )
      .concat([""])
      .join("\n"),
  );
}

module.exports = {
  writeProjectSnapshot,
};
