/**
 * D4-01 · Credential Isolation child。
 *
 * 模拟未来 Harness 的最小信任等级：**只拿到 Proxy endpoint + scoped capability**，
 * 通过 OpenArc Model Proxy 调用模型；永远拿不到 Provider API Key。
 */
const url = process.env.D4_PROXY_URL;
const token = process.env.D4_PROXY_TOKEN;
if (!url || !token) { process.stdout.write("CHILD_ERROR missing proxy url/token\n"); process.exit(2); }
try {
  const res = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ messages: [{ role: "user", content: "child request" }] }),
  });
  const json = await res.json();
  process.stdout.write("CHILD_RESULT " + JSON.stringify({ status: res.status, ok: json.ok, text: json.text, toolCalls: json.toolCalls }) + "\n");
} catch (e) {
  process.stdout.write("CHILD_ERROR " + String((e && e.message) || e) + "\n");
  process.exit(3);
}
