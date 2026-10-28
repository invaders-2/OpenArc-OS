import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { createCalendarBundle } = require("../electron/calendar-service.cjs");
const { registerCalendarIpc } = require("../electron/calendar-bootstrap.cjs");
const { createMediaBundle } = require("../electron/media-service.cjs");
const { registerMediaIpc } = require("../electron/media-bootstrap.cjs");
const mediaStore = require("../electron/media-store.cjs");
const dirs = [];
afterEach(() => { mediaStore.resetMediaStoreForTests(); while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function fixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-2b-accounts-"));
  dirs.push(userDataDir);
  const dbPath = path.join(userDataDir, "identity.db");
  let identity = new IdentityStore({ path: dbPath }).open();
  const authorization = { resolveActor({ context }) { return context.sessionRef ? { ok: true, user: { id: context.sessionRef } } : { ok: false }; } };
  const calendar = () => createCalendarBundle({ identityStore: identity, authorization });
  const media = () => createMediaBundle({ userDataDir, identityStore: identity, authorization });
  const invoke = (bundle, user, command, payload = {}) => bundle.execute(command, payload, { sessionRef: user });
  const restart = () => { identity.close(); identity = new IdentityStore({ path: dbPath }).open(); };
  return { userDataDir, dbPath, get identity() { return identity; }, authorization, calendar, media, invoke, restart };
}
const quick = { name: "A draft", resolution: "1080p", clips: [{ uid: "q1", folderId: "desktop", id: "v1", name: "a.mp4", duration: 4, start: 0, end: 4 }] };
const timeline = { schemaVersion: "1.0", projectId: "ignored", version: 3, timebase: 1000, canvas: { width: 1920, height: 1080, fps: 30 }, durationMs: 4000, tracks: [], transitions: [] };
const sources = { asset1: { folderId: "desktop", id: "v1" } };

test("2B · Calendar trusted owner、两账号 CRUD、并发版本与显式导入幂等", async () => {
  const { calendar, invoke } = fixture();
  const service = calendar();
  const created = await invoke(service, "user-a", "calendar/event/create", { event: { id: "shared-id", date: "2026-10-28", time: "09:30", title: "A event", reminderMinutes: 10 }, ownerUserId: "user-b" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.event.version, 1);
  assert.equal((await invoke(service, "user-b", "calendar/event/list")).value.items.length, 0);
  assert.equal((await invoke(service, "user-b", "calendar/event/update", { id: "shared-id", expectedVersion: 1, patch: { title: "stolen" } })).error, "CALENDAR_NOT_FOUND");
  assert.equal((await invoke(service, "user-b", "calendar/event/delete", { id: "shared-id" })).error, "CALENDAR_NOT_FOUND");
  assert.equal((await invoke(service, "user-a", "calendar/event/update", { id: "shared-id", expectedVersion: 1, patch: { remindedAt: 123 } })).value.event.version, 2);
  assert.equal((await invoke(service, "user-a", "calendar/event/update", { id: "shared-id", expectedVersion: 1, patch: { title: "stale" } })).error, "CALENDAR_CONFLICT");
  assert.equal((await invoke(service, "user-a", "calendar/event/delete", { id: "shared-id", expectedVersion: 1 })).error, "CALENDAR_CONFLICT");

  const legacy = [{ id: "legacy-same", date: "2026-11-01", time: "", title: "Legacy", reminderMinutes: null }];
  const importedA = await invoke(service, "user-a", "calendar/event/import-legacy", { events: legacy });
  const importedB = await invoke(service, "user-b", "calendar/event/import-legacy", { events: legacy });
  assert.equal(importedA.value.imported, 1);
  assert.equal(importedB.value.imported, 1);
  await invoke(service, "user-a", "calendar/event/update", { id: "legacy-same", expectedVersion: 1, patch: { title: "A newer" } });
  const retry = await invoke(service, "user-a", "calendar/event/import-legacy", { events: legacy });
  assert.equal(retry.value.imported, 0);
  assert.equal(retry.value.skipped, 1);
  assert.equal(retry.value.items.find((event) => event.id === "legacy-same").title, "A newer");
  assert.equal((await invoke(service, "user-b", "calendar/event/list")).value.items[0].title, "Legacy");
});

test("2B · Calendar IPC 忽略 Renderer 自报 owner，并使用主进程当前 session", async () => {
  const { calendar, authorization } = fixture();
  const handlers = new Map();
  const ipcMain = { handle(name, fn) { handlers.set(name, fn); }, removeHandler(name) { handlers.delete(name); } };
  registerCalendarIpc({ ipcMain, bundle: calendar(), identity: { current: "user-a" }, isTrusted: () => true });
  const result = await handlers.get("calendar:command")({}, { command: "calendar/event/create", payload: { ownerId: "user-b", userId: "user-b", event: { id: "ipc-event", date: "2026-10-28", time: "", title: "Trusted" } } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await calendar().execute("calendar/event/list", {}, { sessionRef: "user-a" })).value.items.length, 1);
  assert.equal((await calendar().execute("calendar/event/list", {}, { sessionRef: "user-b" })).value.items.length, 0);
  assert.equal(authorization.resolveActor({ context: { sessionRef: "user-a" } }).user.id, "user-a");
});

test("2B · media draft owner、版本冲突、导入不覆盖与重启；render job 结构不变", async () => {
  const { media, invoke, restart } = fixture();
  let service = media();
  const projectId = crypto.randomUUID();
  assert.equal((await invoke(service, "user-a", "media/project/ensure", { projectId, projectName: "A", ownerId: "user-b" })).ok, true);
  assert.equal((await invoke(service, "user-b", "media/draft/get", { projectId })).error, "MEDIA_NOT_FOUND");
  const saved = await invoke(service, "user-a", "media/draft/save", { projectId, quick, timeline, sources, expectedVersion: 0, ownerId: "user-b" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.value.draft.version, 1);
  assert.equal(saved.value.draft.quick.name, "A draft");
  assert.equal(saved.value.draft.timeline.version, 3);
  assert.ok(saved.value.draft.updatedAt > 0);
  assert.equal((await invoke(service, "user-b", "media/draft/save", { projectId, quick, timeline, sources, expectedVersion: 1 })).error, "MEDIA_NOT_FOUND");
  assert.equal((await invoke(service, "user-a", "media/draft/save", { projectId, quick, timeline, sources, expectedVersion: 0 })).error, "MEDIA_CONFLICT");
  const imported = await invoke(service, "user-a", "media/draft/import-legacy", { projectId, quick: { ...quick, name: "Old" }, timeline, sources });
  assert.equal(imported.value.imported, false);
  assert.equal(imported.value.draft.quick.name, "A draft");
  const secondProject = crypto.randomUUID();
  const firstImport = await invoke(service, "user-a", "media/draft/import-legacy", { projectId: secondProject, quick, timeline, sources });
  const secondImport = await invoke(service, "user-a", "media/draft/import-legacy", { projectId: secondProject, quick, timeline, sources });
  assert.equal(firstImport.value.imported, true);
  assert.equal(secondImport.value.imported, false);

  restart();
  service = media();
  const reopened = await invoke(service, "user-a", "media/draft/get", { projectId });
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(reopened.value.draft.version, 1);
  assert.deepEqual(reopened.value.draft.sources, sources);
  assert.equal((await invoke(service, "user-a", "media/draft/latest")).value.draft.projectId, secondProject);
  assert.equal((await invoke(service, "user-b", "media/draft/latest")).value.draft, null);
  assert.equal((await invoke(service, "user-b", "media/draft/get", { projectId })).error, "MEDIA_NOT_FOUND");
  const jobTable = service ? mediaStore.getMediaDb().prepare("PRAGMA table_info(video_render_jobs)").all().map((row) => row.name) : [];
  const draftTable = mediaStore.getMediaDb().prepare("PRAGMA table_info(video_project_drafts)").all().map((row) => row.name);
  assert.equal(jobTable.includes("quick_json"), false);
  assert.ok(draftTable.includes("quick_json") && draftTable.includes("timeline_json") && draftTable.includes("sources_json"));
});

test("2B · media draft IPC 使用当前 trusted session，B 不可读 A", async () => {
  const { media } = fixture();
  const handlers = new Map();
  const ipcMain = { handle(name, fn) { handlers.set(name, fn); }, removeHandler(name) { handlers.delete(name); } };
  const identity = { current: "user-a" };
  registerMediaIpc({ ipcMain, bundle: media(), identity, isTrusted: () => true });
  const projectId = crypto.randomUUID();
  await handlers.get("media:command")({}, { command: "media/project/ensure", payload: { projectId, projectName: "IPC A" } });
  const saved = await handlers.get("media:command")({}, { command: "media/draft/save", payload: { projectId, quick, timeline, sources, expectedVersion: 0, ownerId: "user-b" } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  identity.current = "user-b";
  const denied = await handlers.get("media:command")({}, { command: "media/draft/get", payload: { projectId, ownerId: "user-a" } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "MEDIA_NOT_FOUND");
});

test("2B · v30 迁移失败整级回滚，重放成功且历史表保留", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-2b-migration-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "identity.db");
  const initial = new IdentityStore({ path: dbPath }).open();
  assert.equal(initial.schemaVersion, 30);
  initial.close();
  const raw = new (require("node:sqlite").DatabaseSync)(dbPath);
  raw.exec("DROP TABLE calendar_events; DROP TABLE video_project_drafts; PRAGMA user_version = 28;");
  raw.close();
  const failing = new IdentityStore({ path: dbPath, hooks: { onMigration(version) { if (version === 30) throw new Error("boom-v30"); } } });
  assert.throws(() => failing.open(), /boom-v30/);
  failing.close();
  const check = new (require("node:sqlite").DatabaseSync)(dbPath);
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 28);
  assert.equal(check.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name IN ('calendar_events','video_project_drafts')").get().c, 0);
  assert.equal(check.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='video_projects'").get().c, 1);
  check.close();
  const reopened = new IdentityStore({ path: dbPath }).open();
  assert.equal(reopened.schemaVersion, 30);
  assert.equal(reopened.connection.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name IN ('calendar_events','video_project_drafts')").get().c, 2);
  reopened.close();
});
