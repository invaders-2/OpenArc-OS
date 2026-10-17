"use strict";
/**
 * task-22 · 系统更新检查（只检查 / 下载，绝不静默安装）。
 *
 * 命令（desktop:command，白名单在 local-proxy-domain.cjs）：
 *   desktop/update/check        读当前版本 + 配置的更新源 → 是否有新版与下载信息
 *   desktop/update/download     把选中的安装包下载到 <userData>/dxos/updates/downloads（不执行）
 *   desktop/update/source/get   读更新源配置
 *   desktop/update/source/set   改更新源配置（github-releases / modelscope-repo）
 *
 * 更新源（默认 GitHub Releases，可切 ModelScope 仓库）：
 *   · github-releases：GitHub Releases API；tag 必须是合法 semver（忽略 v 前缀），stable 通道排除预发布；
 *     资产只接受白名单主机（api.github.com / github.com / objects.githubusercontent.com 等）。
 *   · modelscope-repo：仓库内 updates/system/latest.json，形如
 *       { version, notes?, publishedAt?, assets:[{ name, path, url?, size?, sha256? }] }
 *     相对 path 通过 ModelScope 下载 URL 取；绝对 url 必须 HTTPS + 白名单。
 *
 * 安全边界：只允许 HTTPS + 既有白名单主机，逐跳校验重定向，下载体积 ≤64MB；
 * 下载文件只写相对目录、文件名白名单；不执行、不替换当前 App、不写启动项。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const domain = require("./market-update-domain.cjs");
const sourceAdapters = require("./market-update-sources.cjs");
const localProxyDomain = require("./local-proxy-domain.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

const CHECK_COMMAND = "desktop/update/check";
const DOWNLOAD_COMMAND = "desktop/update/download";
const SOURCE_GET_COMMAND = "desktop/update/source/get";
const SOURCE_SET_COMMAND = "desktop/update/source/set";
const UPDATE_COMMANDS = Object.freeze([CHECK_COMMAND, DOWNLOAD_COMMAND, SOURCE_GET_COMMAND, SOURCE_SET_COMMAND]);
const SOURCE_FILE_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const SOURCE_KINDS = Object.freeze(["github-releases", "modelscope-repo"]);
const CHANNELS = Object.freeze(["stable", "beta"]);
const SAFE_ASSET_NAME_RE = /^[A-Za-z0-9._-]{1,160}$/;

const asStr = (value, max = 300) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));

function sha256Hex(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

function createDesktopUpdateService(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : "";
  if (!userDataDir) throw new Error("createDesktopUpdateService 需要 userDataDir");
  const paths = resolveDxosPaths(userDataDir);
  const settingsDir = path.join(paths.root, "settings");
  const sourceFile = path.join(settingsDir, "update-source.json");
  const downloadsDir = path.join(paths.root, "updates", "downloads");
  const currentVersionParsed = domain.parseSemver(options.currentVersion);
  const currentVersion = currentVersionParsed ? currentVersionParsed.version : "0.0.0";
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : (typeof fetch === "function" ? fetch : null);
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const maxDownloadBytes = Number.isFinite(Number(options.maxDownloadBytes)) && Number(options.maxDownloadBytes) > 0
    ? Math.min(Number(options.maxDownloadBytes), MAX_DOWNLOAD_BYTES)
    : MAX_DOWNLOAD_BYTES;
  const defaultSource = Object.freeze({ kind: "github-releases", owner: domain.DEFAULT_REPOSITORY.owner, repo: domain.DEFAULT_REPOSITORY.repo, channel: "stable" });

  function normalizeSource(value) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const kind = SOURCE_KINDS.includes(raw.kind) ? raw.kind : defaultSource.kind;
    const owner = typeof raw.owner === "string" ? raw.owner.trim() : defaultSource.owner;
    const repo = typeof raw.repo === "string" ? raw.repo.trim() : defaultSource.repo;
    const normalizedRepo = domain.normalizeRepository({ owner, repo });
    if (!normalizedRepo) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "owner/repo 只允许 [A-Za-z0-9._-]");
    const channel = CHANNELS.includes(raw.channel) ? raw.channel : "stable";
    return { kind, owner: normalizedRepo.owner, repo: normalizedRepo.repo, channel };
  }

  function readSource() {
    try {
      const raw = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
      if (!raw || typeof raw !== "object" || raw.version !== SOURCE_FILE_VERSION) return { ...defaultSource, source: "default", error: null };
      return { ...normalizeSource(raw), source: "file", error: null };
    } catch (error) {
      if (error && error.code === "ENOENT") return { ...defaultSource, source: "default", error: null };
      return { ...defaultSource, source: "default", error: "更新源配置不可读，已回退默认源" };
    }
  }

  function writeSource(value) {
    const raw = value && typeof value === "object" ? value : {};
    if (raw.kind != null && !SOURCE_KINDS.includes(raw.kind)) {
      throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "更新源 kind 只支持 " + SOURCE_KINDS.join(" / "));
    }
    if (raw.channel != null && !CHANNELS.includes(raw.channel)) {
      throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "更新通道只支持 " + CHANNELS.join(" / "));
    }
    const source = normalizeSource(value);
    fs.mkdirSync(settingsDir, { recursive: true });
    const tmp = sourceFile + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(tmp, JSON.stringify({ version: SOURCE_FILE_VERSION, ...source, updatedAt: Number(clock()) }, null, 2), "utf8");
    fs.renameSync(tmp, sourceFile);
    return { ...source, source: "file", updatedAt: Number(clock()) };
  }

  function assertAllowed(url) {
    try { return domain.assertAllowedUrl(url, domain.ALLOWED_HOSTS); }
    catch (error) {
      throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "更新源 URL 不在白名单：" + asStr(error && error.message, 200));
    }
  }

  async function fetchLimited(url, accept, maxBytes) {
    if (!fetchImpl) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_DEPENDENCY_UNAVAILABLE, "没有可用的 fetch 实现");
    let current = assertAllowed(url).toString();
    for (let hop = 0; hop < 6; hop += 1) {
      let response;
      try { response = await fetchImpl(current, { redirect: "manual", headers: { accept, "user-agent": "OpenArc-OS-system-updater" } }); }
      catch (error) { throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "网络请求失败：" + asStr(error && error.message, 200)); }
      if (!response || typeof response.status !== "number") throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "网络响应无效");
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers && typeof response.headers.get === "function" ? response.headers.get("location") : null;
        if (!location) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "重定向缺少 Location");
        current = assertAllowed(new URL(location, current).toString()).toString();
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "更新源返回 HTTP " + response.status);
      let buffer;
      try { buffer = Buffer.from(await response.arrayBuffer()); } catch { throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "响应读取失败"); }
      if (buffer.length > maxBytes) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "响应超过体积上限 " + maxBytes + " 字节");
      return buffer;
    }
    throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "重定向次数过多");
  }

  function safeAssetName(value) {
    const name = asStr(value, 160).trim();
    return SAFE_ASSET_NAME_RE.test(name) ? name : null;
  }

  function mapGithubAssets(release) {
    const assets = [];
    for (const asset of Array.isArray(release && release.assets) ? release.assets : []) {
      if (!asset || typeof asset !== "object") continue;
      const name = safeAssetName(asset.name);
      if (!name || typeof asset.browser_download_url !== "string") continue;
      let url;
      try { url = assertAllowed(asset.browser_download_url).toString(); } catch { continue; }
      assets.push({ name, size: Number.isFinite(Number(asset.size)) ? Number(asset.size) : null, downloadUrl: url });
    }
    return assets;
  }

  async function checkGithub(source) {
    const bytes = await fetchLimited(domain.releasesApiUrl({ owner: source.owner, repo: source.repo }), "application/vnd.github+json", MAX_MANIFEST_BYTES);
    let releases;
    try { releases = JSON.parse(bytes.toString("utf8")); } catch { throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "更新源返回不是合法 JSON"); }
    if (!Array.isArray(releases)) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "更新源返回不是 Release 数组");
    let best = null;
    for (const release of releases) {
      if (!release || typeof release !== "object" || release.draft === true) continue;
      const tag = asStr(release.tag_name || release.name, 120).replace(/^v/i, "");
      const parsed = domain.parseSemver(tag);
      if (!parsed) continue;
      if (source.channel === "stable" && parsed.prerelease.length) continue;
      if (!best || domain.compareParsed(parsed, best.semver) > 0) {
        best = {
          version: parsed.version, semver: parsed, tag: asStr(release.tag_name, 120) || tag,
          name: asStr(release.name, 200) || null,
          notesUrl: typeof release.html_url === "string" && /^https:\/\//i.test(release.html_url) ? release.html_url : null,
          publishedAt: Number.isFinite(Number(release.published_at ? Date.parse(release.published_at) : NaN)) ? Number(Date.parse(release.published_at)) : 0,
          assets: mapGithubAssets(release),
        };
      }
    }
    return best;
  }

  async function checkModelscope(source) {
    const filesBytes = await fetchLimited(sourceAdapters.modelscopeFilesUrl(source.owner, source.repo, "master"), "application/json", MAX_MANIFEST_BYTES);
    let filesJson;
    try { filesJson = JSON.parse(filesBytes.toString("utf8")); } catch { throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "ModelScope 文件列表不是合法 JSON"); }
    const files = filesJson && filesJson.Data && Array.isArray(filesJson.Data.Files) ? filesJson.Data.Files : null;
    if (!files) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "ModelScope 文件列表缺少 Data.Files");
    const manifestPath = "updates/system/latest.json";
    const entry = files.find((file) => file && typeof file.Path === "string" && file.Path === manifestPath);
    if (!entry) return null;
    const manifestBytes = await fetchLimited(sourceAdapters.modelscopeDownloadUrl(source.owner, source.repo, "master", manifestPath), "application/json", MAX_MANIFEST_BYTES);
    if (typeof entry.Sha256 === "string" && /^[a-f0-9]{64}$/i.test(entry.Sha256) && sha256Hex(manifestBytes) !== entry.Sha256.toLowerCase()) {
      throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "系统更新清单 sha256 与文件列表不一致");
    }
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "系统更新清单不是合法 JSON"); }
    const parsed = domain.parseSemver(manifest && manifest.version);
    if (!parsed) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "系统更新清单 version 不是合法语义化版本");
    if (source.channel === "stable" && parsed.prerelease.length) return null;
    const assets = [];
    for (const asset of Array.isArray(manifest.assets) ? manifest.assets : []) {
      if (!asset || typeof asset !== "object") continue;
      const name = safeAssetName(asset.name);
      if (!name) continue;
      let url;
      if (typeof asset.url === "string" && asset.url.trim()) {
        try { url = assertAllowed(new URL(asset.url.trim(), "https://modelscope.cn/").toString()).toString(); } catch { continue; }
      } else if (typeof asset.path === "string" && domain.isSafeEntryName(asset.path)) {
        url = sourceAdapters.modelscopeDownloadUrl(source.owner, source.repo, "master", asset.path);
      } else continue;
      const sha256 = typeof asset.sha256 === "string" && /^[a-f0-9]{64}$/i.test(asset.sha256) ? asset.sha256.toLowerCase() : null;
      assets.push({ name, size: Number.isFinite(Number(asset.size)) ? Number(asset.size) : null, downloadUrl: url, sha256 });
    }
    return {
      version: parsed.version, semver: parsed, tag: asStr(manifest.tag, 120) || ("v" + parsed.version),
      name: asStr(manifest.name, 200) || null,
      notesUrl: typeof manifest.notes === "string" && /^https:\/\//i.test(manifest.notes) ? manifest.notes : null,
      publishedAt: Number.isFinite(Number(manifest.publishedAt)) ? Number(manifest.publishedAt) : 0,
      assets,
    };
  }

  async function check() {
    const source = readSource();
    const latest = source.kind === "modelscope-repo" ? await checkModelscope(source) : await checkGithub(source);
    const updateAvailable = !!latest && domain.compareSemver(latest.version, currentVersion) > 0;
    return {
      command: CHECK_COMMAND,
      currentVersion,
      source: { kind: source.kind, owner: source.owner, repo: source.repo, channel: source.channel, origin: source.source },
      checkedAt: Number(clock()),
      latest: latest ? {
        version: latest.version, tag: latest.tag, name: latest.name, notesUrl: latest.notesUrl,
        publishedAt: latest.publishedAt, assets: latest.assets,
      } : null,
      updateAvailable,
      downloadAvailable: !!(latest && latest.assets && latest.assets.length),
      installSupported: false,
      note: "只检查 / 下载，不静默安装",
    };
  }

  async function download(payload = {}) {
    const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const checkResult = await check();
    if (!checkResult.latest) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "没有可下载的新版本信息");
    const assets = checkResult.latest.assets || [];
    const wanted = input.assetName != null ? safeAssetName(input.assetName) : (assets[0] && assets[0].name) || null;
    if (!wanted) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "资产名不合法");
    const asset = assets.find((item) => item.name === wanted);
    if (!asset) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INVALID_INPUT, "更新源里没有该资产：" + wanted);
    const bytes = await fetchLimited(asset.downloadUrl, "application/octet-stream", maxDownloadBytes);
    const digest = sha256Hex(bytes);
    if (asset.sha256 && digest !== asset.sha256) throw localProxyDomain.createLocalProxyError(localProxyDomain.LOCAL_PROXY_ERR_INTERNAL, "下载资产 sha256 与清单不一致");
    fs.mkdirSync(downloadsDir, { recursive: true });
    const file = path.join(downloadsDir, wanted);
    const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
    return {
      command: DOWNLOAD_COMMAND,
      version: checkResult.latest.version,
      assetName: wanted,
      bytes: bytes.length,
      sha256: digest,
      relativePath: path.posix.join("updates", "downloads", wanted),
      downloadedAt: Number(clock()),
      installed: false,
      note: "已下载，未安装；安装必须由用户显式操作",
    };
  }

  async function execute(command, payload) {
    try {
      if (!UPDATE_COMMANDS.includes(command)) throw localProxyDomain.localProxyCommandNotAllowed(command);
      switch (command) {
        case CHECK_COMMAND: return { ok: true, value: localProxyDomain.redactLocalProxyValue(await check()) };
        case DOWNLOAD_COMMAND: return { ok: true, value: localProxyDomain.redactLocalProxyValue(await download(payload)) };
        case SOURCE_GET_COMMAND: return { ok: true, value: localProxyDomain.redactLocalProxyValue(readSource()) };
        case SOURCE_SET_COMMAND: return { ok: true, value: localProxyDomain.redactLocalProxyValue(writeSource(payload)) };
        default: throw localProxyDomain.localProxyCommandNotAllowed(command);
      }
    } catch (error) {
      return localProxyDomain.normalizeLocalProxyError(error);
    }
  }

  return { execute, check, download, readSource, writeSource, currentVersion, commands: UPDATE_COMMANDS.slice() };
}

module.exports = { createDesktopUpdateService, UPDATE_COMMANDS, CHECK_COMMAND, DOWNLOAD_COMMAND, SOURCE_GET_COMMAND, SOURCE_SET_COMMAND };
