"use strict";
/**
 * 声明式协议的执行开关（精确到 providerProtocolId/modelProtocolId/profileId/intent）。
 * 源：DXSRC/protocol-engine/flags.ts:1-87。默认文件改为调用方注入，避免模块加载即写盘。
 */
const fs = require("node:fs");
const path = require("node:path");

const FORMAT = "dx-protocol-execution-flags/v1";
let flagFile = null;
let loaded = false;
let store = { format: FORMAT, rules: [] };

function configureProtocolFlagsFile(file) { flagFile = file ? String(file) : null; loaded = false; store = { format: FORMAT, rules: [] }; }

function normalize(value) {
  return {
    providerProtocolId: String((value && value.providerProtocolId) || "").trim().toLowerCase(),
    modelProtocolId: String((value && value.modelProtocolId) || "").trim().toLowerCase(),
    profileId: String((value && value.profileId) || "").trim().toLowerCase(),
    intent: String((value && value.intent) || "").trim(),
  };
}

function same(left, right) {
  return left.providerProtocolId === right.providerProtocolId && left.modelProtocolId === right.modelProtocolId && left.profileId === right.profileId && left.intent === right.intent;
}

function load() {
  if (loaded) return;
  loaded = true;
  if (!flagFile || !fs.existsSync(flagFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(flagFile, "utf8"));
    if (raw.format !== FORMAT || !Array.isArray(raw.rules)) return;
    store.rules = raw.rules.flatMap((rule) => {
      const key = normalize(rule);
      return key.providerProtocolId && key.modelProtocolId && key.profileId && key.intent
        ? [{ ...key, enabled: rule.enabled === true, updatedAt: Number(rule.updatedAt) || 0 }] : [];
    });
  } catch { /* damaged flags mean all declarative execution remains disabled */ }
}

function persist() {
  if (!flagFile) return;
  fs.mkdirSync(path.dirname(flagFile), { recursive: true });
  const temporary = flagFile + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, flagFile);
}

function listProtocolExecutionFlags() { load(); return structuredClone(store.rules); }

function protocolExecutionEnabled(value) {
  load();
  const key = normalize(value);
  const rule = store.rules.find((item) => same(item, key));
  return !!rule && rule.enabled === true;
}

function setProtocolExecutionFlag(value, updatedAt = Date.now()) {
  load();
  const key = normalize(value);
  if (!key.providerProtocolId || !key.modelProtocolId || !key.profileId || !key.intent) throw new Error("执行开关必须精确指定 providerProtocolId/modelProtocolId/profileId/intent。");
  const rule = { ...key, enabled: value.enabled === true, updatedAt };
  const index = store.rules.findIndex((item) => same(item, key));
  if (index >= 0) store.rules[index] = rule;
  else store.rules.push(rule);
  persist();
  return structuredClone(rule);
}

function resetProtocolExecutionFlagsForTests() { loaded = false; store = { format: FORMAT, rules: [] }; }

module.exports = { configureProtocolFlagsFile, listProtocolExecutionFlags, protocolExecutionEnabled, setProtocolExecutionFlag, resetProtocolExecutionFlagsForTests };
