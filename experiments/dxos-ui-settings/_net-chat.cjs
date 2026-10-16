const fs=require('fs');const os=require('os');const p=require('path');
const txt=fs.readFileSync(p.join(os.homedir(),'.dsh','.credentials.yaml'),'utf8');
const m=txt.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?/);const KEY=m[1];
async function chat(base,model){
  const t0=Date.now();
  try{
    const res=await fetch(base.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+KEY,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'只回复：ok'}],max_tokens:16,stream:false})});
    const body=await res.text();
    console.log('CHAT base='+base+' model='+model+' status='+res.status+' ms='+(Date.now()-t0)+' body='+body.slice(0,300));
  }catch(e){console.log('CHAT base='+base+' model='+model+' ERROR '+(e&&e.message));}
}
(async()=>{await chat('https://api.deepseek.com','deepseek-chat');await chat('https://api.deepseek.com','deepseek-flash');})();