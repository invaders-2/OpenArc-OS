"use strict";
/**
 * B3c · Agent 模型回退（有序路由链）。
 *
 * 逐字移植 server/agent-runtime/modelFallback.ts:1-35。
 * 语义：只包住"一次模型推理"，工具在返回前不执行，因此切换路由不会重复副作用；
 * 路由用尽仍失败则抛最后一个错误，绝不静默降级到假结果。
 * 注：源 modelFallback.ts 不 import apiQuota/云计费，故本文件无需删除计费调用。
 */

/** 源 modelFallback.ts:1-11。传输类错误 + 聚合器把"无可用路由"报成 400 的情况。 */
function isTransientAgentModelError(error) {
  if (error && error.name === "AbortError") return false;
  const message = String((error && error.message) || error).toLowerCase();
  const transientTransport = /(http\s*(?:408|409|425|429|5\d\d)|system_disk_overloaded|disk overloaded|overloaded|timeout|timed out|econnreset|econnrefused|fetch failed|network)/.test(message);
  // 某些聚合器把"模型已下线 / 无路由"报成 HTTP 400。这是路由级可用性问题，
  // Agent 必须继续走用户配置的有序模型链（源注释）。
  const unavailableRoute = /(has\s*no\s*provider\s*supported|no\s*provider\s*(?:is\s*)?supported|model[_\s-]*unavailable|model\s*(?:id\s*)?.*?(?:not\s*found|does\s*not\s*exist|is\s*not\s*available)|too many images|only supports? (?:one|1) image|multiple images? (?:are )?not supported|max(?:imum)? images?|模型不存在|模型未开放|未配置可用路由|不支持该模型|最多支持\s*\d+\s*(?:张|个)?图片|仅支持单图|不支持多图)/.test(message);
  return transientTransport || unavailableRoute;
}

/**
 * 源 modelFallback.ts:17-35。
 * input: { routes, invoke(route, onDelta), onDelta? }
 * invoke 的增量先在本地缓冲，只有该路由最终成功才向 onDelta 下发，避免回退时出现半截文本。
 */
async function runWithAgentModelFallback(input) {
  const routes = input && input.routes ? input.routes : [];
  if (!routes.length) throw new Error("没有可用的 Agent 模型路由");
  let lastError;
  for (let index = 0; index < routes.length; index += 1) {
    const bufferedDeltas = [];
    try {
      const result = await input.invoke(routes[index], (delta) => bufferedDeltas.push(delta));
      if (bufferedDeltas.length) input.onDelta?.(bufferedDeltas.join(""));
      return result;
    } catch (error) {
      lastError = error;
      if (!isTransientAgentModelError(error) || index === routes.length - 1) throw error;
    }
  }
  throw lastError || new Error("Agent 模型调用失败");
}

module.exports = { isTransientAgentModelError, runWithAgentModelFallback };
