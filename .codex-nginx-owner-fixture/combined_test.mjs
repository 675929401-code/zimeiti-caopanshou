// Nonproduction-only: genuine Node transport + Python owner + synthetic Nginx.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {openPinnedIngressChannel} from './ingress-channel.mjs';

const TX='release1-abcdef123456';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const tag=sha(TX).slice(0,32);
export function source(site){
 const host=site==='target'?'fixturea':'fixtureb';
 const block=port=>`server {\n    listen 127.0.0.1:${port};\n    server_name ~^(${host})[.]test$;\n    location /api/ { proxy_pass http://127.0.0.1:19090; }\n    location ~ ^/api/(payment)/notify$ { proxy_pass http://127.0.0.1:19090; }\n    location / { return 301 /landing; }\n}\n`;
 return block(18080)+block(18443);
}
export function gate(site,port){
 const v=`$hold_${tag}`,method=`$method_${tag}`,canonical=`$canonical_${tag}`,p=`$path_${tag}`,m=`$path_method_${tag}`;
 return `\n        # isolated v2 candidate ${tag}\n`+
  `        set ${v} 1;\n        set ${method} 0;\n        set ${p} 0;\n`+
  `        set ${canonical} "$uri$is_args$args";\n`+
  `        if ($request_uri = ${canonical}) { set ${v} 0; }\n`+
  `        if ($uri = /api/payment/notify) { set ${p} 1; }\n`+
  ((site==='target'&&port===443)?`        if ($uri = /api/version) { set ${p} 1; }\n`:'')+
  `        if (${p} = 0) { set ${v} 1; }\n`+
  `        if ($request_method = GET) { set ${method} 1; }\n`+
  `        if ($request_method = POST) { set ${method} 1; }\n`+
  `        if (${method} = 0) { set ${v} 1; }\n`+
  `        set ${m} "$uri|$request_method";\n`+
  `        if (${m} = "/api/version|POST") { set ${v} 1; }\n`+
  `        if (${v} = 1) { return 503; }\n`;
}
export function candidate(site){
 const text=source(site);let i=0;
 return text.replace(/server \{(?=\n    listen 127\.0\.0\.1:(18080|18443);)/g,(prefix,port)=>{
  i++;return prefix+gate(site,port==='18080'?80:443);
 });
}
function request(port,host,url,method='GET'){
 return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port,path:url,method,headers:{Host:host},timeout:3000},res=>{
  let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));
 });r.on('timeout',()=>r.destroy(Error('timeout')));r.on('error',reject);r.end();});
}
function check(ok,label){if(!ok)throw Error(label);}
async function run(loss){
 check(process.platform==='linux'&&process.geteuid()===0&&fs.existsSync('/.dockerenv'),'fixture isolation required');
 check(JSON.stringify(fs.readdirSync('/sys/class/net'))===JSON.stringify(['lo']),'network isolation required');
 const root='/root/nginx-owned-fixture',live=path.join(root,'live'),base=path.join(root,'transactions'),journal=path.join(base,TX);
 fs.mkdirSync(live,{recursive:true,mode:0o700});fs.mkdirSync(journal,{recursive:true,mode:0o700});
 if(loss)fs.writeFileSync(path.join(root,'simulate-lost-ack'),'fixture only',{flag:'wx',mode:0o600});
 for(const site of ['hub','target'])fs.writeFileSync(path.join(live,site+'.conf'),source(site),{mode:0o644,flag:'wx'});
 const main=path.join(root,'nginx.conf');
 fs.writeFileSync(main,`user root;\npid ${root}/nginx.pid;\nerror_log stderr notice;\nevents { worker_connections 64; }\nhttp {\n access_log off;\n client_body_temp_path ${root}/client;\n proxy_temp_path ${root}/proxy;\n fastcgi_temp_path ${root}/fastcgi;\n uwsgi_temp_path ${root}/uwsgi;\n scgi_temp_path ${root}/scgi;\n server { listen 127.0.0.1:19090; location / { return 200 "fixture-backend"; } }\n include ${live}/hub.conf;\n include ${live}/target.conf;\n}\n`,{mode:0o644,flag:'wx'});
 const dir='/synthetic-control/bin/V1.0-aaaaaaaaaaaa';fs.mkdirSync(dir,{recursive:true,mode:0o755});
 const helper=path.join(dir,'nginx-window-helper.py');fs.copyFileSync('/fixture/combined_child_fixture.py',helper,fs.constants.COPYFILE_EXCL);fs.chmodSync(helper,0o644);
 const python=fs.realpathSync('/usr/local/bin/python3');
 const digests={sourceSha256:['hub','target'].map(k=>sha(source(k))),candidateSha256:['hub','target'].map(k=>sha(candidate(k)))};
 let started=false;
 try{
  execFileSync('/usr/sbin/nginx',['-p',root,'-c',main],{stdio:'ignore'});started=true;
  const before=await request(18443,'fixturea.test','/api/version?direct_release=fixture');check(before.status===200,'baseline version');
  let unknown=false;
  const channel=openPinnedIngressChannel({helperPath:helper,helperSha256:sha(fs.readFileSync(helper)),pythonPath:python,pythonSha256:sha(fs.readFileSync(python)),transactionId:TX,expectedDigests:digests,timeoutMs:45000,onUnknown:()=>{unknown=true;}});
  await channel.ready;
  if(loss){
   let rejected=false;try{await channel.step('install');}catch{rejected=true;}
   check(rejected&&unknown&&channel.status()==='unknown','lost acknowledgement must become UNKNOWN');
   check((await request(18443,'fixturea.test','/api/admin/models')).status===503,'hold must remain after lost acknowledgement');
   let retryRejected=false;try{await channel.step('install');}catch{retryRejected=true;}
   check(retryRejected,'retry must be rejected');
   console.log('PASS synthetic lost acknowledgement leaves UNKNOWN without replay');return;
  }
  await channel.step('install');
  for(const port of [18080,18443])for(const host of ['fixturea.test','fixtureb.test']){
   check((await request(port,host,'/api/admin/models')).status===503,'admin not held');
   check((await request(port,host,'/api/payment/notify?out_trade_no=fixture')).status===200,'payment callback');
   const version=await request(port,host,'/api/version?direct_release=fixture');
   check(version.status===((port===18443&&host==='fixturea.test')?200:503),'version scope');
   check((await request(port,host,'/api/version?direct_release=fixture','POST')).status===503,'version post');
  }
  await channel.step('verify');await channel.step('restore');await channel.close();
  check(!unknown,'unexpected UNKNOWN');
  check((await request(18443,'fixturea.test','/api/version?direct_release=fixture')).status===200,'restore version');
  for(const site of ['hub','target'])check(fs.readFileSync(path.join(live,site+'.conf'),'utf8')===source(site),'restore bytes');
  console.log('PASS synthetic node channel + journal + nginx test/reload/restore');
 }finally{
  if(started){try{execFileSync('/usr/sbin/nginx',['-p',root,'-c',main,'-s','quit'],{stdio:'ignore'});}catch{}}
 }
}
if(process.argv[2]==='--parity'){
 console.log(JSON.stringify({source:['hub','target'].map(k=>sha(source(k))),candidate:['hub','target'].map(k=>sha(candidate(k)))}));
}else if(process.argv[2]==='--fixture'||process.argv[2]==='--fixture-loss'){
 run(process.argv[2]==='--fixture-loss').catch(e=>{console.error('fixture failed:',e.message);process.exitCode=1;});
}else throw Error('fixture argument required');
