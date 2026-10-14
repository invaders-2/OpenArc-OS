/**
 * B7d · 紫鸟下载作业测试（全离线：假 transport / 临时目录）。
 *
 * 覆盖任务书验收点：
 *   ① 作业创建 / 查询 / 列表；状态机 running → completed（店铺 success、文件与天数回填）；
 *   ② 取消（stop）→ job stopped、店铺 stopped，已完成结果保留；
 *   ③ 删除（仅终态可删）、非法 id / 非法操作结构化错误；
 *   ④ VC 汇总文件列举（VC汇总_ 前缀 + 日期区间解析）；
 *   ⑤ 未注入 transport → 结构化 INTEGRATION_UNAVAILABLE；
 *   ⑥ 作业落盘、重启（新实例）后仍可读；recover 处理 stopping 作业。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createZiniaoIntegration, CREDENTIAL_REF, STORE_FILE_NAME, CONTROL_FILE_NAME } = require("../electron/integration-ziniao.cjs");
const { safeStorageCredentialBackend } = require("../electron/credential-store.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-ziniao-")); tmpDirs.push(dir); return dir; }

const SUCCESS_ENTRY = [{ file: "/tmp/vc.xlsx", files: ["/tmp/vc.xlsx"], rowCount: 5, downloadedDays: 1, skippedExistingDays: 2 }];
function completedTransport() {
  return async (server, tool) => {
    if (tool === "start_client") return "{}";
    if (tool === "download_vc_summary") return JSON.stringify(SUCCESS_ENTRY);
    return "{}";
  };
}
const INPUT = { from: "2026-01-01", to: "2026-01-02", outDir: "/tmp/out", requestIntervalSeconds: 30, stores: [{ selector: "s1", name: "店铺一" }] };

test("紫鸟作业：创建 → 查询 → 完成；落盘与重启一致", async () => {
  const dir = tempDir();
  const integration = createZiniaoIntegration({ dataDir: dir, controlDir: dir, transport: completedTransport() });
  assert.equal(integration.getZiniaoDownloadJob(), null);

  const job = integration.startZiniaoDownloadJob(INPUT);
  assert.equal(job.status, "running");
  assert.equal(job.stores[0].status, "pending");
  assert.equal(job.requestIntervalSeconds, 30);
  assert.equal(integration.listZiniaoDownloadJobs().length, 1);
  assert.equal(integration.getZiniaoDownloadJob().id, job.id);

  await integration.whenIdle();
  const done = integration.getZiniaoDownloadJob();
  assert.equal(done.status, "completed");
  assert.equal(done.stores[0].status, "success");
  assert.equal(done.stores[0].file, "/tmp/vc.xlsx");
  assert.equal(done.stores[0].rowCount, 5);
  assert.equal(done.stores[0].skippedExistingDays, 2);
  assert.match(done.message, /任务完成：1 个成功/);
  assert.ok(fs.existsSync(path.join(dir, STORE_FILE_NAME)), "作业必须落盘");
  assert.ok(fs.existsSync(path.join(dir, CONTROL_FILE_NAME)), "控制文件必须落盘");

  const reopened = createZiniaoIntegration({ dataDir: dir, controlDir: dir });
  assert.equal(reopened.listZiniaoDownloadJobs().length, 1, "重启后仍可读");

  // 活动作业占用期间不得再启动
  const integration2 = createZiniaoIntegration({ dataDir: tempDir(), controlDir: dir, transport: completedTransport() });
  integration2.startZiniaoDownloadJob(INPUT);
  assert.throws(() => integration2.startZiniaoDownloadJob(INPUT), (error) => error.code === "INTEGRATION_INVALID_INPUT");
});

test("紫鸟作业：取消（stop）→ job stopped、店铺 stopped", async () => {
  const dir = tempDir();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let stopping = false;
  const integration = createZiniaoIntegration({
    dataDir: dir,
    controlDir: dir,
    transport: async (server, tool) => {
      if (tool === "start_client") return "{}";
      await gate;
      if (stopping) throw new Error("任务已停止");
      return JSON.stringify(SUCCESS_ENTRY);
    },
  });
  const job = integration.startZiniaoDownloadJob(INPUT);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const controlled = integration.controlZiniaoDownloadJob(job.id, "stop");
  assert.equal(controlled.status, "stopping");
  stopping = true;
  release();
  await integration.whenIdle();
  const done = integration.getZiniaoDownloadJob();
  assert.equal(done.status, "stopped");
  assert.equal(done.stores[0].status, "stopped");
  assert.match(done.message, /任务已停止/);
});

test("紫鸟作业：删除仅限终态；不存在/非法操作结构化报错", async () => {
  const dir = tempDir();
  const integration = createZiniaoIntegration({ dataDir: dir, controlDir: dir, transport: completedTransport() });
  const job = integration.startZiniaoDownloadJob(INPUT);
  assert.throws(() => integration.deleteZiniaoDownloadJobs([job.id]), (error) => error.code === "INTEGRATION_INVALID_INPUT", "运行中任务不可删");
  await integration.whenIdle();
  const removed = integration.deleteZiniaoDownloadJobs([job.id]);
  assert.equal(removed.deleted, 1);
  assert.equal(removed.jobs.length, 0);
  assert.throws(() => integration.controlZiniaoDownloadJob("missing-id", "pause"), (error) => error.code === "INTEGRATION_NOT_FOUND");
});

test("紫鸟作业：recover 处理 stopping 作业；未注入 transport 时启动结构化不可用", async () => {
  const dir = tempDir();
  const integration = createZiniaoIntegration({ dataDir: dir, controlDir: dir });
  assert.throws(() => integration.startZiniaoDownloadJob(INPUT), (error) => error.code === "INTEGRATION_UNAVAILABLE");

  const stored = [{ id: "job-1", status: "stopping", from: "2026-01-01", to: "2026-01-02", outDir: "/tmp/out", stores: [{ selector: "s1", name: "店铺一", status: "running" }], requestIntervalSeconds: 30, currentIndex: 0, message: "", error: "", createdAt: 1, updatedAt: 2 }];
  fs.writeFileSync(path.join(dir, STORE_FILE_NAME), JSON.stringify(stored), "utf8");
  const recovered = createZiniaoIntegration({ dataDir: dir, controlDir: dir });
  const job = recovered.recoverZiniaoDownloadJob();
  assert.equal(job.status, "stopped");
  assert.match(job.message, /任务已停止/);
});

test("紫鸟 VC 文件：列举 VC汇总_ 前缀 XLSX 并解析店铺 / 日期区间", () => {
  const dir = tempDir();
  const out = path.join(dir, "vc");
  fs.mkdirSync(path.join(out, "sub"), { recursive: true });
  fs.writeFileSync(path.join(out, "VC汇总_店铺A_20260101-20260102.xlsx"), "x");
  fs.writeFileSync(path.join(out, "sub", "VC汇总_店铺B_20260201-20260202.xlsx"), "y");
  fs.writeFileSync(path.join(out, "other.xlsx"), "z");
  const integration = createZiniaoIntegration({ dataDir: dir, outDir: out });
  const result = integration.listZiniaoVcFiles();
  assert.equal(result.root, out);
  assert.equal(result.files.length, 2, "非 VC汇总_ 前缀不计入");
  const file = result.files.find((item) => item.store === "店铺A");
  assert.equal(file.dateRange, "20260101-20260102");
  assert.ok(file.bytes > 0);
});

test("紫鸟凭据：写入 safeStorage，磁盘无明文，投影只给掩码", () => {
  const dir = tempDir();
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from("ENC:" + Buffer.from(String(value)).toString("base64")),
    decryptString: (blob) => Buffer.from(String(blob).slice(4), "base64").toString(),
  };
  const credentials = safeStorageCredentialBackend({ safeStorage: fakeSafeStorage, dir });
  const integration = createZiniaoIntegration({ dataDir: dir, credentials });
  const secret = "ZINIAO-SECRET-zzzz9999";
  const saved = integration.saveCredential({ secret });
  assert.equal(saved.ref, CREDENTIAL_REF);
  assert.equal(saved.mask, "ZINI••••9999");
  const file = path.join(dir, "credentials", CREDENTIAL_REF + ".bin");
  assert.equal(fs.readFileSync(file, "utf8").includes(secret), false, "磁盘上不得出现明文");
  assert.equal(JSON.stringify(integration.credentialStatus()).includes(secret), false);
});
