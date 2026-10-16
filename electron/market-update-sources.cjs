/**
 * Stage 1 · 无限画布在线更新：更新源适配器注册表。
 *
 * 目的：把「版本发现 / 资产解析 / 资产下载」从 market-update-service.cjs 里抽出来，服务只认
 * 统一接口，不再堆 if-else。两个实现都放在本文件：
 *   · github-releases  —— 现有 GitHub Releases 逻辑原样搬移（行为不变）
 *   · modelscope-repo  —— 新增 ModelScope 仓库源
 *
 * 统一接口（每个适配器实例）：
 *   describeSource()                      → 只读元数据 {kind,label,owner,repo,apiUrl,allowedHosts,configurableFields,defaultRepository,manifestPath}
 *   async listReleases({channel})         → 候选数组（语义化版本降序；无可用版本回 []，不是报错）
 *   async resolveAsset(version,{channel}) → 单个候选或 null
 *   async downloadAsset(candidate)        → {bytes, sourceSha256}
 *
 * 网络全部经注入的 net（service 构造；只允许该源自己的白名单主机，逐跳校验重定向）。
 * 本文件不 require node:http(s)，也不直接 fetch —— 纯适配器逻辑。
 *
 * ModelScope 版本发现（无 release/tag 语义，用约定清单）：
 *   · 默认走 revisions 的 Branch，拿 master（或第一个分支）作为 Revision；
 *   · 若 Data.RevisionMap.Tags 非空，则**每个 tag 也按同一清单**探测一遍（两条路都给）；
 *   · 清单固定路径 `updates/canvas/latest.json`，同一 revision 的文件清单里没有该路径 = 该 revision 无可用版本；
 *   · 清单形如 { version, build, asset:"updates/canvas/canvas-<version>.zip", sha256, notes?, publishedAt? }；
 *   · 纵深：下载资产后与文件清单里的 Sha256 交叉比对，不一致 → MARKET_UPDATE_SOURCE_DIGEST_MISMATCH。
 */
"use strict";

const domain = require("./market-update-domain.cjs");

const GITHUB_KIND = "github-releases";
const MODELSCOPE_KIND = "modelscope-repo";
const MANIFEST_PATH = domain.MODELSCOPE_MANIFEST_PATH;
const SHA256_RE = /^[a-f0-9]{64}$/;
/** 泛化：每个应用一份清单路径 updates/<appId>/latest.json；缺省仍是 canvas。 */
const manifestPathFor = (value) => domain.modelscopeManifestPath(value);

const DESCRIPTORS = Object.freeze({
  [GITHUB_KIND]: Object.freeze({
    kind: GITHUB_KIND,
    label: "GitHub Releases",
    allowedHosts: domain.GITHUB_RELEASES_HOSTS,
    configurableFields: ["owner", "repo"],
    defaultRepository: domain.DEFAULT_REPOSITORY,
    manifestPath: null,
  }),
  [MODELSCOPE_KIND]: Object.freeze({
    kind: MODELSCOPE_KIND,
    label: "ModelScope 仓库",
    allowedHosts: domain.MODELSCOPE_REPO_HOSTS,
    configurableFields: ["owner", "repo"],
    defaultRepository: domain.DEFAULT_MODELSCOPE_REPOSITORY,
    manifestPath: MANIFEST_PATH,
  }),
});

function sourceKinds() { return Object.keys(DESCRIPTORS); }
function isSourceKind(kind) { return typeof kind === "string" && Object.prototype.hasOwnProperty.call(DESCRIPTORS, kind); }
function getSourceDescriptor(kind) { return isSourceKind(kind) ? DESCRIPTORS[kind] : null; }
function defaultRepositoryFor(kind) {
  const descriptor = getSourceDescriptor(kind);
  // GitHub 兜底实际不可达：service 只在 isSourceKind 校验通过后才调用本函数（market-update-service.cjs 的 initialSelection），
  // 保留仅为防御性返回非空仓库；行为不变。
  return descriptor ? { ...descriptor.defaultRepository } : { ...domain.DEFAULT_REPOSITORY };
}

// ── ModelScope URL / 响应解析（纯函数，便于离线测试） ───────────────────────
const encodeSegment = (value) => encodeURIComponent(String(value));
const encodePath = (value) => String(value).split("/").map(encodeURIComponent).join("/");
const firstString = (...values) => {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
};

