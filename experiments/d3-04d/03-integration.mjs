/** D3-04D 探针 03 · Files / Projects / Canvas 集成。 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Probe, createResourceFixture } from "./lib.mjs";
const p = new Probe("03-integration", "Files / Projects / Canvas ResourceRef 集成");
const f = await createResourceFixture();
const admin = f.adminCtx();
try {
  const r = await f.resourceService.createResource({ context: admin, resourceType: "text", name: "Integ", content: "integ token" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3d-probe-"));
  const target = path.join(dir, "out.txt");
  const exported = await f.resourceService.exportToFile({ context: admin, resourceRef: r.resource.resourceId, targetPath: target });
  p.assert("Resource → File Export 真实落盘", exported.ok && fs.readFileSync(target, "utf8") === "integ token", "");
  fs.rmSync(dir, { recursive: true, force: true });

  const proj = f.projectService.createProject({ context: admin, name: "ProbeP" });
  f.projectService.addResource({ context: admin, projectId: proj.project.id, resourceRef: r.resource.resourceId });
  const pr = f.projectService.listProjectResources({ context: admin, projectId: proj.project.id });
  p.assert("Project 引用 ResourceRef 且逐资源授权", pr.ok && pr.items[0].authorized === true, "");

  const board = f.canvasService.createBoard({ context: admin, name: "ProbeB" });
  const node = f.canvasService.addResourceNode({ context: admin, boardId: board.board.id, resourceRef: r.resource.resourceId });
  p.assert("Canvas 节点保存 ResourceRef（非路径）", node.ok && node.node.resource_id === r.resource.resourceId && !JSON.stringify(node).includes("/"), "");
  await f.resourceService.replaceText({ context: admin, resourceRef: r.resource.resourceId, text: "v2", expectedVersion: 1 });
  p.assert("PIN_VERSION 不静默跟随：报告 VERSION_AVAILABLE", f.canvasService.getBoard({ context: admin, boardId: board.board.id }).nodes[0].state === "VERSION_AVAILABLE", "");
  f.canvasService.updateNodeToLatest({ context: admin, nodeId: node.node.id });
  p.assert("显式 Update to latest 后 AVAILABLE", f.canvasService.getBoard({ context: admin, boardId: board.board.id }).nodes[0].state === "AVAILABLE", "");
} finally { f.close(); }
p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
