process.env.OA_EGRESS_TEST_HOSTNAME = "public.example";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startFakeProxy, startTlsTarget, tlsFixtures } from "./model-egress-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createEgressFetch } = require("../electron/net-egress.cjs");
const { downloadProtocolArtifact } = require("../electron/protocol-engine/artifactDownload.cjs");
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("HTTPS CONNECT 代理下载：正常、私网拒绝、重定向与流式硬上限", async () => {
  const target = await startTlsTarget();
  const proxy = await startFakeProxy({ upstreamPort: target.port });
  let directCalls = 0;
  const baseFetch = async () => { directCalls += 1; throw new Error("代理启用时不得直连"); };
  const fetchImpl = createEgressFetch({ getConfig: () => ({ enabled: true, url: proxy.url }), baseFetch, tlsOptions: { ca: tlsFixtures().ca } });
  const base = `https://public.example:${target.port}`;
  try {
    const normal = await downloadProtocolArtifact(base + "/media.png", { fetchImpl, lookup: publicLookup, maxBytes: 4096, timeoutMs: 5000 });
    assert.equal(normal.data.toString(), "proxied-png");
    assert.equal(normal.mime, "image/png");
    assert.equal(proxy.state.connects.length, 1);
    assert.equal(proxy.state.connects[0], `public.example:${target.port}`);
    assert.equal(directCalls, 0);

    await assert.rejects(
      () => downloadProtocolArtifact(`https://127.0.0.1:${target.port}/media.png`, { fetchImpl, lookup: publicLookup, maxBytes: 4096, timeoutMs: 5000 }),
      /私网|本机/,
    );
    assert.equal(proxy.state.connects.length, 1, "私网目标必须在 CONNECT 前拒绝");

    await assert.rejects(
      () => downloadProtocolArtifact(base + "/redirect-private", { fetchImpl, lookup: publicLookup, maxBytes: 4096, timeoutMs: 5000 }),
      /私网|本机/,
    );
    assert.equal(proxy.state.connects.length, 2, "公开首跳可连接，私网第二跳必须在 CONNECT 前拒绝");

    const redirected = await downloadProtocolArtifact(base + "/redirect-media", { fetchImpl, lookup: publicLookup, maxBytes: 4096, timeoutMs: 5000 });
    assert.equal(redirected.data.toString(), "proxied-png");
    assert.equal(proxy.state.connects.length, 4, "Headers.location 必须驱动重定向与最终资源两次 CONNECT");

    await assert.rejects(
      () => downloadProtocolArtifact(base + "/large.png", { fetchImpl, lookup: publicLookup, maxBytes: 4096, timeoutMs: 5000 }),
      /超过大小限制/,
    );
    assert.equal(directCalls, 0, "任何代理路径都不得回落 baseFetch/direct");
  } finally {
    await proxy.close();
    await target.close();
  }
});
