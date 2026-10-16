#!/usr/bin/env node
/**
 * 机械抽取脚本：从只读的 DX OS 0.5.1 源码生成 electron/dxos-agent-schema.cjs。
 *
 * 基准版本变更（2026-10-16）：对齐基准由 runtime-0.5.5-0b51356e-72a5-4bf1-82e1-1bfc70b3d08d
 * 改为 runtime-0.6.1-c2699917-1363-460d-97c3-da88f6d3fbe5。依据：DXOS-Portable 的
 * .dx-runtime/versions/ 下 0.5.5 目录已删除、只剩 0.6.1；两版 server/ccsDb.ts 抽取结果逐字节相同，
 * 因此产物 electron/dxos-agent-schema.cjs 无需重生成（--stdout 与仓库文件 diff 为空）。
 *
 * 为什么用脚本：B3a 的硬约束是"机械抽取、不允许手抄"。本脚本读 server/ccsDb.ts，
 * 抽 tasks / task_steps / task_events 的最终列集（基础 CREATE TABLE + 全部 ALTER TABLE
 * ADD COLUMN 折叠），去掉 REFERENCES 外键，输出 dx_ 前缀表的幂等 DDL。
 *
 * 用法：
 *   node scripts/extract-dxos-agent-schema.mjs                 # 写回 electron/dxos-agent-schema.cjs
 *   node scripts/extract-dxos-agent-schema.mjs --stdout        # 只打印，不落盘
 *   DXOS_SRC=<unpacked server 目录> node scripts/extract-dxos-agent-schema.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_SRC =
  "/Users/wepingli/Downloads/DXOS-Portable-0.5.1-mac-arm64/.dx-runtime/versions/runtime-0.6.1-c2699917-1363-460d-97c3-da88f6d3fbe5/DX OS.app/Contents/Resources/app.asar.unpacked";
const SRC_ROOT = process.env.DXOS_SRC || DEFAULT_SRC;
const CCS_DB = path.join(SRC_ROOT, "server", "ccsDb.ts");
const OUT = path.join(ROOT, "electron", "dxos-agent-schema.cjs");

const TABLES = ["tasks", "task_steps", "task_events"];
const DX_PREFIX = "dx_";

/** 去掉 DX 原文里的 REFERENCES 外键（含 ON DELETE/UPDATE 子句）。 */
const FK_RE =
  /\s+REFERENCES\s+[A-Za-z_][A-Za-z0-9_]*\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))*/gi;

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function findCreateTable(text, name) {
  const re = new RegExp("CREATE TABLE\\s+" + name + "\\s*\\(", "g");
  const m = re.exec(text);
  if (!m) throw new Error("找不到 CREATE TABLE " + name);
  const open = text.indexOf("(", m.index);
  let depth = 0;
  let i = open;
  for (; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return { body: text.slice(open + 1, i), startLine: lineOf(text, m.index), endLine: lineOf(text, i) };
}

function findAlters(text, name) {
  const re = new RegExp("ALTER TABLE\\s+" + name + "\\s+ADD COLUMN\\s+([^;]+);", "g");
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ line: lineOf(text, m.index), def: m[1].trim() });
  return out;
}

