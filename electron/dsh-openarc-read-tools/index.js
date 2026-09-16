import fs from "node:fs";
process.stderr.write("[openarc-read-tools] module imported\n");
const name = "openarc-read-tools";
const inject = ["tools"];
const MAX_SAFE_ERROR = 80;
function safeError(json, status) {
  const code = json && typeof json.error === "string" ? json.error : "TOOL_FACADE_" + String(status);
  return String(code).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, MAX_SAFE_ERROR);
}
function apply(ctx, config) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(config.manifestPath, "utf8")); }
  catch (e) { process.stderr.write("[openarc-read-tools] manifest read failed: " + String(e && e.message) + "\n"); return; }
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const endpoint = String(config.facadeUrl).replace(/\/$/, "") + "/tool-call";
  for (const t of tools) {
    ctx.tools.register({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      output: { schema: t.outputSchema, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      timeoutMs: 20000,
      async execute(args, exec) {
        // D4-03D Closure：callId 是 logical Tool-call identity；缺失时 fail closed，
        // 绝不把 callId:null 发给 Bridge，也绝不产生任何 Tool Facade request。
        const callId = exec && typeof exec.callId === "string" && exec.callId.trim().length > 0 ? exec.callId : null;
        if (!callId) throw new Error("[" + t.name + "] OpenArc Tool Facade requires a callId");
        let res;
        try {
          res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + config.capability }, body: JSON.stringify({ toolId: t.toolId, arguments: args, callId }) });
        } catch {
          throw new Error("[" + t.name + "] OpenArc Tool Facade unreachable");
        }
        let json = null;
        try { json = await res.json(); } catch { json = null; }
        if (!json || !json.ok) throw new Error("[" + t.name + "] OpenArc denied: " + safeError(json, res.status));
        return json.result;
      },
    });
  }
  process.stderr.write("[openarc-read-tools] registered " + tools.map((t) => t.name).join(",") + "\n");
}
export { apply, inject, name };
