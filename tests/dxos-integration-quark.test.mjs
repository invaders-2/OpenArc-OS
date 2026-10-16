/**
 * B7d · 夸克网盘测试（全离线：假 spawn / 真实派生假 CLI 文件 / 临时目录）。
 *
 * 覆盖任务书验收点：
 *   ① 假 CLI（注入 spawnImpl）解析 NDJSON：登录态 / 搜索 / 浏览 / 下载 / 上传 / 退出；
 *   ② 真实 spawn 路径：派生一个临时假 CLI 文件（node 执行），证明 runQuark 的解析链路可用；
 *   ③ 凭据投影只回掩码，绝不回传 token；本模块不写任何明文凭据；
 *   ④ 未配置 CLI 且未注入 spawn → 结构化 INTEGRATION_UNAVAILABLE；
 *   ⑤ 搜索历史按用户隔离、去重、上限 12；登录进程启动 / 停止。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createQuarkIntegration, CREDENTIAL_REF } = require("../electron/integration-quark.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-quark-")); tmpDirs.push(dir); return dir; }

function makeFakeSpawn() {
  return (args) => {
    const command = args[0];
    const empty = { rows: [{ type: "result", code: 0, data: {} }], exitCode: 0, stdout: "", stderr: "" };
    if (command === "get-user-info") return { rows: [{ type: "result", code: 0, data: { userInfo: { nickname: "样例用户", userId: "u1" } } }], exitCode: 0, stdout: "", stderr: "" };
    if (command === "search") return { rows: [{ type: "result", code: 0, data: { total: 2, check_all_link: "https://pan.quark.cn/s/xxx", file_list: [{ fid: "f1", filename: "报表.xlsx", size: 1024 }] } }, { type: "list", data: { fid: "d1", filename: "目录", dir: true } }], exitCode: 0, stdout: "", stderr: "" };
    if (command === "browse") return { rows: [{ type: "list", data: { fid: "b1", filename: "b.txt", size: 8 } }], exitCode: 0, stdout: "", stderr: "" };
    if (command === "download") {
      const outDir = args[args.indexOf("--output-dir") + 1];
      fs.writeFileSync(path.join(outDir, "out.bin"), "x");
      return empty;
    }
    if (command === "upload") return { rows: [{ type: "result", code: 0, data: { fids: ["u1"], fileNames: ["a.txt"], successCount: 1, fileCount: 1 } }], exitCode: 0, stdout: "", stderr: "" };
    return empty;
  };
}

test("夸克：假 CLI 驱动登录态 / 搜索 / 浏览 / 下载 / 上传", async () => {
  const dir = tempDir();
  const integration = createQuarkIntegration({ dataDir: dir, spawnImpl: makeFakeSpawn() });
  assert.equal(integration.cliAvailable(), true, "注入 spawnImpl 即视为 CLI 可用");

  const account = await integration.quarkStatus();
  assert.equal(account.loggedIn, true);
  assert.equal(account.user.nickname, "样例用户");

  const search = await integration.quarkSearch("报表", 0);
  assert.equal(search.total, 2);
  assert.equal(search.files.length, 2);
  assert.equal(search.files[0].fid, "f1");
  assert.equal(search.files[0].filename, "报表.xlsx");
  assert.equal(search.files[0].isDir, false);
  assert.equal(search.files[1].isDir, true);
  assert.equal(search.checkAllLink, "https://pan.quark.cn/s/xxx");

  const browse = await integration.quarkBrowse("0");
  assert.equal(browse.mode, "browse");
  assert.equal(browse.files[0].filename, "b.txt");

  const outDir = path.join(dir, "dl");
  const downloaded = await integration.quarkDownload("f1", outDir);
  assert.equal(path.basename(downloaded), "out.bin");

  const upload = await integration.quarkUpload("parent-1", "/tmp/a.txt");
  assert.equal(upload.successCount, 1);
  assert.deepEqual(upload.fids, ["u1"]);

  await integration.quarkLogout();
});

test("夸克：NDJSON 错误行（code != 0）抛出可读错误", () => {
  const integration = createQuarkIntegration({ dataDir: tempDir(), spawnImpl: makeFakeSpawn() });
  assert.throws(() => integration.throwIfError([{ type: "result", code: 401, msg: "登录已失效" }], 0, ""), /登录已失效（错误码 401）/);
  assert.throws(() => integration.throwIfError([], 2, "boom"), /boom/);
});

test("夸克：真实 spawn 派生临时假 CLI，解析 get-user-info", async () => {
  const dir = tempDir();
  const cli = path.join(dir, "fake-quark.cjs");
  fs.writeFileSync(cli, "const cmd=process.argv[2];\n" +
    "const out=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');\n" +
    "if(cmd==='get-user-info') out({type:'result',code:0,data:{userInfo:{nickname:'真实派生',userId:'u9'}}});\n" +
    "else out({type:'result',code:0,data:{}});\n", "utf8");
  const integration = createQuarkIntegration({ dataDir: dir, cliPath: cli });
  assert.equal(integration.cliAvailable(), true);
  const account = await integration.quarkStatus();
  assert.equal(account.loggedIn, true);
  assert.equal(account.user.nickname, "真实派生");
});

test("夸克：未配置 CLI 且未注入 spawn → 结构化 INTEGRATION_UNAVAILABLE", async () => {
  const integration = createQuarkIntegration({ dataDir: tempDir() });
  assert.equal(integration.status().cliExists, false);
  await assert.rejects(() => integration.quarkSearch("报表"), (error) => error.code === "INTEGRATION_UNAVAILABLE");
  await assert.rejects(() => integration.quarkStatus(), (error) => error.code === "INTEGRATION_UNAVAILABLE");
});

test("夸克：凭据投影只回掩码；本模块不写任何明文凭据", () => {
  const dir = tempDir();
  const integration = createQuarkIntegration({ dataDir: dir, spawnImpl: makeFakeSpawn() });
  const token = "tok_ABCDEFGHIJKLMNOP";
  const configDir = path.join(dir, "quark", "cli-home", "claudecode");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ currentUserId: "u1", access_token: token }), "utf8");

  const status = integration.quarkCredentialStatus();
  assert.equal(status.ref, CREDENTIAL_REF);
  assert.equal(status.configPresent, true);
  assert.equal(status.currentUserId, "u1");
  assert.equal(status.tokenSet, true);
  assert.equal(status.tokenMask, "tok_••••MNOP");
  assert.equal(JSON.stringify(status).includes(token), false, "投影绝不回传 token");
  // 本模块不持有安全存储后端，也不会新建任何凭据文件
  assert.equal(fs.existsSync(path.join(dir, "credentials")), false);
});

test("夸克：搜索历史按用户隔离、去重、上限 12；登录进程可重复启动 / 停止", () => {
  const dir = tempDir();
  const integration = createQuarkIntegration({ dataDir: dir, spawnImpl: makeFakeSpawn() });
  for (let index = 0; index < 15; index += 1) integration.quarkRecordSearch("u1", "关键词" + index);
  integration.quarkRecordSearch("u1", "关键词14");
  const entries = integration.quarkSearchHistory("u1");
  assert.equal(entries.length, 12, "上限 12");
  assert.equal(entries[0], "关键词14", "最近搜索置顶且去重");
  assert.deepEqual(integration.quarkSearchHistory("u2"), [], "按用户隔离");
  integration.quarkClearSearchHistory("u1");
  assert.deepEqual(integration.quarkSearchHistory("u1"), []);

  const loginIntegration = createQuarkIntegration({ dataDir: dir, spawnImpl: makeFakeSpawn(), spawnLoginImpl: () => ({ pid: 4242, exitCode: null, kill() { this.exitCode = 0; } }) });
  assert.deepEqual(loginIntegration.quarkStartLogin(), { started: true });
  assert.deepEqual(loginIntegration.quarkStartLogin(), { started: true, alreadyRunning: true });
  loginIntegration.quarkStopLogin();
});