function findIndexes(text) {
  const re =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+(tasks|task_steps|task_events)\s*\(([^)]*)\)(\s*WHERE[\s\S]*?)?;/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({
      line: lineOf(text, m.index),
      unique: Boolean(m[1]),
      name: m[2],
      table: m[3],
      columns: m[4].replace(/\s+/g, " ").trim(),
      where: m[5] ? m[5].replace(/\s+/g, " ").trim() : "",
    });
  }
  return out;
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function isConstraint(part) {
  return /^(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(part);
}

function stripForeignKeys(def) {
  return def.replace(FK_RE, "").replace(/\s+/g, " ").trim();
}

function buildTable(name, ddlName, base, alters) {
  const parts = splitTopLevel(base.body);
  const columns = parts.filter((p) => !isConstraint(p)).map(stripForeignKeys);
  const constraints = parts.filter(isConstraint);
  const alterDefs = alters.map((a) => stripForeignKeys(a.def));
  const all = [...columns, ...alterDefs, ...constraints];
  const body = all.map((line) => "  " + line).join(",\n");
  return { sql: "CREATE TABLE IF NOT EXISTS " + ddlName + " (\n" + body + "\n)", columns: [...columns, ...alterDefs], constraints };
}

function quote(s) {
  return JSON.stringify(s);
}

function main() {
  const text = fs.readFileSync(CCS_DB, "utf8");
  const base = {};
  const alters = {};
  for (const t of TABLES) {
    base[t] = findCreateTable(text, t);
    alters[t] = findAlters(text, t);
  }
  const indexes = findIndexes(text);

  const tables = TABLES.map((t) => ({ name: t, ddl: DX_PREFIX + t, ...buildTable(t, DX_PREFIX + t, base[t], alters[t]) }));
  const columnCounts = {};
  for (const t of tables) columnCounts[t.ddl] = t.columns.length;

  const ddlStatements = tables.map((t) => t.sql);
  const indexStatements = indexes.map((idx) => {
    const ddlName = DX_PREFIX + idx.name;
    const onTable = DX_PREFIX + idx.table;
    const where = idx.where ? " " + idx.where : "";
    return {
      name: idx.name,
      ddlName,
      sql: "CREATE " + (idx.unique ? "UNIQUE " : "") + "INDEX IF NOT EXISTS " + ddlName + " ON " + onTable + "(" + idx.columns + ")" + where,
    };
  });
  for (const idx of indexStatements) ddlStatements.push(idx.sql);

  // OpenArc 桥接表：DX 的 projects.root_node_id 在 OpenArc 既有 projects 里没有对应列。
  // 不能改既有表结构，所以把这一条语义单独落一张只读映射表。
  const bridgeDdl =
    "CREATE TABLE IF NOT EXISTS dx_project_roots (\n" +
    "  project_id   TEXT PRIMARY KEY,\n" +
    "  root_node_id TEXT NOT NULL UNIQUE,\n" +
    "  created_at   INTEGER NOT NULL\n" +
    ")";
  ddlStatements.push(bridgeDdl);

  const lines = [];
  lines.push("/**");
  lines.push(" * P1/B3a · DX OS 0.5.1 任务域表结构抽取（机械生成，勿手改）。");
  lines.push(" *");
  lines.push(" * 生成脚本：scripts/extract-dxos-agent-schema.mjs");
  lines.push(" *   node scripts/extract-dxos-agent-schema.mjs");
  lines.push(" * 源文件：<DX OS.app>/Contents/Resources/app.asar.unpacked/server/ccsDb.ts");
  lines.push(" *");
  lines.push(" * ## 抽取方法");
  lines.push(" *   1. 取基础 CREATE TABLE（源行号如下），拆成列定义与表级约束；");
  lines.push(" *   2. 把该表全部 ALTER TABLE ADD COLUMN 折叠进列区（放在表级约束之前）；");
  lines.push(" *   3. 去掉每个列定义里的 REFERENCES ... ON DELETE/UPDATE ... 外键（P1 既定做法：跨域只留列）；");
  lines.push(" *   4. 表名加 dx_ 前缀，索引名加 dx_ 前缀并指向 dx_ 表；全部 CREATE ... IF NOT EXISTS。");
  lines.push(" *");
  lines.push(" * ## 源行号（本脚本 grep 所得，不手抄）");
  for (const t of TABLES) {
    const bs = base[t];
    const al = alters[t].map((a) => a.line);
    lines.push(" *   " + t + ": CREATE TABLE " + bs.startLine + "-" + bs.endLine + "；ALTER ADD COLUMN " + al.length + " 处，行 " + JSON.stringify(al));
  }
  lines.push(" *   索引 " + indexes.length + " 条，行 " + JSON.stringify(indexes.map((i) => i.line)));
  lines.push(" *");
  lines.push(" * ## 自检（列数 / 关键列）");
  for (const t of tables) {
    lines.push(" *   " + t.ddl + ": " + t.columns.length + " 列，表级约束 " + t.constraints.length + " 条，外键 0 条");
  }
  lines.push(" *");
  lines.push(" * ## OpenArc 桥接表（非抽取，见下方常量注释）");
  lines.push(" *   dx_project_roots —— 承接 DX projects.root_node_id 语义。");
  lines.push(" */");
  lines.push('"use strict";');
  lines.push("");
  lines.push("/** dx_ 前缀的三张任务域表（DX 原文为 tasks / task_steps / task_events）。 */");
  lines.push("const DXOS_AGENT_TABLES = Object.freeze([" + TABLES.map((t) => quote(DX_PREFIX + t)).join(", ") + "]);");
  lines.push("");
  lines.push("/** 每张表的最终列数（抽取自检基线）。 */");
  lines.push(
    "const DXOS_AGENT_COLUMN_COUNTS = Object.freeze({ " +
      tables.map((t) => quote(t.ddl) + ": " + t.columns.length).join(", ") +
      " });",
  );
  lines.push("");
  lines.push("/** 关键列存在性自检基线（抽样覆盖后续迁移追加的列）。 */");
  lines.push("const DXOS_AGENT_KEY_COLUMNS = Object.freeze({");
  const keyCols = {
    dx_tasks: ["id", "project_id", "thread_id", "status", "worker_id", "lease_until", "lease_token", "attempt_no", "mode", "model_calls", "tool_calls", "waiting_question", "execution_profile", "parent_task_id", "root_task_id", "depends_on_json", "delegation_depth", "legacy_source_id", "preferred_llm_model"],
    dx_task_steps: ["id", "task_id", "ordinal", "operation_id", "plan_version", "expected_output", "result_summary"],
    dx_task_events: ["id", "task_id", "sequence", "type", "message", "data_json"],
  };
  lines.push(keyCols ? "" : "");
  for (const t of tables) {
    lines.push("  " + quote(t.ddl) + ": Object.freeze([" + (keyCols[t.ddl] || []).map(quote).join(", ") + "]),");
  }
  lines.push("});");
  lines.push("");
  lines.push("/** dx_ 索引（名称与目标表都加了 dx_ 前缀，避免与 OpenArc 既有索引撞名）。 */");
  lines.push("const DXOS_AGENT_INDEXES = Object.freeze([");
  for (const idx of indexStatements) lines.push("  " + quote(idx.sql) + ",");
  lines.push("]);");
  lines.push("");
  lines.push("/**");
  lines.push(" * OpenArc 桥接表：**不是**从 ccsDb.ts 抽取的。");
  lines.push(" * OpenArc 既有 projects 没有 root_node_id 列，而硬约束禁止改既有表结构；");
  lines.push(" * 这里只新增一张映射表承接 DX projects.root_node_id 语义，" + "createProject/projectForRoot 用它落位。");
  lines.push(" */");
  lines.push("const DXOS_PROJECT_BRIDGE_DDL = Object.freeze([" + quote(bridgeDdl) + "]);");
  lines.push("");
  lines.push("/** 幂等 DDL：三张表 + 全部索引 + 桥接表（表先于索引）。 */");
  lines.push("const DXOS_AGENT_DDL = Object.freeze([");
  for (const s of ddlStatements) lines.push("  " + quote(s) + ",");
  lines.push("]);");
  lines.push("");
  lines.push("/** @returns {string[]} DDL 语句副本。 */");
  lines.push("function dxosAgentDdl() {");
  lines.push("  return DXOS_AGENT_DDL.slice();");
  lines.push("}");
  lines.push("");
  lines.push("/** 抽取正确性自检：列数、关键列、外键已去。返回 true 或抛错。 */");
  lines.push("function dxosAgentSchemaSelfCheck() {");
  lines.push("  const tables = {};");
  lines.push("  for (const statement of DXOS_AGENT_DDL) {");
  lines.push("    const prefix = 'CREATE TABLE IF NOT EXISTS ';");
  lines.push("    if (statement.indexOf(prefix) !== 0) continue;");
  lines.push("    const open = statement.indexOf('(');");
  lines.push("    const name = statement.slice(prefix.length, statement.indexOf(' (', prefix.length));");
  lines.push("    const entries = statement.slice(open + 1, statement.length - 1).split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line.length > 0).map((line) => (line.charAt(line.length - 1) === ',' ? line.slice(0, -1).trim() : line));");
  lines.push("    const isConstraint = (c) => ['UNIQUE', 'PRIMARY KEY', 'FOREIGN KEY', 'CHECK', 'CONSTRAINT'].some((p) => c.indexOf(p) === 0);");
  lines.push("    tables[name] = { columns: entries, defs: entries.filter((c) => !isConstraint(c)) };");
  lines.push("  }");
  lines.push("  for (const [table, expected] of Object.entries(DXOS_AGENT_COLUMN_COUNTS)) {");
  lines.push("    const found = tables[table];");
  lines.push("    if (!found) throw new Error('缺少表 ' + table);");
  lines.push("    if (found.defs.length !== expected) throw new Error(table + ' 列数不符：' + found.defs.length + ' != ' + expected);");
  lines.push("    const names = found.defs.map((c) => c.slice(0, c.indexOf(' ')));");
  lines.push("    for (const key of DXOS_AGENT_KEY_COLUMNS[table]) if (!names.includes(key)) throw new Error(table + ' 缺少关键列 ' + key);");
  lines.push("    for (const def of found.columns) if (def.indexOf('REFERENCES') !== -1) throw new Error(table + ' 仍有外键：' + def);");
  lines.push("  }");
  lines.push("  return true;");
  lines.push("}");
  lines.push("");
  lines.push("module.exports = {");
  lines.push("  DXOS_AGENT_TABLES,");
  lines.push("  DXOS_AGENT_COLUMN_COUNTS,");
  lines.push("  DXOS_AGENT_KEY_COLUMNS,");
  lines.push("  DXOS_AGENT_INDEXES,");
  lines.push("  DXOS_PROJECT_BRIDGE_DDL,");
  lines.push("  DXOS_AGENT_DDL,");
  lines.push("  dxosAgentDdl,");
  lines.push("  dxosAgentSchemaSelfCheck,");
  lines.push("};");
  lines.push("");
  const out = lines.join("\n");

  // 自检：模块级断言在任何落盘前先跑一遍（要求 REFERENCES 全去、列数一致）。
  const moduleShim = { exports: {} };
  new Function("module", "exports", out)(moduleShim, moduleShim.exports);
  moduleShim.exports.dxosAgentSchemaSelfCheck();

  if (process.argv.includes("--stdout")) process.stdout.write(out);
  else {
    fs.writeFileSync(OUT, out, "utf8");
    process.stdout.write("wrote " + path.relative(ROOT, OUT) + " (" + Buffer.byteLength(out, "utf8") + " bytes)\n");
  }
}

main();
