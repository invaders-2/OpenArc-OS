"use strict";
/**
 * protocol-engine 统一出口。
 * 源目录：DXSRC/protocol-engine/（15 个 .ts）。本目录的 .cjs 划分与源文件一一对应，
 * 另加 openAiMinimaxProfiles.cjs（builtins 依赖）与 index.cjs（聚合）。
 */
module.exports = {
  types: require("./types.cjs"),
  validator: require("./validator.cjs"),
  modelProfile: require("./modelProfile.cjs"),
  providerIdentity: require("./providerIdentity.cjs"),
  compiler: require("./compiler.cjs"),
  transport: require("./transport.cjs"),
  workflow: require("./workflow.cjs"),
  artifactDownload: require("./artifactDownload.cjs"),
  builtins: require("./builtins.cjs"),
  repository: require("./repository.cjs"),
  bindings: require("./bindings.cjs"),
  flags: require("./flags.cjs"),
  geminiToolSchema: require("./geminiToolSchema.cjs"),
};
