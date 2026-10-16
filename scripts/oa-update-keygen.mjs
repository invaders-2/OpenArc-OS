#!/usr/bin/env node
/**
 * OpenArc OS · 画布在线更新：Ed25519 签名密钥生成（Stage 1）。
 *
 * 干什么：
 *   · 生成 Ed25519 密钥对；
 *   · 私钥写 <repo>/.keys/update-signing.key（0600；.keys/ 已在 .gitignore，绝不入库）；
 *   · 公钥（32 字节原始 Ed25519 公钥的 base64）写入 resources/app-update-keys.json 的 canvas 字段。
 *
 * 换密钥 = 换 resources/app-update-keys.json 里那个值；私钥换了，旧私钥签的包一律验签失败
 * （这是故意的：更新源与客户端公钥必须成对发布）。
 *
 * 用法：
 *   node scripts/oa-update-keygen.mjs                 # 生成（已存在则只回读并同步公钥）
 *   node scripts/oa-update-keygen.mjs --force         # 覆盖已存在的私钥（危险：旧私钥作废）
 *   node scripts/oa-update-keygen.mjs --print         # 只打印公钥，不写任何文件
 *   node scripts/oa-update-keygen.mjs --key-file <path> --keys-file <path>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const keyPath = path.resolve(valueOf("--key-file") || path.join(ROOT, ".keys", "update-signing.key"));
const keysFile = path.resolve(valueOf("--keys-file") || path.join(ROOT, "resources", "app-update-keys.json"));
const printOnly = args.includes("--print");
const force = args.includes("--force");
const appId = valueOf("--app") || "canvas";

function rawPublicKeyBase64(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("base64");
}

function mergePublicKey(b64) {
  let json = {};
  try { json = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch { /* 文件不存在或坏 JSON → 重建 */ }
  if (!json || typeof json !== "object" || Array.isArray(json)) json = {};
  json[appId] = b64;
  fs.mkdirSync(path.dirname(keysFile), { recursive: true });
  fs.writeFileSync(keysFile, JSON.stringify(json, null, 2) + "\n");
}

function warnIfNotIgnored() {
  try {
    const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    if (!ignore.split("\n").some((line) => line.trim() === ".keys/")) {
      console.error("[oa-update-keygen] 警告：.gitignore 未忽略 .keys/，请立即补上，避免私钥入库！");
    }
  } catch { /* 没有 .gitignore 时跳过 */ }
}

let publicKey;
let generated = false;
if (!fs.existsSync(keyPath) || force) {
  const pair = crypto.generateKeyPairSync("ed25519");
  publicKey = pair.publicKey;
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows 忽略 */ }
  generated = true;
} else {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8"));
  publicKey = crypto.createPublicKey(privateKey);
}

const b64 = rawPublicKeyBase64(publicKey);
if (!printOnly) mergePublicKey(b64);
warnIfNotIgnored();

console.log("[oa-update-keygen] " + (generated ? "已生成新密钥对" : "复用已有私钥"));
console.log("[oa-update-keygen] 私钥（0600，绝不入库）: " + keyPath);
console.log("[oa-update-keygen] 公钥文件: " + keysFile + "（canvas=" + b64 + "）");
if (printOnly) console.log("[oa-update-keygen] --print：只打印，未写任何文件");
