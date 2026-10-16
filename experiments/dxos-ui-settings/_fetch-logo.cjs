const fs=require('fs');const p=require('path');
const url='https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/deepseek.svg';
const outFile=p.join(__dirname,'deepseek.raw.svg');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  for(let i=1;i<=3;i++){
    try{
      const res=await fetch(url,{redirect:'follow'});
      const body=await res.text();
      console.log('TRY '+i+' status='+res.status+' bytes='+Buffer.byteLength(body));
      if(res.ok && body.length>50 && body.includes('<svg')){
        fs.writeFileSync(outFile,body);
        console.log('OK saved '+outFile+' head='+JSON.stringify(body.slice(0,200)));
        return;
      }
      console.log('bodyHead='+JSON.stringify(body.slice(0,120)));
    }catch(e){console.log('TRY '+i+' ERROR '+(e&&e.message));}
    if(i<3) await sleep(4000);
  }
  console.log('FAILED all tries');
})();