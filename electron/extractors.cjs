/**
 * D3-04C · ResourceExtractorRegistry —— 按 resourceType / mimeType 选择本地 extractor。
 *
 * 全部 LOCAL；不调用远程 Vision / OCR / Transcription。
 * 无可信本地 parser 的类型（PDF 文本层 / Office）明确返回 unsupportedText / NO_TEXT，
 * 不假实现，也不偷偷 OCR。
 */
"use strict";

const domain = require("./search-domain.cjs");

const TEXT_RESOURCE_TYPES = Object.freeze(["memory", "text", "code", "prompt"]);
const TEXT_MIME = Object.freeze(["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/typescript"]);

const EXTRACTOR = Object.freeze({
  TEXT: "text",
  PDF_METADATA_ONLY: "pdf-metadata-only",
  METADATA_ONLY: "metadata-only",
  UNSUPPORTED: "unsupported",
});

class ResourceExtractorRegistry {
  constructor({ maxTextBytes = domain.LIMITS.MAX_INDEX_TEXT_BYTES, nativePdf = null } = {}) {
    this.maxTextBytes = maxTextBytes;
    /** 预留注入点：未来接入可信本地 PDF 文本层 parser 时替换。 */
    this.nativePdf = nativePdf;
  }

  resolve(row) {
    if (!row) return EXTRACTOR.UNSUPPORTED;
    const type = String(row.resource_type || "");
    const mime = String(row.mime_type || "").toLowerCase();
    if (TEXT_RESOURCE_TYPES.includes(type)) return EXTRACTOR.TEXT;
    if (mime.startsWith("text/") || TEXT_MIME.includes(mime)) return EXTRACTOR.TEXT;
    if (mime === "application/pdf") return EXTRACTOR.PDF_METADATA_ONLY;
    return EXTRACTOR.METADATA_ONLY;
  }

  /**
   * @param opts.row          权威 resource row
   * @param opts.readContent  async ({maxBytes}) => {ok, text, truncated, error}
   * @returns { hasText, contentText, truncated, extractor, unsupportedText }
   */
  async extract({ row, readContent }) {
    const extractor = this.resolve(row);
    if (extractor === EXTRACTOR.TEXT) {
      let res;
      try {
        res = await readContent({ maxBytes: this.maxTextBytes });
      } catch (e) {
        return { hasText: false, contentText: "", truncated: false, extractor, errorCode: domain.REASON.INDEX_FAILED, error: String(e && e.message) };
      }
      if (!res || !res.ok) {
        return { hasText: false, contentText: "", truncated: false, extractor, errorCode: res && res.error, error: res && res.error };
      }
      const text = String(res.text == null ? "" : res.text);
      if (!text.trim()) return { hasText: false, contentText: "", truncated: !!res.truncated, extractor };
      return { hasText: true, contentText: text, truncated: !!res.truncated, extractor };
    }
    if (extractor === EXTRACTOR.PDF_METADATA_ONLY) {
      // 本地未内建 PDF 文本层解析；不 OCR，不假装。metadata 仍会被索引。
      return { hasText: false, contentText: "", truncated: false, extractor, unsupportedText: true };
    }
    return { hasText: false, contentText: "", truncated: false, extractor, unsupportedText: false };
  }
}

module.exports = { ResourceExtractorRegistry, EXTRACTOR, TEXT_RESOURCE_TYPES, TEXT_MIME };
