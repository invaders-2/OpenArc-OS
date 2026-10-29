"use strict";
/**
 * 随包的 ffmpeg / ffprobe。
 *
 * scripts/sync-app.mjs 打包时把 ffmpeg-static / @ffprobe-installer 的二进制复制到
 * <app>/resources/bin/。用户不用自己装 ffmpeg，剪辑导出、按区间裁剪、素材探测都能用。
 * 开发环境（仓库里）没有这个目录，就退回到原来的查找顺序（环境变量 → 常见安装位置 → PATH）。
 */
const fs = require("node:fs");
const path = require("node:path");

function bundledBinDir() {
  const fromEnv = String(process.env.OPENARC_BUNDLED_BIN_DIR || "").trim();
  return fromEnv || path.join(__dirname, "..", "resources", "bin");
}

/** 随包二进制的绝对路径；没有或不可执行时返回 null */
function bundledBinary(name) {
  if (name !== "ffmpeg" && name !== "ffprobe") return null;
  const file = path.join(bundledBinDir(), name + (process.platform === "win32" ? ".exe" : ""));
  try {
    if (!fs.statSync(file).isFile()) return null;
    if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

module.exports = { bundledBinary, bundledBinDir };
