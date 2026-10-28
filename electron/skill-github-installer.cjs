"use strict";

const crypto = require("node:crypto");
const skillPack = require("./skill-pack.cjs");
const skillImport = require("./skill-import.cjs");

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const SCRIPT_RE = /(?:^|\/)(?:package\.json|[^/]+\.(?:py|js|cjs|mjs|ts|sh|command|bat|cmd|ps1))$/i;

function failure(code, message, detail) {
  const error = new Error(String(message || code));
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function parseGithubRepository(value) {
  const raw = String(value || "").trim();
  let url;
  try { url = new URL(raw); } catch { throw failure("SKILL_INVALID_INPUT", "请输入完整的 GitHub 仓库地址"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw failure("SKILL_INVALID_INPUT", "只支持不含凭据的公开 GitHub 仓库 HTTPS 地址");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw failure("SKILL_INVALID_INPUT", "请提供仓库根地址，例如 https://github.com/owner/repo");
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === "..") {
    throw failure("SKILL_INVALID_INPUT", "GitHub 仓库所有者或仓库名不合法");
  }
  return { owner, repo, repository: owner + "/" + repo, sourceUrl: "https://github.com/" + owner + "/" + repo };
}

async function readLimited(response, maximum) {
  const declared = Number(response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") : 0);
  if (declared > maximum) throw failure("SKILL_INVALID_INPUT", "下载内容超过大小上限");
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      size += chunk.length;
      if (size > maximum) {
        try { await reader.cancel(); } catch { /* 已读取超限 */ }
        throw failure("SKILL_INVALID_INPUT", "下载内容超过大小上限");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximum) throw failure("SKILL_INVALID_INPUT", "下载内容超过大小上限");
  return bytes;
}

function createSkillGithubInstaller({ fetchImpl, importArchive, clock = () => Date.now(), idFactory = () => crypto.randomUUID() } = {}) {
  const previews = new Map();
  const fetcher = typeof fetchImpl === "function" ? fetchImpl : null;

  async function request(url, maximum) {
    if (!fetcher) throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "GitHub 网络适配器未装配");
    let current = String(url);
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const parsed = new URL(current);
      if (parsed.protocol !== "https:" || !["api.github.com", "codeload.github.com"].includes(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) {
        throw failure("SKILL_FORBIDDEN", "GitHub 下载重定向到未允许的地址");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetcher(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "application/vnd.github+json, application/zip, application/octet-stream;q=0.9, */*;q=0.1", "user-agent": "OpenArc-Skill-Installer/1" },
        });
      } catch (error) {
        throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "无法读取 GitHub 仓库，请检查网络后重试", error && error.name === "AbortError" ? "请求超时" : "网络请求失败");
      } finally {
        clearTimeout(timer);
      }
      if (!response || typeof response.status !== "number") throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "GitHub 返回了无效响应");
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.protocol !== "https:" || !["api.github.com", "codeload.github.com"].includes(finalUrl.hostname.toLowerCase()) || finalUrl.username || finalUrl.password) {
          throw failure("SKILL_FORBIDDEN", "GitHub 响应来自未允许的地址");
        }
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers && typeof response.headers.get === "function" ? response.headers.get("location") : null;
        if (!location) throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "GitHub 重定向缺少目标地址");
        current = new URL(location, current).href;
        continue;
      }
      if (response.status === 404) throw failure("SKILL_NOT_FOUND", "GitHub 仓库或指定版本不存在；当前只支持公开仓库");
      if (response.status < 200 || response.status >= 300) throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "GitHub 读取失败（HTTP " + response.status + "）");
      return readLimited(response, maximum);
    }
    throw failure("SKILL_FORBIDDEN", "GitHub 下载重定向次数过多");
  }

  async function json(url) {
    const bytes = await request(url, MAX_JSON_BYTES);
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "GitHub 返回了无法解析的仓库信息"); }
  }

  function purge(ownerUserId) {
    const now = clock();
    for (const [id, preview] of previews) if (preview.expiresAt <= now) previews.delete(id);
    if (!ownerUserId) return;
    const owned = [...previews.entries()].filter(([, preview]) => preview.ownerUserId === ownerUserId).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (owned.length > 4) previews.delete(owned.shift()[0]);
  }

  async function inspect(source, ownerUserId) {
    const owner = String(ownerUserId || "");
    if (!owner) throw failure("SKILL_UNAUTHENTICATED", "当前会话不能创建安装预览");
    const repository = parseGithubRepository(source);
    const info = await json("https://api.github.com/repos/" + repository.owner + "/" + repository.repo);
    const branch = String(info && info.default_branch || "");
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes("..")) throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "GitHub 仓库默认分支信息不完整");
    const commitInfo = await json("https://api.github.com/repos/" + repository.owner + "/" + repository.repo + "/commits/" + encodeURIComponent(branch));
    const commit = String(commitInfo && commitInfo.sha || "");
    if (!/^[a-f0-9]{40}$/i.test(commit)) throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "GitHub 没有返回可固定的 commit");
    const downloaded = await request("https://codeload.github.com/" + repository.owner + "/" + repository.repo + "/zip/" + commit, MAX_ARCHIVE_BYTES);
    const files = skillPack.readZipEntries(downloaded).filter((file) => !/(?:^|\/)(?:\.git|node_modules)(?:\/|$)/i.test(file.name));
    const archive = skillImport.buildZip(files);
    if (archive.length > MAX_ARCHIVE_BYTES) throw failure("SKILL_INVALID_INPUT", "整理后的 Skill 包超过 32 MB 上限");
    const skills = skillImport.previewSkillPackage(archive).map((skill) => ({ name: skill.name, description: skill.description, path: skill.sourcePath }));
    const scripts = files.filter((file) => SCRIPT_RE.test(file.name)).map((file) => file.name).slice(0, 50);
    const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
    const now = clock();
    const preview = {
      previewId: String(idFactory()), ownerUserId: owner, ...repository, branch, commit, sha256,
      skills, scripts, excluded: [".git", "node_modules"], bytes: archive.length,
      archive, createdAt: now, expiresAt: now + PREVIEW_TTL_MS,
    };
    purge(owner);
    previews.set(preview.previewId, preview);
    purge(owner);
    return publicPreview(preview);
  }

  async function install(previewId, ownerUserId) {
    purge();
    const id = String(previewId || "");
    const preview = previews.get(id);
    if (!preview) throw failure("SKILL_NOT_FOUND", "安装预览不存在或已过期，请重新获取");
    if (preview.ownerUserId !== String(ownerUserId || "")) throw failure("SKILL_FORBIDDEN", "安装预览不属于当前账号");
    previews.delete(id);
    const digest = crypto.createHash("sha256").update(preview.archive).digest("hex");
    if (digest !== preview.sha256) throw failure("SKILL_CONFLICT", "预览内容校验失败，请重新获取");
    if (typeof importArchive !== "function") throw failure("SKILL_DEPENDENCY_UNAVAILABLE", "Skill 包导入器未装配");
    const result = await importArchive(Buffer.from(preview.archive), preview.repo + "-" + preview.commit.slice(0, 12) + ".zip", { enabled: false });
    return { ...result, source: publicPreview(preview) };
  }

  return { inspect, install, _previews: previews };
}

function publicPreview(preview) {
  return {
    previewId: preview.previewId, repository: preview.repository, sourceUrl: preview.sourceUrl,
    branch: preview.branch, commit: preview.commit, sha256: preview.sha256,
    skills: preview.skills.map((skill) => ({ ...skill })), scripts: preview.scripts.slice(),
    excluded: preview.excluded.slice(), bytes: preview.bytes, expiresAt: preview.expiresAt,
  };
}

module.exports = { createSkillGithubInstaller, parseGithubRepository, MAX_ARCHIVE_BYTES, PREVIEW_TTL_MS };