function modelscopeRevisionsUrl(owner, repo) {
  return "https://modelscope.cn/api/v1/models/" + encodeSegment(owner) + "/" + encodeSegment(repo) + "/revisions";
}
function modelscopeFilesUrl(owner, repo, revision) {
  return "https://modelscope.cn/api/v1/models/" + encodeSegment(owner) + "/" + encodeSegment(repo)
    + "/repo/files?Revision=" + encodeSegment(revision) + "&Recursive=true";
}
function modelscopeDownloadUrl(owner, repo, revision, filePath) {
  return "https://modelscope.cn/api/v1/models/" + encodeSegment(owner) + "/" + encodeSegment(repo)
    + "/repo?Revision=" + encodeSegment(revision) + "&FilePath=" + encodePath(filePath);
}

/** Data.RevisionMap → { branch, tags:[{name,revision}] }；结构不符回 null。 */
function parseRevisionMap(payload) {
  const data = payload && typeof payload === "object" ? payload.Data : null;
  const map = data && typeof data === "object" ? data.RevisionMap : null;
  if (!map || typeof map !== "object") return null;
  const branches = Array.isArray(map.Branches) ? map.Branches : [];
  const tags = Array.isArray(map.Tags) ? map.Tags : [];
  const branchEntry = branches.find((entry) => entry && typeof entry === "object") || null;
  const branch = branchEntry
    ? firstString(branchEntry.Revision, branchEntry.Name, branchEntry.Branch, branchEntry.RevisionId, branchEntry.Sha)
    : "";
  const tagList = [];
  for (const entry of tags) {
    if (!entry || typeof entry !== "object") continue;
    const name = firstString(entry.Tag, entry.TagName, entry.Name, entry.Revision, entry.Branch);
    const revision = firstString(entry.Revision, entry.CommitId, entry.RevisionId, entry.Sha, name);
    if (name && revision) tagList.push({ name, revision });
  }
  return { branch, tags: tagList };
}

/** Data.Files → [{path,size,sha256,revision,isLfs}]；结构不符回 null。 */
function parseFileList(payload) {
  const data = payload && typeof payload === "object" ? payload.Data : null;
  const files = data && Array.isArray(data.Files) ? data.Files : null;
  if (!files) return null;
  const out = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const filePath = firstString(file.Path, file.Name);
    if (!filePath) continue;
    const rawSha = typeof file.Sha256 === "string" ? file.Sha256.trim().toLowerCase() : "";
    out.push({
      path: filePath,
      size: Number.isFinite(Number(file.Size)) ? Number(file.Size) : 0,
      sha256: SHA256_RE.test(rawSha) ? rawSha : null,
      revision: firstString(file.Revision, file.CommitId),
      isLfs: file.IsLFS === true,
    });
  }
  return out;
}

/** ModelScope 清单严格校验；失败返回 {ok:false,error}（带 MARKET_UPDATE_* code）。 */
function normalizeModelscopeManifest(raw, options = {}) {
  const appId = domain.normalizeAppId(options && options.appId) || domain.CANVAS_APP_ID;
  const fail = (detail) => ({ ok: false, error: domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, detail) });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("ModelScope 清单必须是 JSON 对象");
  const parsed = domain.parseSemver(raw.version);
  if (!parsed) return fail("ModelScope 清单 version 不是合法语义化版本");
  const build = Number(raw.build);
  if (!Number.isSafeInteger(build) || build < 1) return fail("ModelScope 清单 build 必须是不小于 1 的整数");
  const asset = typeof raw.asset === "string" ? raw.asset.trim() : "";
  if (!asset || !domain.isSafeEntryName(asset)) return fail("ModelScope 清单 asset 必须是安全的相对路径");
  const assetName = asset.slice(asset.lastIndexOf("/") + 1);
  const parsedAsset = domain.parseAppAsset(assetName, appId);
  if (!parsedAsset || parsedAsset.version !== parsed.version) return fail("ModelScope 清单 asset 必须名为 " + appId + "-<version>.zip 且与 version 一致");
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256.trim().toLowerCase() : "";
  if (!SHA256_RE.test(sha256)) return fail("ModelScope 清单 sha256 必须是 64 位小写十六进制");
  const notes = typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null;
  let publishedAt = 0;
  if (Number.isFinite(Number(raw.publishedAt))) publishedAt = Number(raw.publishedAt);
  else if (typeof raw.publishedAt === "string") { const time = Date.parse(raw.publishedAt); if (Number.isFinite(time)) publishedAt = time; }
  return { ok: true, value: { appId, version: parsed.version, semver: parsed, build, asset, sha256, notes, publishedAt } };
}

