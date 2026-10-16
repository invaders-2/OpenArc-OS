const fs=require('fs');const p=require('path');
const ROOT=p.resolve(__dirname,'../..');
const rawPath=p.join(__dirname,'deepseek.raw.svg');
let s=fs.readFileSync(rawPath,'utf8').trim();
const before=s.length;
s=s.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi,'');
s=s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi,'').replace(/\son[a-z]+\s*=\s*'[^']*'/gi,'');
s=s.replace(/javascript:/gi,'');
s=s.replace(/<image[^>]*>/gi,'');
s=s.replace(/\s(?:width|height|style)\s*=\s*"[^"]*"/gi,'');
// 去掉除 xmlns 命名空间以外的外部引用
s=s.replace(/https?:\/\/(?!www\.w3\.org\/2000\/svg)[^"'\s)]+/gi,'');
if(!/<svg/.test(s)||!/viewBox=/.test(s)){console.log('REJECT missing svg/viewBox');process.exit(2);}
if(/\swidth=|\sheight=|\sstyle=|on[a-z]+\s*=|javascript:|<script|<image|<foreignObject/i.test(s)){console.log('REJECT unsafe remnants');process.exit(3);}
const target=p.join(ROOT,'public','provider-logos','deepseek.svg');
fs.writeFileSync(target,s.trim()+'\n');
console.log('WROTE '+target+' bytes '+fs.statSync(target).size+' (raw '+before+')');
console.log('SELFCHECK viewBox='+/viewBox="([^"]+)"/.exec(s)[1]+' paths='+(s.match(/<path/g)||[]).length+' fillCurrentColor='+/fill="currentColor"/.test(s));