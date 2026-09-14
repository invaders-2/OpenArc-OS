/** D4-02C 重启探针：把 Task 推进到 Harness turn running 后 process.exit（模拟进程崩溃，不 close DB）。*/
import { createTaskFixture } from "../../task-fixtures.mjs";

const dbPath = process.argv[2];
if (!dbPath) { console.error("dbPath required"); process.exit(2); }
const f = await createTaskFixture({ dbPath });
const ctx = f.ctx();
const t = f.taskService.createTask({ context: ctx, goal: "restart probe" });
const s1 = f.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
const c = f.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { x: 1 }, expectedRevision: s1.task.revision });
const s2 = f.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: c.step.stepId, expectedRevision: c.task.revision });
const r = f.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: c.step.stepId, expectedRevision: s2.task.revision });
f.taskService.markHarnessRunRunning({ context: ctx, taskId: t.task.taskId, runId: r.run.runId, expectedRevision: r.task.revision });
process.stdout.write(JSON.stringify({ taskId: t.task.taskId, stepId: c.step.stepId, runId: r.run.runId }) + "\n");
process.exit(0);
