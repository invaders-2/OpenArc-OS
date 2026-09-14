import fs from "node:fs";
process.stderr.write("[openarc-read-tools] module imported\n");
const name = "openarc-read-tools";
const inject = ["tools"];
function apply(ctx, config) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(config.manifestPath, "utf8")); }
  catch (e) { process.stderr.write("[openarc-read-tools] manifest read failed: " + String(e && e.message) + "\n"); return; }
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  for (const t of tools) {
    ctx.tools.register({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      output: { schema: t.outputSchema, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      timeoutMs: 20000,
      async execute(args) {
        const res = await fetch(String(config.facadeUrl).replace(/\/$/, "") + "/tool-call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + config.capability }, body: JSON.stringify({ toolId: t.toolId, args }) });
        const json = await res.json();
        if (!json || !json.ok) throw new Error("OpenArc tool denied: " + ((json && json.error) || res.status));
        return json.result;
      },
    });
  }
  process.stderr.write("[openarc-read-tools] registered " + tools.map((t) => t.name).join(",") + "\n");
}
export { apply, inject, name };
