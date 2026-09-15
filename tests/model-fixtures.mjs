/** D4-01 测试夹具：在 resource fixture 之上叠加 Model Store / Credential Store / Model Service。 */
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";
const require = createRequire(import.meta.url);
const { ModelStore } = require("../electron/model-store.cjs");
const { CredentialStore, memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { ModelService } = require("../electron/model-service.cjs");

export async function createModelFixture({ backend = null, fetchImpl = null, dbPath = ":memory:", storeRoot = null, logger = null, timeoutMs = 3000, keepData = false } = {}) {
  const f = await createResourceFixture({ dbPath, storeRoot, keepData });
  const modelStore = new ModelStore({ identity: f.identity, clock: f.clock });
  const credentialStore = new CredentialStore({ store: modelStore, backend: backend === null ? memoryCredentialBackend() : backend });
  const modelService = new ModelService({ identity: f.identity, authService: f.authService, authStore: f.store, modelStore, credentialStore, fetchImpl: fetchImpl || fetch, logger, timeoutMs });
  return { ...f, modelStore, credentialStore, modelService };
}
