"use strict";
/**
 * P2 · 能力 manifest 服务（协议仓库之上的查询层）。
 *
 * 依据：
 *   · DXSRC/protocolManifest.ts:199-223  listProtocolPackages
 *   · DXSRC/protocolManifest.ts:246-465  manifest / operation / parameter schema / 参数校验
 *   · DXSRC/protocolUpdates.ts:8,189,215 远程协议包目录（本实现改为**本地目录扫描**）
 *   · DXSRC/server/protocolInference.ts   模型协议推断（getManifest 的可选 inferred 字段）
 *
 * inferred 接入边界：只要给了 model 或 models 就计算并追加 inferred；未给模型（或协议不存在）时
 * 不追加，既有字段与既有命令行为保持不变。baseUrl / providerProtocol 可选，用于让推断命中真实站点，
 * 缺省时以 protocolId 作为供应商协议输入。
 */
const fs = require("node:fs");
const manifestDomain = require("./model-manifest-domain.cjs");
const protocolInference = require("./protocol-engine/protocol-inference.cjs");

function createModelManifestService({ repository } = {}) {
  if (!repository) throw new Error("createModelManifestService 需要 protocol-engine repository");

  /**
   * 推断：源 DXSRC/server/protocolInference.ts:231-257 inferProviderProtocols。
   * models 优先于单个 model；没有任何模型时返回 null（不追加 inferred）。
   */
  function buildInference({ protocolId, model, baseUrl, providerProtocol, models }) {
    const list = Array.isArray(models) && models.length ? models.map(String) : (model ? [String(model)] : []);
    if (!list.length) return null;
    return protocolInference.inferProviderProtocols({
      baseUrl: baseUrl == null ? "" : String(baseUrl),
      protocol: providerProtocol == null || providerProtocol === "" ? (protocolId || "openai") : String(providerProtocol),
      models: list,
    });
  }

  function getManifest({ protocolId, model, intent = "llm.chat", references = null, params = null, baseUrl = null, providerProtocol = null, models = null } = {}) {
    let entry;
    try { entry = repository.getProtocolV2("model", protocolId); } catch (error) { return { ok: false, error: "INVALID_INPUT", detail: String(error.message || error).slice(0, 300) }; }
    if (!entry || !entry.protocol || entry.protocol.kind !== "model") return { ok: false, error: "PROTOCOL_NOT_FOUND" };
    const protocol = entry.protocol;
    const manifest = manifestDomain.resolveProtocolModelProfile(protocol, model);
    const parameterSchema = manifestDomain.resolveParameterSchema(protocol, model, intent);
    const operation = manifestDomain.resolveOperation(protocol, model, intent);
    let parameterError = null;
    if (params) {
      try { manifestDomain.validateProtocolParameters(protocol, model, intent, params, references || {}); }
      catch (error) { parameterError = String(error.message || error); }
    }
    const result = {
      ok: true, format: "dx-model-manifest/v1",
      protocolId: protocol.id, protocolVersion: entry.version, protocolHash: entry.hash,
      model, intent, manifest, parameterSchema,
      operation: operation ? { id: operation.id, ...operation.operation } : null,
      ...(parameterError ? { parameterError } : {}),
    };
    const inferred = buildInference({ protocolId: protocol.id, model, baseUrl, providerProtocol, models });
    return inferred ? { ...result, inferred } : result;
  }

  function listProtocols() {
    return repository.listProtocolsV2("model").map((entry) => ({
      id: entry.id, label: entry.protocol.label, summary: entry.protocol.summary,
      source: entry.source, activeVersion: entry.activeVersion, activeHash: entry.activeHash,
      capabilities: entry.protocol.capabilities || [],
      operations: Object.keys(entry.protocol.operations || {}),
      modelProfiles: Object.keys(entry.protocol.modelProfiles || {}),
      uiSchemas: Object.keys(entry.protocol.uiSchemas || {}),
    }));
  }

  function getCoverage({ protocolId, models = [] } = {}) {
    const entry = repository.getProtocolV2("model", protocolId);
    if (!entry || !entry.protocol || entry.protocol.kind !== "model") return { ok: false, error: "PROTOCOL_NOT_FOUND" };
    const list = Array.isArray(models) && models.length ? models : Object.keys(entry.protocol.modelProfiles || {});
    return { ok: true, coverage: manifestDomain.inspectProtocolCoverage(entry.protocol, list) };
  }

  /**
   * 本地协议包扫描：替代 DXSRC/protocolUpdates.ts 从 https://api.dx-os.com 拉取。
   * 目录里每个 *.json 是一个协议包；损坏的包不阻塞，逐条报告。
   */
  function scanProtocolUpdates({ directories = [] } = {}) {
    const found = [];
    for (const dir of directories) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json")); } catch { continue; }
      for (const name of names) found.push({ directory: String(dir), file: name });
      for (const entry of repository.scanProtocolPackageDirectory(dir)) {
        found.push({ directory: String(dir), id: entry.id, kind: entry.kind, sourcePath: entry.sourcePath, valid: true });
      }
    }
    return { ok: true, format: "dx-protocol-updates/v1", source: "local", scannedAt: Date.now(), packages: found };
  }

  return { getManifest, listProtocols, getCoverage, scanProtocolUpdates };
}

module.exports = { createModelManifestService };
