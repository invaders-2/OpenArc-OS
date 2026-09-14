/**
 * D3-04A 测试夹具。
 *
 * 在 D3-03 的 device-fixtures 之上叠加 ResourceStore + ManagedStore + ResourceService，
 * 保证所有 resource-*.test.mjs 跑的是同一套真实服务。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createDeviceFixture, SERVICE_IDENTITY, pw } from "./device-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const { DeviceStore } = require("../electron/device-store.cjs");
const { DeviceService } = require("../electron/device-service.cjs");
const { ResourceStore } = require("../electron/resource-store.cjs");
const { ManagedStore } = require("../electron/resource-fs.cjs");
const { ResourceService } = require("../electron/resource-service.cjs");
const { SearchStore } = require("../electron/search-store.cjs");
const { SearchService } = require("../electron/search-service.cjs");
const { PreviewService } = require("../electron/preview-service.cjs");
const { IntegrationStore } = require("../electron/integration-store.cjs");
const { ProjectService, CanvasService } = require("../electron/integration-service.cjs");
const { GovernanceService } = require("../electron/governance-service.cjs");
const { ResourcePickerService } = require("../electron/picker-service.cjs");

export const resourceDomain = require("../electron/resource-domain.cjs");
export const searchDomain = require("../electron/search-domain.cjs");
export { pw, SERVICE_IDENTITY };

export function tempRoot(prefix = "oa-d3-04a") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
}

function buildRuntime({ identity, clock = null }) {
  const authStore = new AuthorizationStore({ identity, clock });
  const authService = new AuthorizationService({ identity, authStore });
  const deviceStore = new DeviceStore({ identity, clock });
  const deviceService = new DeviceService({ identity, deviceStore, authService, clock, serviceIdentity: SERVICE_IDENTITY });
  return { authStore, authService, deviceStore, deviceService };
}

export async function createResourceFixture({ dbPath = ":memory:", storeRoot = null } = {}) {
  const fx = await createDeviceFixture({ dbPath });
  const root = storeRoot || tempRoot("oa-d3-04a-store");
  const managedStore = new ManagedStore({ root });
  managedStore.ensureLayout();
  const resourceStore = new ResourceStore({ identity: fx.identity, clock: fx.clock });
  const resourceService = new ResourceService({
    identity: fx.identity,
    resourceStore,
    managedStore,
    authService: fx.authService,
    authStore: fx.store,
    deviceService: fx.deviceService,
    clock: fx.clock,
  });
  const searchStore = new SearchStore({ identity: fx.identity, clock: fx.clock });
  const searchService = new SearchService({ identity: fx.identity, resourceStore, searchStore, managedStore, authService: fx.authService, authStore: fx.store, deviceService: fx.deviceService, clock: fx.clock });
  const previewService = new PreviewService({ identity: fx.identity, resourceStore, searchStore, managedStore, authService: fx.authService, deviceService: fx.deviceService, clock: fx.clock, nativeImage: null });
  const integrationStore = new IntegrationStore({ identity: fx.identity, clock: fx.clock });
  const projectService = new ProjectService({ identity: fx.identity, integrationStore, authService: fx.authService, resourceStore });
  const canvasService = new CanvasService({ identity: fx.identity, integrationStore, authService: fx.authService, resourceStore });
  const governanceService = new GovernanceService({ identity: fx.identity, authService: fx.authService, authStore: fx.store, resourceStore, integrationStore });
  const pickerService = new ResourcePickerService({ identity: fx.identity, authService: fx.authService, searchService, resourceStore, clock: fx.clock });
  const sourceDir = tempRoot("oa-d3-04a-src");
  const writeSource = (name, content) => {
    const p = path.join(sourceDir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  return {
    ...fx,
    resourceStore,
    managedStore,
    resourceService,
    searchStore,
    searchService,
    previewService,
    integrationStore,
    projectService,
    canvasService,
    governanceService,
    pickerService,
    storeRoot: root,
    sourceDir,
    writeSource,
    ctx(key, extra = {}) {
      return { sessionRef: fx.sessions[key], appId: "resource-library", source: "ui", ...extra };
    },
    close() {
      try {
        fx.identity.close();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(sourceDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (dbPath !== ":memory:") {
        try {
          fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** 在同一 DB / store 上重开运行时（重启持久化用例）。 */
export function reopenResourceRuntime({ dbPath, storeRoot }) {
  const identity = new IdentityStore({ path: dbPath }).open();
  const runtime = buildRuntime({ identity });
  const managedStore = new ManagedStore({ root: storeRoot });
  managedStore.ensureLayout();
  const resourceStore = new ResourceStore({ identity });
  const resourceService = new ResourceService({
    identity,
    resourceStore,
    managedStore,
    authService: runtime.authService,
    authStore: runtime.authStore,
    deviceService: runtime.deviceService,
  });
  const searchStore = new SearchStore({ identity });
  const searchService = new SearchService({ identity, resourceStore, searchStore, managedStore, authService: runtime.authService, authStore: runtime.authStore, deviceService: runtime.deviceService });
  const previewService = new PreviewService({ identity, resourceStore, searchStore, managedStore, authService: runtime.authService, deviceService: runtime.deviceService, nativeImage: null });
  const integrationStore = new IntegrationStore({ identity });
  const projectService = new ProjectService({ identity, integrationStore, authService: runtime.authService, resourceStore });
  const canvasService = new CanvasService({ identity, integrationStore, authService: runtime.authService, resourceStore });
  const governanceService = new GovernanceService({ identity, authService: runtime.authService, authStore: runtime.authStore, resourceStore, integrationStore });
  const pickerService = new ResourcePickerService({ identity, authService: runtime.authService, searchService, resourceStore });
  return { identity, managedStore, resourceStore, resourceService, searchStore, searchService, previewService, integrationStore, projectService, canvasService, governanceService, pickerService, ...runtime };
}
