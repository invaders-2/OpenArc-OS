/**
 * D5-03 第四批 · oa-d503b-* 临时目录的归属标记与清理规则（离线测试，不起 Electron）。
 *
 * 合同（对应 experiments/d5-03/userdata-ownership.cjs）：
 *   · 新建目录必须带 owner.json 归属标记（脚本名 + runId + pid + 用途）；
 *   · 本次运行收尾只删"自己登记过 + 标记确实是自己写的"目录，绝不做通配符扫删；
 *   · 历史孤儿目录三条件缺一不删：前缀 oa-d503b- / 能证明归属 / 归属进程已不在；
 *   · 非本命名空间的目录、符号链接、证明不出来的目录一律跳过。
 *
 * 全部在沙箱根目录里做（沙箱根前缀 oa-d503d-，不属于 oa-d503b- 命名空间），
 * 不碰真实的 OS 临时目录内容。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OWN = require("../experiments/d5-03/userdata-ownership.cjs");

const SANDBOXES = [];
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d503d-ownroot-"));
  SANDBOXES.push(root);
  return root;
}
test.after(() => {
  for (const dir of SANDBOXES) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const mkFake = (root, name, files = []) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const abs = path.join(dir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x");
  }
  return dir;
};
const mkFakeRuns = (root, tags) => {
  const runsDir = path.join(root, "runs");
  for (const tag of tags) fs.mkdirSync(path.join(runsDir, tag + "-" + OWN.SCRIPT), { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  return runsDir;
};
const TAG_A = "20260928T015201Z-796a";
const TAG_B = "20260928T020348Z-fb87";

test("O1 · createOwnedDir 写归属标记，cleanupOwnedDirs 只按清单删自己的目录", () => {
  const root = sandbox();
  const registry = [];
  const created = OWN.createOwnedDir({ prefix: OWN.PREFIX, kind: "unit-test", runId: "20260928T000000Z-aaaa", registry, root });
  assert.equal(registry.length, 1);
  const marker = JSON.parse(fs.readFileSync(path.join(created, OWN.MARKER), "utf8"));
  assert.equal(marker.script, OWN.SCRIPT);
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.kind, "unit-test");
  assert.equal(marker.runId, "20260928T000000Z-aaaa");
  assert.equal(typeof marker.createdAt, "string");

  // 沙箱里再放一个"没登记过"的本命名空间目录：绝不能因为"看起来像"就被删
  const notRegistered = mkFake(root, "oa-d503b-20260928T000000Z-bbbb-zzzzzz", ["identity.db"]);
  const removed = OWN.cleanupOwnedDirs({ log: () => {}, registry, root });
  assert.deepEqual(removed, [path.basename(created)]);
  assert.equal(fs.existsSync(created), false, "登记过 + 标记是自己的目录必须被删掉");
  assert.equal(fs.existsSync(notRegistered), true, "没登记过的目录不得因为名字像就被删");
  assert.equal(registry.length, 0, "清单删空后不应残留");
  assert.deepEqual(OWN.cleanupOwnedDirs({ log: () => {}, registry: [], root }), [], "空清单不删任何东西");

  // 与 mcp-policy-e2e.mjs 的实际调用形状一致：runId 是完整 runId（<tag>-mcp-policy-e2e），目录名里只有 <tag>
  const registry2 = [];
  const realShape = OWN.createOwnedDir({ prefix: OWN.PREFIX, kind: "electron-userdata/run1-first-use", runId: "20260928T000000Z-aaaa-" + OWN.SCRIPT, registry: registry2, root });
  const proof = OWN.ownershipProof({ dir: realShape, name: path.basename(realShape), marker: OWN.readOwnerMarker(realShape) });
  assert.equal(proof.ok, true, "完整 runId 与目录名里的 run 记号必须自洽：" + JSON.stringify(proof));
  assert.equal(proof.kind, "owner-marker");
  assert.deepEqual(OWN.cleanupOwnedDirs({ log: () => {}, registry: registry2, root }), [path.basename(realShape)]);
});

test("O2 · cleanupOwnedDirs 拒绝标记不属于本进程（或已被换掉）的目录", () => {
  const root = sandbox();
  const registry = [];
  const dir = OWN.createOwnedDir({ prefix: OWN.PREFIX, kind: "unit-test", registry, root });
  const markerPath = path.join(dir, OWN.MARKER);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, pid: 999999 }) + "\n");
  const removed = OWN.cleanupOwnedDirs({ log: () => {}, registry, root });
  assert.deepEqual(removed, [], "标记 pid 不是本进程 → 不删");
  assert.equal(fs.existsSync(dir), true);

  fs.rmSync(markerPath);
  const removed2 = OWN.cleanupOwnedDirs({ log: () => {}, registry: [dir], root });
  assert.deepEqual(removed2, [], "标记缺失 → 不删（fail-safe）");
  assert.equal(fs.existsSync(dir), true);
});

test("O3 · 三条件判定矩阵（classifyCandidate）", () => {
  const root = sandbox();
  const runsDir = mkFakeRuns(root, [TAG_A]);
  const nameA = "oa-d503b-" + TAG_A + "-aaaaaa";
  const withDb = mkFake(root, nameA, ["identity.db"]);
  const empty = mkFake(root, "oa-d503b-" + TAG_A + "-bbbbbb", []);
  const legacy = mkFake(root, "oa-d503b-" + TAG_A + "-legacy-cccccc", ["electron/identity-bootstrap.cjs", "package.json"]);
  const foreignPrefix = mkFake(root, "oa-d503c-" + TAG_A + "-dddddd", ["identity.db"]);
  const base = { dirInUse: false, runRecord: true };

  assert.equal(OWN.classifyCandidate({ ...base, dir: withDb, name: nameA, marker: null }).action, "delete", "identity.db 即可证明归属");
  assert.equal(OWN.classifyCandidate({ ...base, dir: legacy, name: path.basename(legacy), marker: null }).action, "delete", "legacy 解包树形状可证明归属");
  assert.equal(OWN.classifyCandidate({ ...base, dir: legacy, name: path.basename(legacy), marker: null }).proof, "legacy-tree");
  assert.equal(OWN.classifyCandidate({ ...base, dir: empty, name: path.basename(empty), marker: null }).action, "skip", "证明不出归属就不删");
  assert.equal(OWN.classifyCandidate({ ...base, dir: foreignPrefix, name: path.basename(foreignPrefix), marker: null }).action, "skip", "其它前缀不删");
  assert.equal(OWN.classifyCandidate({ dir: withDb, name: nameA, marker: null, dirInUse: true, runRecord: true }).action, "skip", "仍有存活进程引用就不删");
  assert.equal(OWN.classifyCandidate({ dir: withDb, name: nameA, marker: null, dirInUse: false, runRecord: false }).action, "skip", "无 pid 且无 run 归档证据就不删");

  // 标记分支
  const aliveMarker = { script: OWN.SCRIPT, pid: process.pid, runId: TAG_A };
  assert.equal(OWN.classifyCandidate({ ...base, dir: empty, name: path.basename(empty), marker: aliveMarker }).action, "skip", "归属 pid 还活着就不删");
  assert.equal(OWN.ownerPidState({ pid: 999999 }), "dead");
  const deadMarker = { script: OWN.SCRIPT, pid: 999999, runId: TAG_A };
  const dead = OWN.classifyCandidate({ ...base, dir: empty, name: path.basename(empty), marker: deadMarker });
  assert.equal(dead.action, "delete", "标记显示 pid 已死 → 可删");
  assert.equal(dead.proof, "owner-marker");
  assert.equal(OWN.classifyCandidate({ ...base, dir: empty, name: path.basename(empty), marker: { ...deadMarker, runEnded: true } }).action, "delete", "标记写明 run 已结束 → 可删");
  assert.equal(OWN.classifyCandidate({ ...base, dir: empty, name: path.basename(empty), marker: { ...deadMarker, script: "other-script" } }).action, "skip", "标记属于别的脚本就不删（即使同前缀）");
  assert.equal(OWN.classifyCandidate({ ...base, dir: empty, name: "oa-d503b-" + TAG_B + "-eeeeee", marker: deadMarker }).action, "skip", "标记 runId 与目录名不一致就不删");
});

test("O4 · cleanOrphans：dry-run 不动手；apply 只删三条件齐备的 4 个，诱饵原样保留", () => {
  const root = sandbox();
  const runsDir = mkFakeRuns(root, [TAG_A, TAG_B]);
  const targets = [
    "oa-d503b-" + TAG_A + "-g5L6x1",
    "oa-d503b-" + TAG_A + "-legacy-iG33hb",
    "oa-d503b-" + TAG_B + "-ILBIo7",
    "oa-d503b-" + TAG_B + "-legacy-a3qbHm",
  ];
  for (const name of targets) {
    if (name.includes("-legacy-")) mkFake(root, name, ["electron/identity-bootstrap.cjs", "package.json"]);
    else mkFake(root, name, ["identity.db", ".electron-cache"]);
  }
  const decoys = [
    mkFake(root, "oa-d503b-" + TAG_A + "-nosuch", ["random.txt"]),          // 前缀对，但证明不出归属
    mkFake(root, "oa-d503b-notarun-ffffff", ["identity.db"]),                 // 前缀对，run 记号对不上
    mkFake(root, "other-tool-20260928T015201Z-796a-gggggg", ["identity.db"]), // 别的前缀
  ];
  const logs = [];
  const dry = OWN.cleanOrphans({ root, runsDir, apply: false, log: (l) => logs.push(l) });
  assert.equal(dry.scanned, 6, "只扫描本命名空间的 6 个目录");
  assert.deepEqual(dry.deleted.slice().sort(), targets.slice().sort(), "dry-run 判定可删的正是这 4 个");
  assert.equal(dry.skipped.length, 2);
  for (const name of targets) assert.equal(fs.existsSync(path.join(root, name)), true, "dry-run 不得真删：" + name);
  assert.equal(logs.some((l) => l.startsWith("[DRY-RUN] 会删 ")), true, "每个删除都要打日志");

  const applied = OWN.cleanOrphans({ root, runsDir, apply: true, log: (l) => logs.push(l) });
  assert.deepEqual(applied.deleted.slice().sort(), targets.slice().sort());
  for (const name of targets) assert.equal(fs.existsSync(path.join(root, name)), false, "apply 必须删掉：" + name);
  for (const dir of decoys) assert.equal(fs.existsSync(dir), true, "诱饵目录必须原样保留：" + dir);
  assert.equal(logs.some((l) => l.startsWith("[DELETED] ")), true, "每个删除都要打日志");
  assert.equal(logs.some((l) => l.includes("无法证明是本脚本产物")), true, "跳过也要打日志");
});

test("O5 · 只读探测：ps 不可用 / 目录被引用时的 fail-closed 行为", () => {
  const root = sandbox();
  const dir = mkFake(root, "oa-d503b-" + TAG_A + "-hhhhhh", ["identity.db"]);
  assert.equal(OWN.isDirInUse(dir, null), true, "拿不到 ps 快照 → 一律当「在用」（fail-closed）");
  const snapshot = "  1 /sbin/launchd\n  4242 node " + dir + "\n";
  assert.equal(OWN.isDirInUse(dir, snapshot), true, "快照里有别的进程引用该目录 → 在用");
  assert.equal(OWN.isDirInUse(dir, "  1 /sbin/launchd\n"), false, "快照里没有引用 → 不在用");
  const realSnapshot = OWN.psSnapshot();
  assert.equal(realSnapshot === null || typeof realSnapshot === "string", true);
  assert.equal(typeof OWN.tagOf("oa-d503b-" + TAG_A + "-iiiiii"), "string");
  assert.equal(OWN.tagOf("not-ours-xxxx"), null);
  assert.equal(OWN.isOwnName("oa-d503c-xxxx"), false);
});
