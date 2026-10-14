/**
 * P1 · DX OS 地基：落盘布局解析（计划 §6.1）。
 *
 * 为什么固定在一处：后续技能 / MCP / ComfyUI / 媒体各域都会读写这些路径，
 * 各自拼路径迟早会拼出不一致的子目录；这里只做"解析 + 建目录"，
 * 不碰文件内容，也不创建任何文件（密钥仍走 credential-store）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createDxosError, DXOS_ERR_INVALID_INPUT } = require("./dxos-foundation-errors.cjs");

const DXOS_DIR_NAME = "dxos";

const DXOS_LAYOUT = Object.freeze({
  files: Object.freeze(["providers.json", "mcp.json", "mcp.system.json", "skills.json"]),
  directories: Object.freeze(["skills", "skill-packs", "comfy-workflows", "ai-tasks", "media", "logs", "diagnostics"]),
});

function assertUserDataDir(userDataDir) {
  if (typeof userDataDir !== "string" || userDataDir.trim() === "") {
    throw createDxosError(DXOS_ERR_INVALID_INPUT, "userDataDir 必须是非空字符串");
  }
  return userDataDir;
}

/** 解析 <userData>/dxos/ 下的全部文件与目录（不创建）。 */
function resolveDxosPaths(userDataDir) {
  const base = assertUserDataDir(userDataDir);
  const root = path.join(base, DXOS_DIR_NAME);
  const file = {};
  for (const name of DXOS_LAYOUT.files) file[name] = path.join(root, name);
  const directory = {};
  for (const name of DXOS_LAYOUT.directories) directory[name] = path.join(root, name);
  return { userDataDir: base, root, file, directory, files: DXOS_LAYOUT.files, directories: DXOS_LAYOUT.directories };
}

// B6b（dxos-fs.cjs）新增：DX 虚拟文件树数据目录 <userData>/dxos/fs（fs.json + blobs/ + cache/fs-thumbnails/）。
// 不并入上面的 DXOS_LAYOUT.directories —— dxos-foundation.test.mjs:219 精确断言该数组内容，
// 保持既有契约不动；dxos-fs.cjs 首次写入时会自行建目录。
const DXOS_FS_DIR_NAME = "fs";

/** 解析 <userData>/dxos/fs（不创建）。 */
function resolveDxosFsDir(userDataDir) {
  return path.join(resolveDxosPaths(userDataDir).root, DXOS_FS_DIR_NAME);
}

/** 只创建目录：配置文件不存在时保持不存在，交给各域自己决定是否落盘。 */
function ensureDxosLayout(userDataDir, options = {}) {
  const paths = resolveDxosPaths(userDataDir);
  const fsImpl = options.fsImpl && typeof options.fsImpl.mkdirSync === "function" ? options.fsImpl : fs;
  fsImpl.mkdirSync(paths.root, { recursive: true });
  for (const name of DXOS_LAYOUT.directories) fsImpl.mkdirSync(paths.directory[name], { recursive: true });
  return paths;
}

module.exports = {
  DXOS_DIR_NAME,
  DXOS_FS_DIR_NAME,
  DXOS_LAYOUT,
  resolveDxosPaths,
  resolveDxosFsDir,
  ensureDxosLayout,
};
