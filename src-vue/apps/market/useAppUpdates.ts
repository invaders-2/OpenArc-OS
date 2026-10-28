import { computed, reactive, ref } from "vue";
import { t } from "../../i18n";
import { APPS, type AppEntry } from "../../apps";
import { UPDATE_STATUS_COMMAND, appCardUpdate, normalizeAppUpdateStatus, type AppUpdateStatus } from "../appUpdateLogic";
import { marketCall } from "./commandClient";
import { normalizeHealth, type ThirdHealth } from "./marketNormalization";

export type HealthRow = { app: AppEntry; status: AppUpdateStatus | null; health: ThirdHealth | null; error: { code: string; detail: string } | null };

export function useAppUpdates({ matchesQuery, descOf }: { matchesQuery: (...values: string[]) => boolean; descOf: (app: AppEntry) => string }) {
  const statuses = reactive<Record<string, AppUpdateStatus | null>>({});
  const statusBusy = ref(false);
  const statusLoaded = ref(false);
  const card = (a: AppEntry) => appCardUpdate(statuses[a.id] ?? null);
  const upgradable = computed(() => APPS.filter((a) => a.id !== "market" && card(a).canUpgrade));
  const upToDate = computed(() => APPS.filter((a) => a.id !== "market" && !card(a).canUpgrade));
  const updatableList = computed(() => upgradable.value.filter((a) => matchesQuery(a.name, descOf(a))));
  const upToDateList = computed(() => upToDate.value.filter((a) => matchesQuery(a.name, descOf(a))));

  async function loadStatuses() {
    statusBusy.value = true;
    const targets = APPS.filter((a) => a.id !== "market");
    await Promise.all(targets.map(async (a) => {
      try {
        const raw = await marketCall(UPDATE_STATUS_COMMAND, { appId: a.id });
        statuses[a.id] = raw.ok ? normalizeAppUpdateStatus(raw.value) : null;
      } catch {
        statuses[a.id] = null;
      }
    }));
    statusBusy.value = false;
    statusLoaded.value = true;
  }

  const statusCurrent = (id: string): string => {
    const status = statuses[id];
    if (!status) return "none";
    return status.current ? status.current.version : "builtin:" + status.builtinVersion;
  };
  const statusLatest = (id: string): string => {
    const status = statuses[id];
    return status && status.latest ? status.latest.version : "";
  };
  const statusChecked = (id: string): string => {
    const status = statuses[id];
    return status && status.checkedAt != null ? String(status.checkedAt) : "";
  };

  const healthRows = ref<HealthRow[]>([]);
  const healthBusy = ref(false);
  const healthRowsFiltered = computed(() => healthRows.value.filter((row) => matchesQuery(row.app.name, descOf(row.app))));
  function healthVersionText(row: HealthRow): string {
    const status = statuses[row.app.id];
    if (!status) return "—";
    if (status.current) return status.current.version;
    return t("内置 {version}", { version: status.builtinVersion });
  }
  async function loadHealthRows() {
    healthBusy.value = true;
    const rows = await Promise.all(APPS.filter((a) => a.id !== "market").map(async (a) => {
      const status = statuses[a.id] ?? null;
      try {
        const res = await marketCall("market/update/health", { appId: a.id });
        return { app: a, status, health: res.ok ? normalizeHealth(res.value) : null, error: res.ok ? null : { code: res.error, detail: res.detail } } as HealthRow;
      } catch {
        return { app: a, status, health: null, error: { code: "DXOS_ERR_INTERNAL", detail: "" } } as HealthRow;
      }
    }));
    healthRows.value = rows;
    healthBusy.value = false;
  }

  return {
    statuses, statusBusy, statusLoaded, card, upgradable, upToDate, updatableList, upToDateList,
    loadStatuses, statusCurrent, statusLatest, statusChecked,
    healthRows, healthBusy, healthRowsFiltered, loadHealthRows, healthVersionText,
  };
}
