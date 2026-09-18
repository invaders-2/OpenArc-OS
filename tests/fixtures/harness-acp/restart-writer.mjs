/** D4-02C 重启探针：把 Task 推进到 Harness turn running 后 process.exit（模拟进程崩溃，不 close DB）。*/
import { createTaskFixture } from "../../task-fixtures.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TaskService } = require("../../../electron/task-service.cjs");

const dbPath = process.argv[2];
if (!dbPath) { console.error("dbPath required"); process.exit(2); }
const f = await createTaskFixture({ dbPath });
const ctx = f.ctx();
// R-8：本探针只需要一条未绑定的 RUNNING task/step/run 供重启恢复断言，不启动任何模型调用 ——
// 未绑定 run 只能由契约允许的 test-only 桩装配（无 modelService）建出，不直写 DB。
const svc = new TaskService({ identity: f.identity, authService: f.authService, authStore: f.store, taskStore: f.taskStore, clock: f.clock });
const t = svc.createTask({ context: ctx, goal: "restart probe" });
const s1 = svc.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
const c = svc.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { x: 1 }, expectedRevision: s1.task.revision });
const s2 = svc.startStep({ context: ctx, taskId: t.task.taskId, stepId: c.step.stepId, expectedRevision: c.task.revision });
const r = svc.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: c.step.stepId, expectedRevision: s2.task.revision });
svc.markHarnessRunRunning({ context: ctx, taskId: t.task.taskId, runId: r.run.runId, expectedRevision: r.task.revision });
process.stdout.write(JSON.stringify({ taskId: t.task.taskId, stepId: c.step.stepId, runId: r.run.runId }) + "\n");
process.exit(0);
