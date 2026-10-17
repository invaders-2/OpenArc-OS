#!/usr/bin/env node
/**
 * DSH 运行时闭包：只把 @deepseek-ai/dsh / @agentclientprotocol/sdk 真实依赖树复制进 .app。
 * 打包后的 app 没有仓库 node_modules；缺闭包会让 harness 直接起不来。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const PINNED = Object.freeze({ "@deepseek-ai/dsh": "0.1.5-rc.2", "@agentclientprotocol/sdk": "1.4.0" });

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function packageDirFrom(nodeModulesRoot, name) {
  const dir = path.join(nodeModulesRoot, ...name.split("/"));
  return fs.existsSync(path.join(dir, "package.json")) ? dir : null;
}

function resolvePackageDir(name, fromDir, nodeModulesRoot) {
  // 先走文件系统：require.resolve(name + "/package.json") 可能命中包内 dist/cjs/package.json，
  // 把子目录误当成包根（@modelcontextprotocol/sdk 就踩过）。
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = packageDirFrom(path.join(dir, "node_modules"), name);
    if (candidate) return candidate;
    if (dir === path.dirname(dir)) break;
  }
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    try { return path.dirname(createRequire(path.join(dir, "package.json")).resolve(name + "/package.json")); } catch { /* exports 可能屏蔽 package.json */ }
    if (dir === path.dirname(dir)) break;
  }
  return packageDirFrom(nodeModulesRoot, name);
}

/**
 * 从真实安装解析 seeds 的完整 dependencies 闭包。
 * @returns {{ packages: Map<string,{name:string,version:string,source:string,relative:string}>, nodeModulesRoot: string }}
 */
function defaultSeeds(root) {
  const seeds = new Set([...Object.keys(PINNED), "@modelcontextprotocol/sdk"]);
  const discovered = new Set();
  try {
    for (const scopeName of ["@modelcontextprotocol", "@agentclientprotocol"]) {
      const scopeDir = path.join(root, "node_modules", scopeName);
      for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (entry.isDirectory()) seeds.add(scopeName + "/" + entry.name);
      }
    }
  } catch { /* scope 未安装 */ }
  const walk = (dir, depth) => {
    if (depth > 7) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) { walk(full, depth + 1); continue; }
      if (fs.existsSync(path.join(full, "package.json"))) {
        if (dir.endsWith(path.join("@deepseek-ai"))) discovered.add(full);
        const nested = path.join(full, "node_modules");
        if (fs.existsSync(nested)) walk(nested, depth + 1);
      }
    }
  };
  // DSH 的 loader 会动态 import 未在 package.json dependencies 声明的同 scope 包；
  // 因此所有已安装 @deepseek-ai/*（含 dsh 自身 nested node_modules）都进入种子。
  try { walk(path.join(root, "node_modules"), 0); } catch { /* 只装了 DSH 单体包的场景 */ }
  // DSH 还会动态 import 未声明的普通包（如 @modelcontextprotocol/sdk）；把 npm 生产依赖树
  // 全部作为绝对路径种子，避免逐个追缺失包导致打包后启动失败。
  try {
    const lines = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
    for (const line of lines) {
      const dir = line.trim();
      if (dir && path.resolve(dir) !== path.resolve(root) && fs.existsSync(path.join(dir, "package.json"))) discovered.add(dir);
    }
  } catch { /* npm ls 失败时只靠 @deepseek-ai 闭包 */ }
  // 绝对路径种子的依赖从各自安装位置解析，避免 nested 包在根 node_modules 解析失败。
  return [...seeds, ...discovered];
}

export function collectDshRuntimeClosure({ root, seeds = null } = {}) {
  if (!root) throw new Error("collectDshRuntimeClosure 需要 root");
  if (!Array.isArray(seeds)) seeds = defaultSeeds(root);
  const nodeModulesRoot = path.join(root, "node_modules");
  const packages = new Map();
  const visiting = new Set();
  const visit = (name, fromDir) => {
    const explicit = path.isAbsolute(String(name)) && fs.existsSync(path.join(String(name), "package.json")) ? String(name) : null;
    const source = explicit || resolvePackageDir(name, fromDir, nodeModulesRoot);
    if (!source) throw new Error("DSH_RUNTIME_DEPENDENCY_MISSING: " + name);
    const real = fs.realpathSync(source);
    if (packages.has(real) || visiting.has(real)) return;
    const pkg = readJson(path.join(real, "package.json"));
    if (!pkg) throw new Error("DSH_RUNTIME_PACKAGE_INVALID: " + real);
    visiting.add(real);
    const deps = pkg.dependencies || {};
    for (const dep of Object.keys(deps)) visit(dep, real);
    // 原生模块（sharp/koffi）的平台包与运行时 peer 常常只出现在 optional/peer 里；
    // 已安装才复制，缺平台包不阻断（但 DSH 真跑时会在 stderr 明确报缺）。
    for (const group of [pkg.optionalDependencies || {}, pkg.peerDependencies || {}]) {
      for (const dep of Object.keys(group)) { try { visit(dep, real); } catch { /* 未安装的可选/平台包 */ } }
    }
    visiting.delete(real);
    const relative = path.relative(fs.realpathSync(nodeModulesRoot), real);
    packages.set(real, {
      name: pkg.name || name,
      version: pkg.version || "",
      source: real,
      relative: relative.startsWith("..") ? path.join(...name.split("/")) : relative,
    });
  };
  for (const seed of seeds) visit(seed, root);
  return { packages, nodeModulesRoot: fs.realpathSync(nodeModulesRoot) };
}

/** 复制闭包到目标 node_modules，并重建 .bin/dsh（相对软链，随 .app 搬移仍有效）。 */
export function copyDshRuntimeClosure({ root, destNodeModules, seeds = null, clean = true } = {}) {
  if (!destNodeModules) throw new Error("copyDshRuntimeClosure 需要 destNodeModules");
  const { packages } = collectDshRuntimeClosure({ root, seeds });
  for (const [name, pin] of Object.entries(PINNED)) {
    const fingerprint = [...packages.values()].find((entry) => entry.name === name);
    if (!fingerprint) throw new Error("DSH_RUNTIME_DEPENDENCY_MISSING: " + name);
    if (fingerprint.version !== pin) throw new Error("DSH_VERSION_MISMATCH: " + name + " 需要 " + pin + "，实际 " + fingerprint.version);
  }
  if (clean) fs.rmSync(destNodeModules, { recursive: true, force: true });
  fs.mkdirSync(destNodeModules, { recursive: true, mode: 0o755 });
  let bytes = 0;
  for (const entry of packages.values()) {
    const target = path.join(destNodeModules, entry.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.cpSync(entry.source, target, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const rel = path.relative(entry.source, source);
        if (rel.split(path.sep).includes("node_modules")) return false;
        return true;
      },
    });
    bytes += directoryBytes(target);
  }
  const dsh = packages.get(fs.realpathSync(path.join(root, "node_modules", "@deepseek-ai", "dsh")));
  const binDir = path.join(destNodeModules, ".bin");
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const binTarget = path.join(binDir, "dsh");
  fs.rmSync(binTarget, { force: true });
  fs.symlinkSync(path.relative(binDir, path.join(destNodeModules, dsh.relative, "lib", "bin.js")), binTarget);
  return { packages: packages.size, bytes, bin: binTarget, versions: [...packages.values()].filter((entry) => PINNED[entry.name]).map((entry) => ({ name: entry.name, version: entry.version })) };
}

function directoryBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

export const DSH_RUNTIME_PINS = PINNED;
