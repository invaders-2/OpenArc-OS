/**
 * 应用在线更新（泛化版）：装配 + 落盘 / 下载 / 解压 / 原子切换 / 审计。
 *
 * 唯一命令入口 execute(command, payload, context)，只认 market-update-domain.cjs 的冻结命令：
 *   market/update/status | check | install | rollback | sources | source/set
 * status / check / install / rollback 接受任意**已注册** appId（缺省 = canvas，历史兼容）；
 * 每个应用的清单路径、资产名、安装目录、内置版本都按 appId 解析。
 *
 * 版本发现 / 资产解析 / 资产下载全部委托给 market-update-sources.cjs 的源适配器
 * （github-releases 行为不变；modelscope-repo 为默认）。更新源是整机级选择，
 * 持久化在 <userData>/dxos/updates/source.json（旧位置 apps/canvas/source.json 只读兼容）。
 *
 * 信任链（缺一段都不安装；泛化不放松任何一段）：
 *   ① 源主机白名单：每个源只允许 HTTPS + 自己那组主机（GitHub Releases / ModelScope）；
 *      重定向逐跳校验，越界即 MARKET_UPDATE_HOST_NOT_ALLOWED；
 *   ② 内置公钥（resources/app-update-keys.json 的 <appId> 字段）验 manifest.sig
 *      （Ed25519，对 manifest.json 原始字节）；manifest.id 必须等于 appId，不借别的应用的公钥；
 *   ③ 逐个比对 manifest.files 的 sha256；
 *   ④ 解压围栏：只写 manifest.files 里经过 isSafeEntryName 的白名单文件，目录穿越条目直接拒绝；
 *   ⑤ 原子切换：先解压到 <appId> 目录下的 staging，再 rename；current.json 用 tmp + rename 原子替换；
 *      激活前把落盘后的整包重新验签 + 重新比对摘要（防落地后被改）；
 *   ⑥ 审计：每次 install / rollback（成功 ALLOW，失败 DENY）写 authStore.auditAuthorization，
 *      action = "<appId>.update.install|rollback"。
 *
 * 诚实边界：只有"渲染层已接入加载路径"的应用可安装（本期只有 canvas，见 domain.APP_PACKAGE_LOADERS）；
 * 其余应用有发布包时 check 仍如实报 updateAvailable，但 install 结构化回 MARKET_UPDATE_NOT_LOADABLE。
 *
 * 安装目录：<userData>/dxos/apps/<appId>/<version>/；指针 <...>/current.json；
 * 历史 <...>/history.json（回滚依据）；最近一次检查结果 <...>/check.json。
 * 私钥永不进本进程：本文件只读公钥。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const domain = require("./market-update-domain.cjs");
const sourceAdapters = require("./market-update-sources.cjs");
const zip = require("./canvas-dxos-zip.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

const asStr = (value, max = 300) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));

const ZIP_LIMITS = Object.freeze({
  maxEntries: 2000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: domain.MAX_PACKAGE_BYTES,
});

function sha256Hex(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

function createMarketUpdateBundle(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : "";
  if (!userDataDir) throw new Error("createMarketUpdateBundle 需要 userDataDir");
  const appDir = options.appDir ? String(options.appDir) : path.join(__dirname, "..");
  const resourceDir = options.resourceDir ? String(options.resourceDir) : path.join(appDir, "resources");
  const keysFile = options.keysFile ? String(options.keysFile) : path.join(resourceDir, "app-update-keys.json");
  const defaultSourceKind = sourceAdapters.isSourceKind(options.sourceKind) ? options.sourceKind : domain.DEFAULT_SOURCE_KIND;
  const providedRepository = options.repository == null ? null : domain.normalizeRepository(options.repository);
  const initialRepository = providedRepository || sourceAdapters.defaultRepositoryFor(defaultSourceKind);
  const channel = options.channel === "beta" || options.channel === "dev" ? options.channel : domain.DEFAULT_CHANNEL;
  // 每个应用的随包内置版本来自 domain.APP_BUILTIN_VERSIONS；options.builtinVersion 只覆盖 canvas（历史开关，测试用）。
  const builtinVersions = { ...domain.APP_BUILTIN_VERSIONS };
  const builtinVersionRaw = domain.parseSemver(options.builtinVersion);
  const builtinVersion = builtinVersionRaw ? builtinVersionRaw.version : domain.APP_BUILTIN_VERSIONS[domain.CANVAS_APP_ID];
  if (builtinVersionRaw) builtinVersions[domain.CANVAS_APP_ID] = builtinVersion;
  const builtinVersionFor = (appId) => builtinVersions[appId] || domain.DEFAULT_BUILTIN_VERSION;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const logger = typeof options.logger === "function" ? options.logger : null;
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : (typeof fetch === "function" ? fetch : null);
  const authorization = options.authorization && typeof options.authorization === "object" ? options.authorization : null;
  const maxPackageBytes = Number.isFinite(Number(options.maxPackageBytes)) && Number(options.maxPackageBytes) > 0
    ? Number(options.maxPackageBytes)
    : domain.MAX_PACKAGE_BYTES;
  // 加载路径注册表：默认 = domain.APP_PACKAGE_LOADERS（本期只有 canvas）。主进程注入用；
  // 生产路径（main.cjs）不传，所以"只有画布能真正生效"的边界不因这个测试接缝而放宽。
  const packageLoaders = options.packageLoaders && typeof options.packageLoaders === "object" && !Array.isArray(options.packageLoaders)
    ? { ...options.packageLoaders }
    : { ...domain.APP_PACKAGE_LOADERS };
  const loadSupportFor = (appId) => {
    const loader = packageLoaders[appId] || null;
    return loader ? { loadable: true, loader, reason: null } : domain.appLoadSupport(appId);
  };
  // 每个应用一个状态目录：<userData>/dxos/apps/<appId>/（指针 / 历史 / 最近检查）。
  const dxosRoot = resolveDxosPaths(userDataDir).root;
  const appsRoot = path.join(dxosRoot, "apps");
  // 更新源是整机级选择（不属于某个应用），落在 <userData>/dxos/updates/source.json；
  // 旧版本写在 apps/canvas/ 下，这里保留只读兼容回退（不迁移、不改写旧文件）。
  const sourceFile = path.join(dxosRoot, "updates", "source.json");
  const legacySourceFile = path.join(appsRoot, domain.CANVAS_APP_ID, "source.json");
  const stateDir = path.join(appsRoot, domain.CANVAS_APP_ID); // 兼容字段：canvas 状态目录
  const appStateDir = (appId) => path.join(appsRoot, appId);
  const currentFileFor = (appId) => path.join(appStateDir(appId), "current.json");
  const historyFileFor = (appId) => path.join(appStateDir(appId), "history.json");
  const checkFileFor = (appId) => path.join(appStateDir(appId), "check.json");

  // ── 落盘工具 ──────────────────────────────────────────────────────────────
  function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

  function writeJsonAtomic(file, value) {
    ensureDir(path.dirname(file));
    const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  function readCurrent(appId) {
    const raw = readJson(currentFileFor(appId));
    if (!raw || typeof raw.version !== "string" || !domain.parseSemver(raw.version)) return null;
    return {
      version: raw.version,
      digest: typeof raw.digest === "string" ? raw.digest : null,
      kind: raw.kind === domain.MANIFEST_KIND_STATIC_WEB ? domain.MANIFEST_KIND_STATIC_WEB : domain.MANIFEST_KIND_JS,
      entry: typeof raw.entry === "string" ? raw.entry : null,
      installedAt: Number.isFinite(Number(raw.installedAt)) ? Number(raw.installedAt) : 0,
    };
  }

  function readHistory(appId) {
    const raw = readJson(historyFileFor(appId));
    const versions = raw && Array.isArray(raw.versions)
      ? raw.versions.filter((value) => typeof value === "string" && domain.parseSemver(value))
      : [];
    return { versions: [...new Set(versions)] };
  }

  function readCheckState(appId) {
    const raw = readJson(checkFileFor(appId));
    if (!raw || typeof raw !== "object") return { checkedAt: null, latest: null };
    const latest = raw.latest && typeof raw.latest.version === "string" && domain.parseSemver(raw.latest.version)
      ? {
        version: raw.latest.version,
        notesUrl: typeof raw.latest.notesUrl === "string" ? raw.latest.notesUrl : null,
        publishedAt: Number.isFinite(Number(raw.latest.publishedAt)) ? Number(raw.latest.publishedAt) : 0,
      }
      : null;
    return { checkedAt: Number.isFinite(Number(raw.checkedAt)) ? Number(raw.checkedAt) : null, latest };
  }

  // ── 更新源选择（持久化；已保存选择优先，默认源 ModelScope） ────────────────
  /** 只接受注册表内的 kind 与安全 owner/repo；非法输入返回 null。 */
  function normalizeSourceSelection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (!sourceAdapters.isSourceKind(value.kind)) return null;
    const owner = typeof value.owner === "string" ? value.owner.trim() : "";
    const repo = typeof value.repo === "string" ? value.repo.trim() : "";
    if (!domain.SOURCE_SEGMENT_RE.test(owner) || !domain.SOURCE_SEGMENT_RE.test(repo)) return null;
    const normalized = domain.normalizeRepository({ owner, repo });
    if (!normalized) return null;
    return { kind: value.kind, owner: normalized.owner, repo: normalized.repo };
  }

  /** 已持久化的选择（新位置优先，其次旧位置）；缺失 / 非法时回落默认源（ModelScope）+ 构造时给定的仓库。 */
  function readSourceSelection() {
    const stored = normalizeSourceSelection(readJson(sourceFile)) || normalizeSourceSelection(readJson(legacySourceFile));
    if (stored) return stored;
    return { kind: defaultSourceKind, owner: initialRepository.owner, repo: initialRepository.repo };
  }

  function writeSourceSelection(selection) { writeJsonAtomic(sourceFile, selection); }

  /** 绑定某源白名单主机的网络层；重定向仍逐跳校验。 */
  function makeNet(allowedHosts) {
    return {
      async getJson(url, accept) {
        const response = await request(url, accept, allowedHosts);
        if (response.status < 200 || response.status >= 300) return { status: response.status, json: null, parseError: false };
        try { return { status: response.status, json: await response.json(), parseError: false }; }
        catch { return { status: response.status, json: null, parseError: true }; }
      },
      download: (url) => downloadAsset(url, allowedHosts),
    };
  }

  /** 当前选中源、按 appId 绑定的适配器实例（清单路径 / 资产名随 appId 变化）。 */
  function currentSource(appId) {
    const selection = readSourceSelection();
    const descriptor = sourceAdapters.getSourceDescriptor(selection.kind);
    const adapter = sourceAdapters.createSource(selection.kind, {
      appId,
      owner: selection.owner,
      repo: selection.repo,
      net: makeNet(descriptor.allowedHosts),
    });
    return { selection, descriptor, adapter };
  }

  function installedDir(appId, version) { return path.join(appStateDir(appId), version); }

  /** 当前版本的上一版（历史里除当前之外的最后一条）；不存在即 null。 */
  function previousVersion(current, history) {
    if (!current) return null;
    const candidates = history.versions.filter((value) => value !== current.version);
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  function canRollback(appId, current) {
    const previous = previousVersion(current, readHistory(appId));
    return !!previous && fs.existsSync(installedDir(appId, previous));
  }

  // ── 内置公钥（按 appId 取；缺谁的公钥就结构化 NOT_READY，不借别的应用的公钥） ──
  function loadPublicKey(appId) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(keysFile, "utf8")); }
    catch { return { ok: false, error: domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_READY, "内置更新公钥不可用（app-update-keys.json 缺失或不可读）") }; }
    const value = raw && typeof raw[appId] === "string" ? raw[appId].trim() : "";
    if (!value) return { ok: false, error: domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_READY, "app-update-keys.json 缺少 " + appId + " 公钥") };
    const key = domain.toPublicKey(value);
    if (!key) return { ok: false, error: domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_READY, appId + " 公钥不是合法 Ed25519 公钥") };
    return { ok: true, value: key };
  }

  // ── 审计（沿用 authStore.auditAuthorization 既有用法） ─────────────────────
  function writeAudit(actor, { appId, action, decision, reasonCode, version = null, requestId = null }) {
    const store = authorization && authorization.store;
    if (!store || typeof store.auditAuthorization !== "function") return false;
    try {
      store.auditAuthorization({
        actorUserId: actor && actor.user && actor.user.id != null ? String(actor.user.id) : null,
        targetUserId: null,
        appId,
        departmentId: null,
        resourceRef: version ? appId + "@" + version : appId,
        action,
        decision,
        reasonCode,
        permissionSource: actor && actor.isSuper ? "SUPER_ADMIN" : "USER",
        requestId: requestId || null,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** sessionRef → actor；不可解析即 { ok:false }，绝不伪造身份（同 file-transfer-service.cjs:262-271）。 */
  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  // ── 状态（按 appId） ────────────────────────────────────────────────────────
  function statusFor(appId, checkState = readCheckState(appId)) {
    const current = readCurrent(appId);
    const baseVersion = current ? current.version : builtinVersionFor(appId);
    const latest = checkState.latest;
    const selection = readSourceSelection();
    const load = loadSupportFor(appId);
    return {
      appId,
      current: current ? { version: current.version, digest: current.digest, kind: current.kind, entry: current.entry, installedAt: current.installedAt } : null,
      builtinVersion: builtinVersionFor(appId),
      source: { kind: selection.kind, owner: selection.owner, repo: selection.repo },
      checkedAt: checkState.checkedAt,
      latest,
      updateAvailable: !!latest && domain.compareSemver(latest.version, baseVersion) > 0,
      canRollback: canRollback(appId, current),
      packageKind: current ? current.kind : domain.appPackageKind(appId),
      loadable: load.loadable,
      loader: load.loader,
      loadReason: load.reason,
    };
  }

  /**
   * 所有可用源 + 当前选中的源（owner/repo 只读回显；渲染层不能填任意 URL）。
   * appId 缺省 = canvas（历史行为不变）；传入后 manifestPath 按该应用解析。
   */
  function sources(value) {
    const appId = domain.normalizeAppId(value) || domain.CANVAS_APP_ID;
    const selection = readSourceSelection();
    const current = currentSource(appId).adapter.describeSource();
    const available = sourceAdapters.sourceKinds().map((kind) => {
      const item = sourceAdapters.getSourceDescriptor(kind);
      return {
        kind: item.kind,
        label: item.label,
        defaultRepository: { ...item.defaultRepository },
        allowedHosts: item.allowedHosts.slice(),
        configurableFields: item.configurableFields.slice(),
        manifestPath: item.manifestPath == null ? null : sourceAdapters.manifestPathFor(appId),
      };
    });
    return {
      kind: selection.kind,
      owner: selection.owner,
      repo: selection.repo,
      defaultRepository: { ...domain.DEFAULT_REPOSITORY },
      defaultSource: { kind: domain.DEFAULT_SOURCE_KIND },
      apiUrl: current.apiUrl,
      allowedHosts: domain.ALLOWED_HOSTS.slice(),
      channel,
      configurableFields: current.configurableFields,
      manifestPath: current.manifestPath,
      selected: { kind: selection.kind, owner: selection.owner, repo: selection.repo },
      sources: available,
    };
  }

  /** 切换更新源并持久化；kind 必须在注册表内，owner/repo 只允许安全段。 */
  function setSource(payload = {}) {
    if (!sourceAdapters.isSourceKind(payload.kind)) {
      throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "未知的更新源 kind：" + asStr(payload.kind, 60));
    }
    const descriptor = sourceAdapters.getSourceDescriptor(payload.kind);
    let owner = descriptor.defaultRepository.owner;
    let repo = descriptor.defaultRepository.repo;
    if (payload.owner != null || payload.repo != null) {
      if (typeof payload.owner !== "string" || typeof payload.repo !== "string") {
        throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "owner/repo 必须是字符串");
      }
      const trimmedOwner = payload.owner.trim();
      const trimmedRepo = payload.repo.trim();
      if (!domain.SOURCE_SEGMENT_RE.test(trimmedOwner) || !domain.SOURCE_SEGMENT_RE.test(trimmedRepo)) {
        throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "owner/repo 只允许 [A-Za-z0-9._-]，不接受任意 URL");
      }
      const normalized = domain.normalizeRepository({ owner: trimmedOwner, repo: trimmedRepo });
      if (!normalized) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "owner/repo 格式非法");
      owner = normalized.owner;
      repo = normalized.repo;
    }
    writeSourceSelection({ kind: payload.kind, owner, repo });
    return sources(payload.appId);
  }

  // ── 网络 ──────────────────────────────────────────────────────────────────
  async function request(url, accept, hosts = domain.ALLOWED_HOSTS) {
    if (!fetchImpl) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_READY, "主进程没有可用的 fetch");
    domain.assertAllowedUrl(url, hosts);
    let response;
    try {
      response = await fetchImpl(url, { redirect: "manual", headers: { accept, "user-agent": "OpenArc-OS-updater" } });
    } catch (error) {
      throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "网络请求失败：" + asStr(error && error.message, 200));
    }
    if (!response || typeof response.status !== "number") throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "网络响应无效");
    return response;
  }

  /** 逐跳校验重定向域；下载全量字节并做体积上限。 */
  async function downloadAsset(url, hosts = domain.ALLOWED_HOSTS) {
    let current = domain.assertAllowedUrl(url, hosts);
    for (let hop = 0; hop < 6; hop += 1) {
      const response = await request(current, "application/octet-stream", hosts);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers && typeof response.headers.get === "function" ? response.headers.get("location") : null;
        if (!location) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "资产重定向缺少 Location");
        current = domain.assertAllowedUrl(new URL(location, current).toString(), hosts);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "资产下载失败 HTTP " + response.status);
      let buffer;
      try { buffer = Buffer.from(await response.arrayBuffer()); } catch { throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "资产读取失败"); }
      if (!buffer.length) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "资产为空");
      if (buffer.length > maxPackageBytes) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "资产超过体积上限 " + maxPackageBytes + " 字节");
      return buffer;
    }
    throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DOWNLOAD_FAILED, "资产重定向次数过多");
  }

  // ── 校验 / 安装（按 appId；信任链本身不因应用而放宽） ──────────────────────
  function verifyInstalledDirectory(appId, dir, publicKeyObject) {
    const fail = (code, detail) => ({ ok: false, error: domain.createMarketUpdateError(code, detail) });
    let manifestBytes;
    try { manifestBytes = fs.readFileSync(path.join(dir, domain.MANIFEST_NAME)); } catch { return fail(domain.MARKET_UPDATE_ERR_DIGEST_MISMATCH, "激活前校验失败：manifest.json 缺失"); }
    let signatureText;
    try { signatureText = fs.readFileSync(path.join(dir, domain.MANIFEST_SIGNATURE_NAME), "utf8").trim(); } catch { return fail(domain.MARKET_UPDATE_ERR_SIGNATURE_INVALID, "激活前校验失败：manifest.sig 缺失"); }
    const signature = domain.verifyManifestSignature({ manifestBytes, signatureBase64: signatureText, publicKeyObject });
    if (!signature.ok) return fail(domain.MARKET_UPDATE_ERR_SIGNATURE_INVALID, "激活前签名校验失败");
    let manifestRaw;
    try { manifestRaw = JSON.parse(manifestBytes.toString("utf8")); } catch { return fail(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "激活前 manifest.json 不是合法 JSON"); }
    const normalized = domain.normalizeManifest(manifestRaw, { appId });
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const manifest = normalized.value;
    for (const [name, hash] of Object.entries(manifest.files)) {
      let data;
      try { data = fs.readFileSync(path.join(dir, name)); } catch { return fail(domain.MARKET_UPDATE_ERR_DIGEST_MISMATCH, "激活前校验失败：缺少文件 " + name); }
      if (sha256Hex(data) !== hash) return fail(domain.MARKET_UPDATE_ERR_DIGEST_MISMATCH, "激活前校验失败：文件摘要不匹配 " + name);
    }
    if (manifest.placeholder) return fail(domain.MARKET_UPDATE_ERR_UNSUPPORTED, "占位包（manifest.placeholder=true）不允许激活");
    return { ok: true, version: manifest.version, digest: domain.packageDigest(manifestBytes), kind: manifest.kind, entry: manifest.entry, placeholder: false };
  }

  function installVerifiedPackage(appId, bytes, expectedVersion) {
    const label = appId + " 包";
    let entries;
    try { entries = zip.readZip(bytes, ZIP_LIMITS); }
    catch (error) { throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_UNSUPPORTED, label + "不是有效的 ZIP：" + asStr(error && error.message, 200)); }

    const fileMap = new Map();
    for (const entry of entries) {
      if (!domain.isSafeEntryName(entry.name)) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, label + "内条目名不安全（疑似目录穿越）：" + asStr(entry.name, 120));
      if (fileMap.has(entry.name)) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, label + "包含重复条目：" + asStr(entry.name, 120));
      fileMap.set(entry.name, entry.data);
    }

    const manifestBytes = fileMap.get(domain.MANIFEST_NAME);
    if (!manifestBytes) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, label + "缺少 manifest.json");
    const signatureBytes = fileMap.get(domain.MANIFEST_SIGNATURE_NAME);
    if (!signatureBytes) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_SIGNATURE_INVALID, label + "缺少 manifest.sig（拒绝安装未签名包）");

    // 每个应用只认自己那把内置公钥：manifest.id 也必须等于 appId（normalizeManifest 强制）。
    const publicKey = loadPublicKey(appId);
    if (!publicKey.ok) throw publicKey.error;
    const signature = domain.verifyManifestSignature({ manifestBytes, signatureBase64: signatureBytes.toString("utf8").trim(), publicKeyObject: publicKey.value });
    if (!signature.ok) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_SIGNATURE_INVALID, "manifest.sig Ed25519 验签失败");

    let manifestRaw;
    try { manifestRaw = JSON.parse(manifestBytes.toString("utf8")); } catch { throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "manifest.json 不是合法 JSON"); }
    const normalized = domain.normalizeManifest(manifestRaw, { appId });
    if (!normalized.ok) throw normalized.error;
    const manifest = normalized.value;
    if (manifest.placeholder) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_UNSUPPORTED, "占位包（manifest.placeholder=true）不允许安装");
    if (expectedVersion && manifest.version !== expectedVersion) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_CONFLICT, "manifest.version 与发布资产不一致");

    for (const [name, hash] of Object.entries(manifest.files)) {
      const data = fileMap.get(name);
      if (!data) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DIGEST_MISMATCH, label + "缺少文件：" + name);
      if (sha256Hex(data) !== hash) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DIGEST_MISMATCH, "文件 sha256 不匹配：" + name);
    }

    ensureDir(appStateDir(appId));
    const staging = fs.mkdtempSync(path.join(appStateDir(appId), ".staging-"));
    const finalDir = installedDir(appId, manifest.version);
    try {
      for (const name of Object.keys(manifest.files)) {
        const target = path.resolve(staging, name);
        if (!target.startsWith(path.resolve(staging) + path.sep)) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "解压路径越界：" + name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fileMap.get(name));
      }
      fs.writeFileSync(path.join(staging, domain.MANIFEST_NAME), manifestBytes);
      fs.writeFileSync(path.join(staging, domain.MANIFEST_SIGNATURE_NAME), signatureBytes);
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(staging, finalDir);
    } catch (error) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
      throw error;
    }

    const activated = verifyInstalledDirectory(appId, finalDir, publicKey.value);
    if (!activated.ok) { try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch { /* 保持错误原样 */ } throw activated.error; }

    const previous = readCurrent(appId);
    const history = readHistory(appId);
    writeJsonAtomic(historyFileFor(appId), { versions: [...history.versions.filter((value) => value !== manifest.version), manifest.version] });
    writeJsonAtomic(currentFileFor(appId), { version: manifest.version, digest: activated.digest, kind: manifest.kind, entry: manifest.entry, installedAt: Number(clock()) });
    return { installed: { appId, version: manifest.version, digest: activated.digest, kind: manifest.kind, entry: manifest.entry }, previous: previous ? { version: previous.version } : null };
  }

  async function install(payload, actor, context) {
    const requestId = context.requestId || null;
    let appId = null;
    let requestedVersion = null;
    try {
      appId = domain.normalizeAppId(payload.appId);
      if (!appId) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "appId 非法或未注册：" + asStr(payload.appId, 60));
      // 诚实边界：没有加载路径的应用，装了也不会生效 —— 在下载之前结构化拒绝，绝不假装升级成功。
      const load = loadSupportFor(appId);
      if (!load.loadable) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_LOADABLE, load.reason, { appId, loader: null });
      if (payload.confirm !== true) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "install 必须显式 confirm:true（禁止后台静默安装）");
      if (payload.version != null) {
        const parsed = domain.parseSemver(payload.version);
        if (!parsed) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "version 不是合法语义化版本");
        requestedVersion = parsed.version;
      }
      const source = currentSource(appId);
      let release;
      if (requestedVersion) {
        release = await source.adapter.resolveAsset(requestedVersion, { channel });
        if (!release) {
          const candidates = await source.adapter.listReleases({ channel });
          if (!candidates.length) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NO_RELEASE, "当前通道没有可用 Release");
          throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NOT_FOUND, "Release 里没有 " + appId + "-" + requestedVersion + ".zip");
        }
      } else {
        const candidates = await source.adapter.listReleases({ channel });
        release = candidates[0] || null;
        if (!release) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_NO_RELEASE, "当前通道没有可用 Release");
      }
      const { bytes } = await source.adapter.downloadAsset(release);
      const result = installVerifiedPackage(appId, bytes, release.version);
      writeAudit(actor, { appId, action: appId + ".update.install", requestId, decision: "ALLOW", reasonCode: "ALLOW", version: result.installed.version });
      return { ok: true, value: result };
    } catch (error) {
      const normalized = domain.normalizeMarketUpdateError(error);
      const auditAppId = appId || "unknown";
      writeAudit(actor, { appId: auditAppId, action: auditAppId + ".update.install", requestId, decision: "DENY", reasonCode: normalized.error, version: requestedVersion });
      return normalized;
    }
  }

  function rollback(payload = {}, actor, context) {
    const requestId = context.requestId || null;
    let appId = null;
    try {
      appId = domain.normalizeAppId(payload.appId);
      if (!appId) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "appId 非法或未注册：" + asStr(payload.appId, 60));
      const current = readCurrent(appId);
      const history = readHistory(appId);
      const previous = previousVersion(current, history);
      if (!current || !previous) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_ROLLBACK_UNAVAILABLE, "没有可回滚的上一版");
      const dir = installedDir(appId, previous);
      if (!fs.existsSync(dir)) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_ROLLBACK_UNAVAILABLE, "上一版安装目录不存在");
      const publicKey = loadPublicKey(appId);
      if (!publicKey.ok) throw publicKey.error;
      const verified = verifyInstalledDirectory(appId, dir, publicKey.value);
      if (!verified.ok) throw verified.error;
      if (verified.version !== previous) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_DIGEST_MISMATCH, "上一版目录内容与版本不一致");
      writeJsonAtomic(historyFileFor(appId), { versions: history.versions.slice(0, history.versions.lastIndexOf(previous) + 1) });
      writeJsonAtomic(currentFileFor(appId), { version: previous, digest: verified.digest, kind: verified.kind, entry: verified.entry, installedAt: Number(clock()) });
      writeAudit(actor, { appId, action: appId + ".update.rollback", requestId, decision: "ALLOW", reasonCode: "ALLOW", version: previous });
      return { ok: true, value: { rolledBackTo: previous, previous: { version: current.version } } };
    } catch (error) {
      const normalized = domain.normalizeMarketUpdateError(error);
      const auditAppId = appId || "unknown";
      writeAudit(actor, { appId: auditAppId, action: auditAppId + ".update.rollback", requestId, decision: "DENY", reasonCode: normalized.error, version: null });
      return normalized;
    }
  }

  async function check(payload = {}) {
    const appId = domain.normalizeAppId(payload.appId);
    if (!appId) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "appId 非法或未注册：" + asStr(payload.appId, 60));
    const source = currentSource(appId);
    const candidates = await source.adapter.listReleases({ channel });
    const candidate = candidates[0] || null;
    const latest = candidate ? { version: candidate.version, notesUrl: candidate.notesUrl || null, publishedAt: candidate.publishedAt || 0 } : null;
    const checkedAt = Number(clock());
    writeJsonAtomic(checkFileFor(appId), { checkedAt, latest });
    return statusFor(appId, { checkedAt, latest });
  }

  async function execute(command, payload = {}, context = {}) {
    try {
      if (!domain.isMarketUpdateCommand(command)) return domain.normalizeMarketUpdateError(domain.marketUpdateCommandNotAllowed(command));
      const sessionRef = context && context.sessionRef ? String(context.sessionRef) : null;
      if (!sessionRef) return { ok: false, error: domain.MARKET_UPDATE_ERR_UNAUTHENTICATED, detail: "market/update 需要已认证会话" };
      const actor = resolveActor(context);
      if (!actor.ok) return { ok: false, error: domain.MARKET_UPDATE_ERR_UNAUTHENTICATED, detail: actor.message || "会话无效" };
      const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
      switch (command) {
        case "market/update/status": {
          const appId = domain.normalizeAppId(body.appId);
          if (!appId) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "appId 非法或未注册：" + asStr(body.appId, 60));
          return { ok: true, value: statusFor(appId) };
        }
        case "market/update/check": return { ok: true, value: await check(body) };
        case "market/update/install": return await install(body, actor, context);
        case "market/update/rollback": return rollback(body, actor, context);
        case "market/update/sources": {
          const appId = domain.normalizeAppId(body.appId);
          if (!appId) throw domain.createMarketUpdateError(domain.MARKET_UPDATE_ERR_INVALID_INPUT, "appId 非法或未注册：" + asStr(body.appId, 60));
          return { ok: true, value: sources(appId) };
        }
        case "market/update/source/set": return { ok: true, value: setSource(body) };
        default: return domain.normalizeMarketUpdateError(domain.marketUpdateCommandNotAllowed(command));
      }
    } catch (error) {
      if (logger) { try { logger("market-update-failed", { command, message: asStr(error && error.message, 200) }); } catch { /* 日志失败不改结果 */ } }
      return domain.normalizeMarketUpdateError(error);
    }
  }

  const initialSelection = readSourceSelection();
  return {
    commands: domain.MARKET_UPDATE_COMMANDS.slice(),
    stateDir,
    keysFile,
    repository: { owner: initialSelection.owner, repo: initialSelection.repo },
    sourceKind: initialSelection.kind,
    channel,
    builtinVersion,
    builtinVersions: { ...builtinVersions },
    execute,
    // 主进程内部 / 测试用；不经过 IPC。
    appStateDir,
    installedDir,
    status: (value) => statusFor(domain.normalizeAppId(value) || domain.CANVAS_APP_ID),
    sources,
    setSource,
    readSourceSelection,
    readCurrent: (value) => readCurrent(domain.normalizeAppId(value) || domain.CANVAS_APP_ID),
    readHistory: (value) => readHistory(domain.normalizeAppId(value) || domain.CANVAS_APP_ID),
    canRollback: () => canRollback(domain.CANVAS_APP_ID, readCurrent(domain.CANVAS_APP_ID)),
  };
}

module.exports = { createMarketUpdateBundle };
