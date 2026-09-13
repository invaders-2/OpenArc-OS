/** D3-04C 探针 01 · FTS5 能力 / CJK 分词容器 / Node + Electron 一致性。 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { Probe, ROOT, searchDomain } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const p = new Probe("01-fts-capability", "FTS5 能力 / CJK 分词 / Node 与 Electron 一致");

const db = new DatabaseSync(":memory:");
const ver = db.prepare("select sqlite_version() v").get().v;
p.note("Node SQLite " + ver + " / " + process.version);
db.exec("CREATE VIRTUAL TABLE u USING fts5(body, tokenize='unicode61')");
const ins = db.prepare("INSERT INTO u(body) VALUES (?)");
const tok = (s) => searchDomain.indexTokenString(s);
ins.run(tok("红色鞋子 详情页 生成提示词"));
const match = (q) => db.prepare("SELECT count(*) c FROM u WHERE u MATCH ?").get(searchDomain.buildFtsQuery(searchDomain.parseQuery(q).tokens)).c;
p.assert("FTS5 + unicode61 可用", typeof ver === "string");
p.assert("中文 2 字「鞋子」可命中（bigram 容器）", match("鞋子") === 1, "match=" + match("鞋子"));
p.assert("中文「详情页」可命中", match("详情页") === 1, "match=" + match("详情页"));
p.assert("中文「生成提示」可命中", match("生成提示") === 1, "match=" + match("生成提示"));
p.assert("单字「鞋」可命中（unigram）", match("鞋") === 1, "match=" + match("鞋"));
p.assert("英文整词可命中", (() => { ins.run(tok("hello world")); return match("hello") >= 1; })());
p.assert("bm25 / snippet 函数可用", (() => { const r = db.prepare("SELECT bm25(u) r, snippet(u,0,'[',']','…',4) s FROM u WHERE u MATCH ?").get("\"hello\""); return typeof r.r === "number" && typeof r.s === "string"; })());
db.close();

// Electron 侧同能力（真实主进程）
const probeDir = path.join(ROOT, "tests", "fixtures", "fts-electron-probe");
const electron = require("electron");
const child = spawn(electron, [probeDir], { stdio: ["ignore", "pipe", "pipe"], env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; delete e.ELECTRON_NO_ATTACH_CONSOLE; return e; })() });
let out = "";
child.stdout.on("data", (d) => { out += String(d); });
child.stderr.on("data", (d) => { out += String(d); });
await new Promise((resolve) => { const t = setTimeout(() => child.kill("SIGKILL"), 60000); child.on("exit", () => { clearTimeout(t); resolve(); }); });
const m = out.match(/FTSRESULT (\{[\s\S]*?\})\s*$/);
if (m) {
  const r = JSON.parse(m[1]);
  p.assert("Electron 主进程 FTS5 可用", r.ok === true, "sqlite=" + (r.sqlite || r.error));
  p.assert("Electron trigram tokenizer 可用（仅作能力确认，不用于 2 字中文）", typeof r.trigram === "string", String(r.trigram).slice(0, 60));
  p.assert("Electron snippet/bm25 可用", typeof r.snippet === "string");
} else {
  p.case("Electron FTS 探针输出", "FAIL", "no FTSRESULT");
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
