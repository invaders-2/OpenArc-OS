/**
 * D4-04 Closure-2 · 唯一 production runtime boot（真实 main 与 D4-04 probe 共享）。
 *
 * 永久规则：
 *   **No Task admission before Model Proxy boot has been attempted
 *   against the actual created identity runtime.**
 *
 * 为什么单独成文件：
 *   真实 electron/main.cjs 与 probe host 若各写一遍 boot 顺序，就会再次漂移
 *   （上一轮真实 main 曾在 identity 创建之前调用 modelProxy.start()，异常被
 *   `catch {}` 吞掉 —— Model Proxy 从未真正启动）。因此顺序与装配只允许存在一份。
 *
 * 本 helper 只做：createIdentityService → 对**真实已创建的 identity** 尝试 modelProxy.start()
 *   → 返回 safe boot evidence。它不注册 IPC、不创建窗口、不执行 Task。
 *
 * 失败边界：
 *   · identity 未创建 / 没有 modelProxy.start → 抛 OPENARC_ASSEMBLY_ORDER_VIOLATION（loud，
 *     绝不被当成 "provider unavailable"）；
 *   · modelProxy.start() 真实启动失败 → 记录 safe errorCode（started=false），
 *     Harness 之后自行 fail closed。
 */
"use strict";
const { createIdentityService } = require("./identity-bootstrap.cjs");

const BOOT_STEP = Object.freeze({
  IDENTITY_CREATED: "identity_created",
  PROXY_START_ATTEMPTED: "model_proxy_start_attempted",
  PROXY_STARTED: "model_proxy_started",
  RUNTIME_READY: "runtime_ready",
});

const ASSEMBLY_ORDER_VIOLATION = "OPENARC_ASSEMBLY_ORDER_VIOLATION";

function assemblyOrderViolation(detail) {
  const err = new Error(ASSEMBLY_ORDER_VIOLATION + ": " + detail);
  err.code = ASSEMBLY_ORDER_VIOLATION;
  return err;
}

/**
 * 对**真实已创建的 identity runtime**尝试启动 Model Proxy。
 * identity 不存在（= 编程顺序错误）时 loud fail，绝不静默吞掉。
 */
async function startProductModelProxy(identity) {
  if (!identity || typeof identity !== "object" || !identity.modelProxy || typeof identity.modelProxy.start !== "function") {
    throw assemblyOrderViolation("modelProxy.start attempted before identity runtime was created");
  }
  await identity.modelProxy.start();
  return { started: !!identity.modelProxy.baseUrl, baseUrl: identity.modelProxy.baseUrl || null };
}

/**
 * 真实 production boot：main 与 probe 的唯一入口。
 * 返回前保证：identity 已创建 + Model Proxy start 已尝试 + Task/Orchestrator 装配就绪。
 */
async function createOpenArcRuntime({
  userDataDir,
  safeStorage = null,
  nativeImage = null,
  allowAdmin = false,
  serviceIdentity = null,
  logger = null,
  executorLauncher = null,
  executorTestHook = null,
  now = null,
} = {}) {
  if (!userDataDir) throw new Error("createOpenArcRuntime 需要 userDataDir");
  const bootOrder = [];
  const identity = createIdentityService({
    userDataDir,
    safeStorage,
    nativeImage,
    allowAdmin,
    serviceIdentity,
    logger,
    executorLauncher,
    executorTestHook,
  });
  bootOrder.push(BOOT_STEP.IDENTITY_CREATED);
  if (!identity || !identity.modelProxy || typeof identity.modelProxy.start !== "function") {
    throw assemblyOrderViolation("created identity has no modelProxy.start");
  }
  const readyAt = typeof now === "function" ? now() : Date.now();
  bootOrder.push(BOOT_STEP.PROXY_START_ATTEMPTED);
  const modelProxyStart = { attempted: true, started: false, errorCode: null };
  try {
    const res = await startProductModelProxy(identity);
    modelProxyStart.started = res.started === true;
    if (!modelProxyStart.started) modelProxyStart.errorCode = "MODEL_PROXY_NOT_LISTENING";
  } catch (e) {
    if (e && e.code === ASSEMBLY_ORDER_VIOLATION) throw e;
    modelProxyStart.errorCode = "MODEL_PROXY_START_FAILED";
  }
  if (modelProxyStart.started) bootOrder.push(BOOT_STEP.PROXY_STARTED);
  // Task bundle / orchestrator 在 createIdentityService 内已装配完成；此处标记 runtime 可用。
  bootOrder.push(BOOT_STEP.RUNTIME_READY);
  const listening = !!(identity.modelProxy.server && identity.modelProxy.baseUrl);
  let taskAdmissions = 0;
  return {
    identity,
    modelProxyStart,
    bootOrder,
    readyAt,
    modelProxyListening: listening,
    /** host 在接受第一个 task/run 之前调用；返回该 admission 的 boot 证据。 */
    noteTaskAdmission() {
      taskAdmissions += 1;
      return {
        index: taskAdmissions,
        afterProxyStartAttempt: modelProxyStart.attempted === true,
        afterProxyStart: modelProxyStart.started === true,
        afterRuntimeReady: bootOrder.includes(BOOT_STEP.RUNTIME_READY),
      };
    },
    snapshot() {
      return {
        identityCreated: bootOrder.includes(BOOT_STEP.IDENTITY_CREATED),
        modelProxyStartAttempted: modelProxyStart.attempted === true,
        modelProxyStarted: modelProxyStart.started === true,
        modelProxyListening: listening,
        modelProxyErrorCode: modelProxyStart.errorCode,
        bootOrder: bootOrder.slice(),
      };
    },
  };
}

module.exports = { createOpenArcRuntime, startProductModelProxy, BOOT_STEP, ASSEMBLY_ORDER_VIOLATION };
