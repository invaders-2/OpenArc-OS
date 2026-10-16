const fs=require('fs');const os=require('os');const p=require('path');
const txt=fs.readFileSync(p.join(os.homedir(),'.dsh','.credentials.yaml'),'utf8');
const m=txt.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?/);
if(!m){console.log('NO_KEY');process.exit(2);}
const KEY=m[1];
async function probe(base){
  const url=base.replace(/\/$/,'')+'/models';
  const t0=Date.now();
  try{
    const res=await fetch(url,{headers:{Authorization:'Bearer '+KEY}});
    const body=await res.text();
    let ids=null;try{const j=JSON.parse(body);ids=Array.isArray(j.data)?j.data.map(x=>x.id):null;}catch{}
    console.log('PROBE '+url+' status='+res.status+' ms='+(Date.now()-t0)+' ids='+JSON.stringify(ids)+' bodyHead='+body.slice(0,120));
  }catch(e){console.log('PROBE '+url+' ERROR '+(e&&e.message)+' ms='+(Date.now()-t0));}
}
(async()=>{await probe('https://api.deepseek.com');await probe('https://api.deepseek.com/v1');})();