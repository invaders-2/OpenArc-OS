const fs=require('fs');const os=require('os');const p=require('path');
const f=p.join(os.homedir(),'.dsh','.credentials.yaml');
if(!fs.existsSync(f)){console.log('MISSING '+f);process.exit(0);}
const txt=fs.readFileSync(f,'utf8');
console.log('SIZE '+txt.length);
for(const line of txt.split(/\r?\n/)){
  if(!line.trim()) continue;
  const m=line.match(/^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/);
  if(!m){console.log('LINE(other) '+line.slice(0,40));continue;}
  const key=m[2], val=m[3];
  const v=val.trim().replace(/^["']|["']$/g,'');
  console.log('KEY '+m[1]+key+' = '+(v?('<'+v.length+' chars, prefix='+v.slice(0,3)+'>'):''));
}