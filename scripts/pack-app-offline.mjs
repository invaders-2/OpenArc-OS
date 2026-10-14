#!/usr/bin/env node
/**
 * OpenArc OS · 离线打包探针（只组装既有产物，不跑 npm run build）
 *
 * 为什么单独一个脚本：仓库既有链路 scripts/sync-app.mjs 先 `npm run build` 再同步；
 * 在"禁止运行 npm run build"的约束下，本脚本直接拿工作区里**已有**的
 * dist/ + electron/ + resources/ 组装一个真实 .app，用于验收打包/分发链路：
 * 载荷完整性（resources 随包）、bundle 身份、openarc-build.json 来源标记、临时签名。
 *
 * 与 sync-app 的同构点：复制 node_modules/electron/dist/Electron.app 作底座，
 * 只改 CFBundleName / CFBundleDisplayName / CFBundleIdentifier；覆盖
 * Contents/Resources/app/{dist,electron,resources,package.json}；改载荷 package.json 的
 * name 以错开 userData；写来源标记；codesign --force --deep --sign -。
 *
 * 用法：
 *   node scripts/pack-app-offline.mjs --app "/tmp/oa-pack/OpenArc OS Pack.app"
 *   node scripts/pack-app-offline.mjs --app ... --from /path/to/worktree --name "OpenArc OS DX"
 *   node scripts/pack-app-offline.mjs --app ... --no-sign
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const ELECTRON_DIST_APP = path.join(REPO, "node_modules/electron/dist/Electron.app");

const args = process.argv.slice(2);
const valueOf = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const fromDir = path.resolve(valueOf("--from") || REPO);
const displayName = valueOf("--name") || "OpenArc OS Pack";
const appArg = valueOf("--app") || path.join(os.tmpdir(), "oa-pack-offline", displayName + ".app");
const APP = path.resolve(appArg);
const noSign = args.includes("--no-sign");

if (!APP.endsWith(".app")) { console.error("[pack-app-offline] --app 必须以 .app 结尾"); process.exit(2); }
if (!fs.existsSync(path.join(fromDir, "dist", "index.html"))) {
  console.error("[pack-app-offline] 源目录缺少已构建的 dist/index.html：" + fromDir + "\n本脚本不跑 npm run build；请先准备好构建产物。");
  process.exit(3);
}
if (!fs.existsSync(path.join(fromDir, "electron", "main.cjs"))) {
  console.error("[pack-app-offline] 源目录缺少 electron/main.cjs：" + fromDir);
  process.exit(3);
}

const run = (cmd, argv) => execFileSync(cmd, argv, { stdio: ["ignore", "inherit", "inherit"] });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const payloadName = slug(displayName);
const bundleId = (() => {
  const suffix = payloadName.replace(/^openarc-os-?/, "");
  return suffix ? "com.openarc.os." + suffix : "com.openarc.os";
})();

function createBundle() {
  if (fs.existsSync(APP)) return false;
  if (!fs.existsSync(ELECTRON_DIST_APP)) throw new Error("找不到 Electron 底座: " + ELECTRON_DIST_APP);
  fs.mkdirSync(path.dirname(APP), { recursive: true });
  console.log("[pack-app-offline] 新建 .app：" + ELECTRON_DIST_APP + " → " + APP);
  run("ditto", [ELECTRON_DIST_APP, APP]);
  const plist = path.join(APP, "Contents/Info.plist");
  run("plutil", ["-replace", "CFBundleName", "-string", displayName, plist]);
  run("plutil", ["-replace", "CFBundleDisplayName", "-string", displayName, plist]);
  run("plutil", ["-replace", "CFBundleIdentifier", "-string", bundleId, plist]);
  return true;
}

const created = createBundle();
const APPX = path.join(APP, "Contents/Resources/app");
for (const name of ["dist", "electron", "resources"]) fs.rmSync(path.join(APPX, name), { recursive: true, force: true });
fs.mkdirSync(APPX, { recursive: true });
fs.cpSync(path.join(fromDir, "dist"), path.join(APPX, "dist"), { recursive: true });
fs.cpSync(path.join(fromDir, "electron"), path.join(APPX, "electron"), { recursive: true });
const srcResources = path.join(fromDir, "resources");
const resourcesCopied = fs.existsSync(srcResources);
if (resourcesCopied) fs.cpSync(srcResources, path.join(APPX, "resources"), { recursive: true });
fs.copyFileSync(path.join(fromDir, "package.json"), path.join(APPX, "package.json"));

const pkgPath = path.join(APPX, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.name = payloadName;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const icon = path.join(fromDir, "build", "icon.icns");
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(APP, "Contents/Resources/electron.icns"));

const marker = {
  branch: "working-tree",
  commit: "offline-pack",
  dirty: true,
  ref: fromDir,
  builtAt: new Date().toISOString(),
  by: "scripts/pack-app-offline.mjs",
  app: APP,
  payloadName,
  resourcesCopied,
  note: "未运行 npm run build；直接组装工作区既有 dist/electron/resources",
};
fs.writeFileSync(path.join(APPX, "openarc-build.json"), JSON.stringify(marker, null, 2));

if (!noSign) run("codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", APP]);

const executable = (() => {
  try { return path.join(APP, "Contents/MacOS", execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", path.join(APP, "Contents/Info.plist")], { encoding: "utf8" }).trim()); }
  catch { return path.join(APP, "Contents/MacOS/Electron"); }
})();
console.log("[pack-app-offline] ✅ " + APP);
console.log("[pack-app-offline] bundle=" + displayName + " / " + bundleId + " / 载荷=" + payloadName + " / 新建=" + created + " / resources=" + resourcesCopied);
console.log("[pack-app-offline] 可执行=" + executable);
console.log("[pack-app-offline] 探针：node experiments/dxos-e2e/run-all.mjs --app-path \"" + APP + "\"");