function channelAllows(semver, channel) { return channel === "stable" ? semver.prerelease.length === 0 : true; }

const sourceDigestMismatch = (message) => domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_SOURCE_DIGEST_MISMATCH, message);

// ── 实现 1：GitHub Releases（现有逻辑原样搬移） ─────────────────────────────
function createGithubReleasesSource({ owner, repo, net, appId = domain.CANVAS_APP_ID }) {
  const repository = { owner, repo };
  const apiUrl = () => domain.releasesApiUrl(repository);

  async function listReleases({ channel = domain.DEFAULT_CHANNEL } = {}) {
    const { status, json, parseError } = await net.getJson(apiUrl(), "application/vnd.github+json");
    if (status === 404) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_FOUND, "GitHub 仓库不存在或不可访问");
    if (status < 200 || status >= 300) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "GitHub API 返回 HTTP " + status);
    if (parseError) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "GitHub API 返回不是合法 JSON");
    if (!Array.isArray(json)) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "GitHub API 返回不是 Release 数组");
    return domain.collectAppReleases(json, appId, channel);
  }

  async function resolveAsset(version, { channel = domain.DEFAULT_CHANNEL } = {}) {
    const parsed = domain.parseSemver(version);
    if (!parsed) return null;
    return (await listReleases({ channel })).find((item) => item.version === parsed.version) || null;
  }

  async function downloadAsset(candidate) {
    const bytes = await net.download(candidate.url);
    return { bytes, sourceSha256: candidate.assetSha256 || null };
  }

  function describeSource() {
    return {
      kind: GITHUB_KIND,
      label: DESCRIPTORS[GITHUB_KIND].label,
      appId,
      owner,
      repo,
      apiUrl: apiUrl(),
      allowedHosts: domain.GITHUB_RELEASES_HOSTS.slice(),
      configurableFields: ["owner", "repo"],
      defaultRepository: { ...domain.DEFAULT_REPOSITORY },
      manifestPath: null,
    };
  }

  return { kind: GITHUB_KIND, listReleases, resolveAsset, downloadAsset, describeSource };
}

