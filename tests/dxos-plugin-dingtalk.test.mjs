/**
 * B7c · 钉钉可选插件测试（全离线：假 fetch + 内存凭据后端；绝不真联网、不落明文）。
 *
 * 覆盖任务书验收点：
 *   ① 群机器人发送（text / markdown）与加签；
 *   ② 渠道 / 联系人列举；
 *   ③ 凭据走 credential-store：磁盘 dingtalk.json 不含 webhook / secret / clientSecret 明文；
 *   ④ 掩码投影：listChannels / getAgentConfig 只回掩码与"是否已设置"；
 *   ⑤ 未配置 → 结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   ⑥ 个人消息：未注入 personalSender 时结构化不可用，注入后才转发（不假实现）。
 *
 * 只读源：electron/integration-dingtalk.cjs（移植 server/dingtalk.ts:1-233）。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDingtalkIntegration, maskSecret } = require("../electron/integration-dingtalk.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
function setup({ fetchImpl = null, personalSender = null, clock = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-dingtalk-"));
  tmpDirs.push(root);
  const dataDir = path.join(root, "dxos");
  const credentials = memoryCredentialBackend();
  const integration = createDingtalkIntegration({ dataDir, credentials, fetch: fetchImpl, personalSender, clock: clock || (() => 1_700_000_000_000) });
  return { root, dataDir, credentials, integration, file: path.join(dataDir, "dingtalk.json") };
}

const WEBHOOK = "https://oapi.dingtalk.com/robot/send?access_token=SUPERSECRETTOKEN";
const SIGN_SECRET = "SECABCDEFGH12345";
const CLIENT_SECRET = "CLIENT-SECRET-VALUE-9876";

// ── ③④ 不落明文 + 掩码投影 ────────────────────────────────────────────────
test("凭据不落明文：dingtalk.json 不含 webhook / 加签密钥 / clientSecret；投影一律掩码", () => {
  const fx = setup();
  const saved = fx.integration.saveChannel({ name: "发布群", webhook: WEBHOOK, secret: SIGN_SECRET });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const agent = fx.integration.saveAgentConfig({ clientId: "suitcid", clientSecret: CLIENT_SECRET, robotCode: "robot-1" });
  assert.equal(agent.ok, true, JSON.stringify(agent));

  const raw = fs.readFileSync(fx.file, "utf8");
  for (const secret of [WEBHOOK, "SUPERSECRETTOKEN", SIGN_SECRET, CLIENT_SECRET, "access_token"]) {
    assert.equal(raw.includes(secret), false, "磁盘不得出现明文：" + secret);
  }
  // 只留引用，不留明文
  const parsed = JSON.parse(raw);
  assert.equal(parsed.channels.length, 1);
  assert.match(parsed.channels[0].webhookRef, /^dingtalk\.webhook\./);
  assert.match(parsed.channels[0].secretRef, /^dingtalk\.secret\./);
  assert.equal(parsed.channels[0].webhookHost, "oapi.dingtalk.com");
  assert.equal(parsed.agent.clientSecretRef, "dingtalk.agent.clientSecret");

  const channels = fx.integration.listChannels();
  assert.equal(channels.ok, true);
  assert.equal(channels.value.items[0].webhookSet, true);
  assert.equal(channels.value.items[0].webhookHost, "oapi.dingtalk.com");
  assert.equal(channels.value.items[0].secretSet, true);
  assert.equal(channels.value.items[0].webhookMask.includes("SUPERSECRETTOKEN"), false);
  assert.match(channels.value.items[0].webhookMask, /••••/);
  assert.equal(channels.value.items[0].secretMask.includes(SIGN_SECRET), false);

  const config = fx.integration.getAgentConfig().value;
  assert.equal(config.clientSecretSet, true);
  assert.equal(config.clientSecretMask.includes(CLIENT_SECRET), false);
  assert.match(config.clientSecretMask, /••••/);
  assert.equal(config.clientId, "suitcid");
});

test("掩码规则：空串 → 空；≤8 位全掩；>8 位头尾各留 4 位（dingtalk.ts:130-133）", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("abc"), "•••");
  assert.equal(maskSecret("12345678"), "••••••••");
  assert.equal(maskSecret("123456789"), "1234••••6789");
});

// ── ① 发送 + 加签 ─────────────────────────────────────────────────────────
test("群机器人发送：text / markdown 两种消息体 + 加签参数（假 fetch，离线）", async () => {
  const calls = [];
  const fx = setup({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: "ok" }) }; } });
  const saved = fx.integration.saveChannel({ name: "发布群", webhook: WEBHOOK, secret: SIGN_SECRET });
  assert.equal(saved.ok, true);

  const text = await fx.integration.send({ msg: { text: "构建完成" } });
  assert.equal(text.ok, true, JSON.stringify(text));
  assert.equal(text.value.channel, "发布群");
  assert.equal(calls.length, 1);
  const expectedSign = createHmac("sha256", SIGN_SECRET).update("1700000000000\n" + SIGN_SECRET).digest("base64");
  assert.match(calls[0].url, /timestamp=1700000000000/);
  assert.equal(calls[0].url.includes("sign=" + encodeURIComponent(expectedSign)), true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { msgtype: "text", text: { content: "构建完成" } });

  const markdown = await fx.integration.send({ msg: { title: "日报", markdown: "## 今日" } });
  assert.equal(markdown.ok, true);
  assert.deepEqual(JSON.parse(calls[1].init.body), { msgtype: "markdown", markdown: { title: "日报", text: "## 今日" } });
});

test("群机器人发送：钉钉 errcode 非 0 → INTEGRATION_SEND_FAILED（不是不可用）", async () => {
  const fx = setup({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errcode: 310000, errmsg: "keywords not in content" }) }) });
  fx.integration.saveChannel({ name: "发布群", webhook: WEBHOOK, secret: "" });
  const res = await fx.integration.send({ msg: { text: "hi" } });
  assert.equal(res.ok, false);
  assert.equal(res.error, "INTEGRATION_SEND_FAILED");
  assert.match(res.detail, /310000/);
});

// ── ⑤ 未配置 / 缺依赖 → 结构化不可用 ───────────────────────────────────────
test("未配置：没有机器人 / 未注入 fetch → INTEGRATION_UNAVAILABLE，不假发送", async () => {
  const noFetch = setup();
  assert.equal((await noFetch.integration.send({ msg: { text: "hi" } })).error, "INTEGRATION_UNAVAILABLE");

  const fx = setup({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errcode: 0 }) }) });
  const res = await fx.integration.send({ msg: { text: "hi" } });
  assert.equal(res.ok, false);
  assert.equal(res.error, "INTEGRATION_UNAVAILABLE");
  assert.match(res.detail, /没有可用的钉钉机器人/);
});

test("safeStorage 不可用：写入凭据被拒，绝不退回明文", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-dingtalk-nostore-"));
  tmpDirs.push(root);
  const integration = createDingtalkIntegration({ dataDir: path.join(root, "dxos"), credentials: null, clock: () => 1 });
  const res = integration.saveChannel({ name: "x", webhook: WEBHOOK });
  assert.equal(res.ok, false);
  assert.equal(res.error, "INTEGRATION_UNAVAILABLE");
  assert.match(res.detail, /safeStorage/);
  assert.equal(fs.existsSync(path.join(root, "dxos", "dingtalk.json")), false, "拒绝后不写文件");
  const channels = integration.listChannels();
  assert.equal(channels.value.items.length, 0);
});

// ── ② 渠道 / 联系人列举 ────────────────────────────────────────────────────
test("渠道：secret 留空保留原值（dingtalk.ts:147-170）；删除即清引用；联系人按最近触达排序", () => {
  const fx = setup();
  const created = fx.integration.saveChannel({ name: "发布群", webhook: WEBHOOK, secret: SIGN_SECRET });
  assert.equal(created.ok, true);
  const id = created.value.id;
  const renamed = fx.integration.saveChannel({ id, name: "发布群 2", webhook: "", secret: "" });
  assert.equal(renamed.ok, true);
  const listed = fx.integration.listChannels().value.items;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "发布群 2");
  assert.equal(listed[0].secretSet, true, "留空必须保留原 secret");
  assert.equal(listed[0].webhookSet, true, "留空必须保留原 webhook");

  fx.integration.recordContact("user-b", "小李");
  fx.integration.recordContact("user-a", "小王");
  const contacts = fx.integration.listContacts().value.items;
  assert.deepEqual(contacts.map((item) => item.userId), ["user-a", "user-b"]);
  assert.equal(fx.integration.recordContact("", "x").error, "INTEGRATION_INVALID_INPUT");

  const removed = fx.integration.deleteChannel(id);
  assert.equal(removed.value.changed, true);
  assert.equal(fx.integration.listChannels().value.items.length, 0);
  assert.equal(fs.readFileSync(fx.file, "utf8").includes("SUPERSECRETTOKEN"), false);
});

// ── ⑥ 个人消息：不假实现 ───────────────────────────────────────────────────
test("个人消息：未注入 personalSender → INTEGRATION_UNAVAILABLE；注入后才转发", async () => {
  const fx = setup();
  const blocked = await fx.integration.sendToUser({ userId: "u1", text: "hi" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "INTEGRATION_UNAVAILABLE");
  assert.match(blocked.detail, /personalSender|个人消息/);

  const seen = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-dingtalk-person-"));
  tmpDirs.push(root);
  const withSender = createDingtalkIntegration({
    dataDir: path.join(root, "dxos"),
    credentials: memoryCredentialBackend(),
    personalSender: async (args) => { seen.push(args); return { ok: true }; },
    clock: () => 1,
  });
  withSender.saveAgentConfig({ clientId: "cid", clientSecret: CLIENT_SECRET, robotCode: "r" });
  const sent = await withSender.sendToUser({ userId: "u1", text: "hi" });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, "u1");
  assert.equal(seen[0].text, "hi");
  // 传给发送器的 config 不含 clientSecret 明文之外的内容仍由发送器内部使用；此处只断言 userId/text。
});
