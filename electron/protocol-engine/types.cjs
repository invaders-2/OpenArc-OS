"use strict";
/**
 * dx-protocol/v2 的共享常量。
 * 类型本身是编译期概念，CJS 侧只保留运行时真正用到的枚举与 schema 标识，
 * 避免把 TS type 伪造成运行时代码。
 * 源：DXSRC/protocol-engine/types.ts:3-12
 */
const PROTOCOL_V2_SCHEMA = "dx-protocol/v2";
const PROTOCOL_V2_KINDS = Object.freeze(["provider", "model"]);
const PROTOCOL_V2_EXECUTOR_TYPES = Object.freeze(["declarative", "native"]);
const PROTOCOL_V2_AUTH_TYPES = Object.freeze(["bearer", "api_key_header", "google_api_key", "none"]);
const PROTOCOL_V2_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PROTOCOL_V2_REQUEST_MODES = Object.freeze(["json", "query", "path", "multipart", "binary"]);
const PROTOCOL_V2_RESPONSE_MODES = Object.freeze(["json", "text", "binary", "sse", "ndjson"]);
const PROTOCOL_V2_CREDENTIAL_REFS = Object.freeze(["api_key", "wallet_api_key"]);

module.exports = {
  PROTOCOL_V2_SCHEMA,
  PROTOCOL_V2_KINDS,
  PROTOCOL_V2_EXECUTOR_TYPES,
  PROTOCOL_V2_AUTH_TYPES,
  PROTOCOL_V2_METHODS,
  PROTOCOL_V2_REQUEST_MODES,
  PROTOCOL_V2_RESPONSE_MODES,
  PROTOCOL_V2_CREDENTIAL_REFS,
};
