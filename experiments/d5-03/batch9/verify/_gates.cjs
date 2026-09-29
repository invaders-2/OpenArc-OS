const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const ROOT=process.cwd();
const gates=["d4-01","d4-02a","d4-02b","d4-02c","d4-03a","d4-03b","d4-03c1","d4-03c1-closure","d4-03c2","d4-03c2-closure","d4-03c2-closure2","d4-03c2-closure3","d4-03c3","d4-03c3-closure","d4-03c4","d4-03c4-closure","d4-03c4-closure2","d4-03c4-closure3","d4-03-cg01","d4-03d","d4-03d-closure","d4-04","d4-04-closure2","d4-05","d4-06","d4-08"];
const rows=[];
for (const g of gates) {
  const dir=path.join(ROOT,"artifacts",g);
  let entries=[]; try{entries=fs.readdirSync(dir);}catch{}
  const js=entries.filter(f=>f.endsWith(".json"));
  for (const f of js) {
    const p=path.join(dir,f); const st=fs.statSync(p); const buf=fs.readFileSync(p);
    let doc=null; try{doc=JSON.parse(buf.toString());}catch{}
    rows.push({gate:g,file:f,mtime:st.mtime.toISOString(),bytes:buf.length,sha256:crypto.createHash("sha256").update(buf).digest("hex").slice(0,16),testedCommit:doc&&(doc.testedCommit||doc.openarcCommit)||null,counts:doc&&(doc.counts||doc.checksSummary)||null,verdict:doc&&(doc.verdict||doc.gate||doc.result||null)});
  }
  if (!js.length) rows.push({gate:g,file:"(no json)",mtime:null,bytes:0,sha256:null});
}
rows.sort((a,b)=>String(a.gate).localeCompare(String(b.gate)));
for (const r of rows) console.log(r.gate.padEnd(20), String(r.file).padEnd(42), String(r.mtime).padEnd(26), String(r.sha256).padEnd(18), "commit="+String(r.testedCommit).slice(0,10).padEnd(12), "counts="+JSON.stringify(r.counts));