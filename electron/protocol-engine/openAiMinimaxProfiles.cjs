"use strict";
/** 源：DXSRC/protocol-engine/openAiMinimaxProfiles.ts:1-11 */
const OPENAI_MINIMAX_VIDEO_PROFILES = [
  { id: "minimax-h3-max", label: "MiniMax H3 Max", resolutions: ["480P", "768P", "1080P"], defaultResolution: "768P", minDuration: 5 },
  { id: "minimax-h3", label: "MiniMax H3", resolutions: ["768P", "2K"], defaultResolution: "768P", minDuration: 4 },
].map((profile) => ({
  ...profile,
  limits: {
    resolution: { options: profile.resolutions, default: profile.defaultResolution },
    duration: { min: profile.minDuration, max: 15, step: 1, integer: true, default: 5 },
  },
  defaults: { resolution: profile.defaultResolution, duration: 5, aspect_ratio: "16:9" },
}));
module.exports = { OPENAI_MINIMAX_VIDEO_PROFILES };
