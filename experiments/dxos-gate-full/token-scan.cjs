const fs = require('fs');
const path = require('path');
const roots = ['src', 'src-vue'];
const exts = new Set(['.css', '.scss', '.vue', '.ts', '.tsx', '.js', '.mjs']);
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (exts.has(path.extname(e.name))) out.push(p);
  }
  return out;
}
const files = [];
for (const r of roots) if (fs.existsSync(r)) walk(r, files);
const defined = new Set();
const used = new Map();
const varRe = /var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g;
const defRe = /(--[A-Za-z0-9_-]+)\s*:/g;
for (const f of files) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    let m;
    defRe.lastIndex = 0;
    while ((m = defRe.exec(line))) defined.add(m[1]);
    varRe.lastIndex = 0;
    while ((m = varRe.exec(line))) {
      const tok = m[1];
      if (!used.has(tok)) used.set(tok, []);
      used.get(tok).push({ file: f, line: i + 1, fallback: m[2] === ',' });
    }
  });
}
const pub = [];
(function walk2(dir){ if(!fs.existsSync(dir))return; for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name); if(e.isDirectory())walk2(p); else if(exts.has(path.extname(e.name)))pub.push(p);} })('public/novai-canvas');
for (const f of pub) for (const line of fs.readFileSync(f,'utf8').split('\n')) { let m; defRe.lastIndex=0; while((m=defRe.exec(line))) defined.add(m[1]); }
for (const f of ['index.html','vue.html']) if (fs.existsSync(f)) for (const line of fs.readFileSync(f,'utf8').split('\n')) { let m; defRe.lastIndex=0; while((m=defRe.exec(line))) defined.add(m[1]); }
const undef = [];
for (const [tok, arr] of used) if (!defined.has(tok)) undef.push([tok, arr]);
undef.sort((a,b)=>a[0].localeCompare(b[0]));
console.log('files scanned: ' + files.length + ' | used tokens: ' + used.size + ' | defined tokens: ' + defined.size);
console.log('=== used but NEVER defined (' + undef.length + ') ===');
for (const [tok, arr] of undef) {
  const noFb = arr.filter(x=>!x.fallback).length;
  console.log(tok + '  [' + arr.length + ' uses, ' + noFb + ' without fallback]');
  for (const x of arr.slice(0,8)) console.log('    ' + x.file + ':' + x.line + (x.fallback?' (has fallback)':' *** NO FALLBACK ***'));
}
