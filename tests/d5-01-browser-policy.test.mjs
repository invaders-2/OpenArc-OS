/**
 * D5-01 · 浏览器策略契约：下载记录 / 文件名与路径安全 / 会话分区（A04）。
 *
 * 打的是产品真实模块（browser-downloads.cjs / native-view-controller.cjs），
 * 不是等价实现。真实 Electron 下载链路由 experiments/d5-01 的真实 electron . 探针证明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { BrowserDownloads, safeFilename, uniquePath, safeSourceURL } = require("../electron/browser-downloads.cjs");
const { NativeViewController } = require("../electron/native-view-controller.cjs");

/** 最小 DownloadItem 桩：只实现 attach() 真正调用的表面。 */
class FakeItem {
  constructor({ filename = "file.bin", url = "https://dl.example/file.bin", total = 100 } = {}) {
    this.filename = filename; this.url = url; this.total = total; this.received = 0;
    this.handlers = new Map(); this.savePath = null; this.cancelled = false;
  }
  getFilename() { return this.filename; }
  getURL() { return this.url; }
  getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; }
  setSavePath(p) { this.savePath = p; }
  on(evt, fn) { if (!this.handlers.has(evt)) this.handlers.set(evt, []); this.handlers.get(evt).push(fn); }
  once(evt, fn) { this.on(evt, fn); }
  cancel() { this.cancelled = true; }
  emit(evt, state) { for (const fn of this.handlers.get(evt) || []) fn({}, state); }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-dl-"));

test("safeFilename：去掉路径分隔符与控制字符，不产生空名", () => {
  // 分隔符被替换、开头的点被剥掉 —— 结果里既没有路径分隔符也不是隐藏文件
  assert.equal(safeFilename("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(safeFilename("../../etc/passwd").includes("/"), false);
  assert.equal(safeFilename("a\u0000b\u001fc.txt"), "abc.txt");
  assert.equal(safeFilename(""), "download");
  assert.equal(safeFilename("   "), "download");
  assert.equal(safeFilename("x".repeat(400)).length, 120);
});

test("uniquePath：同名不覆盖；safeSourceURL：去凭据", () => {
  const dir = tmp();
  try {
    const first = uniquePath(dir, "a.txt");
    fs.writeFileSync(first, "one");
    const second = uniquePath(dir, "a.txt");
    assert.notEqual(second, first);
    assert.equal(path.basename(second), "a (1).txt");
    assert.equal(safeSourceURL("https://user:pass@dl.example/x?q=1"), "https://dl.example/x?q=1");
    assert.equal(safeSourceURL("not a url"), "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("attach/list：记录按会话键隔离，落盘路径真实存在且可写", () => {
  const dir = tmp();
  try {
    const events = [];
    const d = new BrowserDownloads({ dir, onEvent: (e) => events.push(e) });
    const item = new FakeItem({ filename: "report.txt", total: 11 });
    const id = d.attach(item, { sessionKey: "usr_a", appId: "browser" });
    assert.ok(item.savePath.startsWith(path.join(dir, "usr_a")), "落盘路径必须带用户子目录：" + item.savePath);
    assert.equal(path.basename(item.savePath), "report.txt");
    assert.equal(events[0].type, "download-state");
    assert.equal(events[0].state, "progressing");

    item.received = 11;
    item.emit("done", "completed");
    const [record] = d.list("usr_a");
    assert.equal(record.downloadId, id);
    assert.equal(record.state, "completed");
    assert.equal(record.received, 11);
    assert.equal(record.total, 11);
    assert.equal(record.source, "https://dl.example/file.bin");

    // 文件真实落盘：写入后读回
    fs.writeFileSync(record.savePath, "hello-openarc");
    assert.equal(fs.readFileSync(record.savePath, "utf8"), "hello-openarc");

    // A04：另一个用户看不到任何记录
    assert.deepEqual(d.list("usr_b"), []);
    assert.deepEqual(d.list(null), [], "匿名会话也不得看到已登录用户的下载");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("act：跨会话键拒绝、未完成不可打开、完成状态可移除；clear 只清已完成", () => {
  const dir = tmp();
  try {
    const d = new BrowserDownloads({ dir, onEvent: () => {} });
    const running = new FakeItem({ filename: "big.iso", total: 1000 });
    const runningId = d.attach(running, { sessionKey: "usr_a" });
    running.received = 10;
    running.emit("updated", "progressing");
    assert.equal(d.get(runningId).state, "progressing");
    assert.ok(d.act("open", runningId, "usr_a").error, "未完成的下载不能打开");
    assert.ok(d.act("cancel", runningId, "usr_b").error, "跨用户不得取消他人的下载");
    assert.equal(running.cancelled, false);
    assert.equal(d.act("cancel", runningId, "usr_a").ok, true);
    assert.equal(running.cancelled, true);

    const done = new FakeItem({ filename: "done.txt", total: 3 });
    const doneId = d.attach(done, { sessionKey: "usr_a" });
    done.received = 3;
    done.emit("done", "completed");
    assert.ok(d.act("remove", doneId, "usr_b").error, "跨用户不得移除他人的记录");
    assert.equal(d.act("remove", doneId, "usr_a").ok, true);

    const interrupted = new FakeItem({ filename: "net.bin", total: 50 });
    const interruptedId = d.attach(interrupted, { sessionKey: "usr_a" });
    interrupted.emit("done", "interrupted");
    assert.equal(d.get(interruptedId).state, "interrupted");
    assert.ok(d.act("open", interruptedId, "usr_a").error, "失败/中断的下载没有可打开的文件");

    const res = d.clear("usr_a");
    assert.equal(res.removed, 1, "只清掉已结束的那条");
    assert.deepEqual(d.list("usr_a").map((r) => r.downloadId), [runningId], "进行中的下载不得被清掉");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("会话分区（A04）：同一 App 同用户共享；不同用户绝不共享；旧口径不变", () => {
  const legacy = NativeViewController.partitionFor("browser");
  assert.equal(legacy, "openarc-app-browser", "不传 sessionKey 时必须保持 D2-02 的旧名字");
  assert.equal(NativeViewController.partitionFor("browser"), legacy);
  assert.notEqual(NativeViewController.partitionFor("home"), legacy);

  const a = NativeViewController.partitionFor("browser", "usr_a");
  const b = NativeViewController.partitionFor("browser", "usr_b");
  assert.equal(a, NativeViewController.partitionFor("browser", "usr_a"), "同一用户必须稳定映射到同一分区");
  assert.notEqual(a, b, "不同用户必须落到不同分区");
  assert.ok(a.startsWith("openarc-app-browser-u-"));
  assert.ok(!NativeViewController.partitionFor("browser", "usr/../../escape").includes("/"), "分区名不得含路径分隔符");
  assert.equal(NativeViewController.partitionFor("browser", "x".repeat(300)).length < 128, true);
});
