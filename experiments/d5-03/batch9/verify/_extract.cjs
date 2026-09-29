const j=require("../../../../artifacts/d5-03/runs/20260929T094444Z-3a33-batch9-harness-timeout-ui/batch9-harness-timeout-ui.json");
console.log("runId:",j.runId,"| commit:",j.testedCommit,"| counts:",JSON.stringify(j.counts),"| exit:",j.exitCode);
console.log("=== screenshots ===");
for (const s of j.screenshots) console.log(" ",s.file,s.width+"x"+s.height,s.bytes+"B",s.sha256.slice(0,16),s.kind==="clip"?JSON.stringify(s.clip):"");
console.log("=== baseline ===");
console.log(JSON.stringify(j.baseline),JSON.stringify(j.measurements.baselineZoom));
for (const k of ["light-start","light-turn","dark-start","dark-turn","dark-reduced-turn"]) {
  const m=j.measurements[k];
  console.log("=== "+k+" ===");
  console.log(" errorText="+JSON.stringify(m.errorText)+" status="+JSON.stringify(m.statusText));
  console.log(" rects="+JSON.stringify({err:m.rects.error,state:m.rects.state,panel:m.rects.panel,run:m.rects.run,cancel:m.rects.cancel}));
  console.log(" overflow="+JSON.stringify({state:m.overflow.state,panel:m.overflow.panel}));
  console.log(" lines="+JSON.stringify({err:m.lines.error,stateLines:m.lines.state.lineCount,stateWidest:m.lines.state.widestLine}));
  console.log(" style="+JSON.stringify({color:m.style.color,fontSize:m.style.fontSize,fontWeight:m.style.fontWeight,lineHeight:m.style.lineHeight,animationName:m.style.animationName,transitionDuration:m.style.transitionDuration,transitionProperty:m.style.transitionProperty,durQuickEl:m.style.tokDurQuickElement,rootDurQuick:m.tokens.rootDurQuick}));
}
console.log("=== contrast ===");
for (const [k,v] of Object.entries(j.measurements)) { if (v && v.selector === "[data-ai-error]") console.log(" ",k,JSON.stringify({ratio:v.ratio,specifiedRatio:v.specifiedRatio,bg:v.modeRgb,text:v.textRgb,modeShare:v.modeShare,fontSize:v.style.fontSize,fontWeight:v.style.fontWeight,threshold:v.threshold,pass:v.pass,px:v.pixelSize})); }
console.log("=== console gap ===");
console.log(JSON.stringify(j.measurements.consoleGap).slice(0,1200));
console.log("=== notVerified ==="); console.log(JSON.stringify(j.notVerified));
console.log("=== observations ==="); console.log(JSON.stringify(j.observations));
console.log("=== cleanup ==="); console.log(JSON.stringify(j.cleanup));
console.log("=== srcFp ==="); console.log(JSON.stringify(j.sourceFingerprint.files));