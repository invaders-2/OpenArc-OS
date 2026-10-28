"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.OPENARC_FEEDBACK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-"));
const { CanvasService } = require("../canvas-service.cjs");
const identity = { validateSession: () => ({ ok: true, user: { id: "u1" } }) };
const service = new CanvasService({ identity, store: {}, clock: () => 1700000000000 });

test("feedback submit appends jsonl line", () => {
  const result = service.submitFeedback({ context: { sessionRef: "s" }, category: "bug", text: "按钮点不动", canvasId: "cv1", nodeId: "n1", appVersion: "1.0" });
  assert.equal(result.ok, true);
  assert.match(result.id, /^fb_/);
  const line = fs.readFileSync(path.join(process.env.OPENARC_FEEDBACK_DIR, "feedback.jsonl"), "utf8").trim();
  const record = JSON.parse(line);
  assert.equal(record.category, "bug");
  assert.equal(record.text, "按钮点不动");
  assert.equal(record.canvasId, "cv1");
  assert.equal(record.nodeId, "n1");
  assert.equal(record.platform, process.platform);
  assert.ok(!line.includes("secret"));
});

test("feedback rejects empty, long and invalid category", () => {
  assert.equal(service.submitFeedback({ context: { sessionRef: "s" }, category: "bug", text: "   " }).error, "INVALID_INPUT");
  assert.equal(service.submitFeedback({ context: { sessionRef: "s" }, category: "bug", text: "x".repeat(4001) }).error, "INVALID_INPUT");
  assert.equal(service.submitFeedback({ context: { sessionRef: "s" }, category: "nope", text: "ok" }).error, "INVALID_INPUT");
});
