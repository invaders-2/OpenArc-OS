"use strict";
/**
 * B3b · 能力发现授权（CJS 移植）。
 *
 * 来源：server/capabilityDiscovery.ts:1-23。
 * 逐字对应：capabilityDescriptorId 的兜底 id 形式；authorizeCapabilityDiscovery
 * 在给定 runCapabilityIds 时先过滤 descriptor，再由 descriptor 反推可授权意图。
 */

/** capabilityDiscovery.ts:3-5 */
function capabilityDescriptorId(descriptor) {
  return descriptor.capabilityId || `${descriptor.source}:${descriptor.sourceId}:${descriptor.name}`;
}

/** capabilityDiscovery.ts:7-22 */
function authorizeCapabilityDiscovery(descriptors, requestedIntents, runCapabilityIds) {
  const allowed = runCapabilityIds ? new Set(runCapabilityIds) : null;
  const authorizedDescriptors = allowed
    ? descriptors.filter((descriptor) => allowed.has(capabilityDescriptorId(descriptor)))
    : descriptors;
  const authorizedIntents = new Set(authorizedDescriptors.flatMap((descriptor) =>
    descriptor.intents && descriptor.intents.length
      ? descriptor.intents
      : [descriptor.capabilityId || `${descriptor.source}.${descriptor.name}`],
  ));
  return {
    descriptors: authorizedDescriptors,
    targetIntents: [...new Set(requestedIntents)].filter((intent) => authorizedIntents.has(intent)),
  };
}

module.exports = {
  capabilityDescriptorId,
  authorizeCapabilityDiscovery,
};