// ── 实现 2：ModelScope 仓库 ─────────────────────────────────────────────────
function createModelscopeRepoSource({ owner, repo, net, appId = domain.CANVAS_APP_ID }) {
  const manifestPath = manifestPathFor(appId);
  const requireJson = async (url, what, notFoundMessage) => {
    const { status, json, parseError } = await net.getJson(url, "application/json");
    if (status === 404) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_FOUND, notFoundMessage);
    if (status < 200 || status >= 300) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, what + " 返回 HTTP " + status);
    if (parseError) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, what + " 返回不是合法 JSON");
    return json;
  };

  async function revisionTargets() {
    const map = parseRevisionMap(await requireJson(modelscopeRevisionsUrl(owner, repo), "ModelScope revisions API", "ModelScope 仓库不存在或不可访问"));
    if (!map) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "ModelScope revisions 响应缺少 RevisionMap");
    const targets = [];
    if (map.branch) targets.push({ label: null, revision: map.branch });
    for (const tag of map.tags) targets.push({ label: tag.name, revision: tag.revision });
    if (!targets.length) targets.push({ label: null, revision: "master" });
    return targets;
  }

  async function listReleases({ channel = domain.DEFAULT_CHANNEL } = {}) {
    const targets = await revisionTargets();
    const out = [];
    for (const target of targets) {
      const files = parseFileList(await requireJson(modelscopeFilesUrl(owner, repo, target.revision), "ModelScope files API", "ModelScope 仓库不存在或不可访问"));
      if (!files) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "ModelScope files 响应缺少 Data.Files");
      const manifestEntry = files.find((file) => file.path === manifestPath);
      if (!manifestEntry) continue; // 仓库里还没有清单 → 该 revision 视为无可用版本
      const manifestBytes = await net.download(modelscopeDownloadUrl(owner, repo, target.revision, manifestPath));
      if (manifestEntry.sha256 && manifestEntry.sha256 !== domain.sha256Hex(manifestBytes)) {
        throw sourceDigestMismatch("ModelScope 清单文件 sha256 与文件清单不一致：" + manifestPath);
      }
      let raw;
      try { raw = JSON.parse(manifestBytes.toString("utf8")); } catch { throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "ModelScope 清单不是合法 JSON：" + manifestPath); }
      const normalized = normalizeModelscopeManifest(raw, { appId });
      if (!normalized.ok) throw normalized.error;
      const manifest = normalized.value;
      if (!channelAllows(manifest.semver, channel)) continue;
      const assetEntry = files.find((file) => file.path === manifest.asset);
      if (!assetEntry) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_FOUND, "ModelScope 清单引用的资产不在文件清单：" + manifest.asset);
      if (assetEntry.sha256 && assetEntry.sha256 !== manifest.sha256) {
        throw sourceDigestMismatch("ModelScope 清单 sha256 与文件清单不一致：" + manifest.asset);
      }
      out.push({
        appId,
        version: manifest.version,
        semver: manifest.semver,
        assetName: manifest.asset.slice(manifest.asset.lastIndexOf("/") + 1),
        assetPath: manifest.asset,
        url: modelscopeDownloadUrl(owner, repo, target.revision, manifest.asset),
        size: assetEntry.size,
        sourceSha256: assetEntry.sha256 || manifest.sha256,
        enforceSourceDigest: true,
        tag: target.label || "",
        revision: target.revision,
        notesUrl: manifest.notes && /^https:\/\//i.test(manifest.notes) ? manifest.notes : null,
        notes: manifest.notes,
        publishedAt: manifest.publishedAt,
        prerelease: manifest.semver.prerelease.length > 0,
      });
    }
    const deduped = [];
    const seen = new Set();
    for (const candidate of out) { if (seen.has(candidate.version)) continue; seen.add(candidate.version); deduped.push(candidate); }
    deduped.sort((a, b) => domain.compareParsed(b.semver, a.semver));
    return deduped;
  }

  async function resolveAsset(version, { channel = domain.DEFAULT_CHANNEL } = {}) {
    const parsed = domain.parseSemver(version);
    if (!parsed) return null;
    return (await listReleases({ channel })).find((item) => item.version === parsed.version) || null;
  }

  async function downloadAsset(candidate) {
    const bytes = await net.download(candidate.url);
    if (candidate.enforceSourceDigest && candidate.sourceSha256 && domain.sha256Hex(bytes) !== candidate.sourceSha256) {
      throw sourceDigestMismatch("下载资产 sha256 与 ModelScope 文件清单不一致：" + (candidate.assetPath || candidate.assetName));
    }
    return { bytes, sourceSha256: candidate.sourceSha256 || null };
  }

  function describeSource() {
    return {
      kind: MODELSCOPE_KIND,
      label: DESCRIPTORS[MODELSCOPE_KIND].label,
      appId,
      owner,
      repo,
      apiUrl: modelscopeRevisionsUrl(owner, repo),
      allowedHosts: domain.MODELSCOPE_REPO_HOSTS.slice(),
      configurableFields: ["owner", "repo"],
      defaultRepository: { ...domain.DEFAULT_MODELSCOPE_REPOSITORY },
      manifestPath,
    };
  }

  return { kind: MODELSCOPE_KIND, listReleases, resolveAsset, downloadAsset, describeSource };
}

function createSource(kind, options = {}) {
  const descriptor = getSourceDescriptor(kind);
  if (!descriptor) return null;
  const owner = typeof options.owner === "string" ? options.owner.trim() : "";
  const repo = typeof options.repo === "string" ? options.repo.trim() : "";
  if (!owner || !repo || !options.net) return null;
  const appId = domain.normalizeAppId(options.appId) || domain.CANVAS_APP_ID;
  if (kind === GITHUB_KIND) return createGithubReleasesSource({ owner, repo, net: options.net, appId });
  if (kind === MODELSCOPE_KIND) return createModelscopeRepoSource({ owner, repo, net: options.net, appId });
  return null;
}

module.exports = {
  GITHUB_KIND, MODELSCOPE_KIND, MANIFEST_PATH, manifestPathFor,
  sourceKinds, isSourceKind, getSourceDescriptor, defaultRepositoryFor, createSource,
  modelscopeRevisionsUrl, modelscopeFilesUrl, modelscopeDownloadUrl,
  parseRevisionMap, parseFileList, normalizeModelscopeManifest,
};
