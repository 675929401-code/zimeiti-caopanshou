const path=require('node:path'),fs=require('node:fs');
const {renderMedia,selectComposition}=require('@remotion/renderer');
async function run(){
 const work=path.resolve(process.argv[2]);
 const temp=path.join(work,'tmp');fs.mkdirSync(temp,{recursive:true});process.env.TMPDIR=temp;process.env.TMP=temp;process.env.TEMP=temp;
 const inputProps=JSON.parse(fs.readFileSync(path.join(work,'scenes.json'),'utf8'));
 const chrome=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Google/Chrome/Application/chrome.exe'):'/usr/bin/chromium');
 if(!fs.existsSync(chrome))throw Error('缺少 Chromium');
 const args={serveUrl:path.join(__dirname,'bundle'),inputProps,browserExecutable:chrome,logLevel:'error'};
 const composition=await selectComposition({...args,id:'CommerceStory'});
 await renderMedia({...args,composition,codec:'h264',disallowParallelEncoding:true,overwrite:true,concurrency:2,outputLocation:path.join(work,'output.mp4')});
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
