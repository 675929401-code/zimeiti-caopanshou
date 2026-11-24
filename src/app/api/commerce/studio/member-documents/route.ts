import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {errorResponse,json} from '@/commerce/server/http';
import {runtimeDir} from '@/commerce/server/store';
import {publicAsset,storeAsset,WORD_DOCUMENT_TYPE} from '@/commerce/server/assets';
import {documentExtensions,isMemberDocumentSkill,memberDocumentActions} from '@/commerce/shared/member-documents';

export const runtime='nodejs';
export const maxDuration=180;
const execute=promisify(execFile);
const limit=16*1024*1024;
const mime:Record<string,string>={docx:WORD_DOCUMENT_TYPE,xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',txt:'text/plain',md:'text/markdown',json:'application/json'};
const running=new Set<string>();

async function boundedForm(request:Request) {
  if(Number(request.headers.get('content-length'))>limit||!request.body)throw Error('文件及参数合计最多 16 MB');
  const reader=request.body.getReader(),parts:Uint8Array<ArrayBuffer>[]=[];
  let total=0;
  try {
    for(;;){const {value,done}=await reader.read();if(done)break;total+=value.length;
      if(total>limit){await reader.cancel();throw Error('文件及参数合计最多 16 MB');}
      parts.push(new Uint8Array(value));}
  } finally{reader.releaseLock();}
  return new Response(new Blob(parts),{headers:{'Content-Type':request.headers.get('content-type')||''}}).formData();
}
export async function POST(request:Request) {
  let directory='',holder='';
  try{
    sameOrigin(request);const user=requireIdentity(request);await authorizeCurrentCommerceIdentity(user);
    if(running.has(user.id)||running.size>=3)return json({error:'文档处理正在进行，请稍后再试'},429);
    holder=user.id;running.add(holder);
    const form=await boundedForm(request);
    const field=(key:string)=>String(form.get(key)||'');
    const kind=field('kind'),action=field('action'),file=form.get('file');
    if(!isMemberDocumentSkill(kind)||!Object.hasOwn(memberDocumentActions[kind],action))return json({error:'文档操作无效'},400);
    const extension=file instanceof File?file.name.split('.').pop()?.toLowerCase()||'':'';
    if(file && (!(file instanceof File)||!file.size||!documentExtensions[kind].includes(extension)))return json({error:'请选择支持的文件格式'},400);
    if(!file&&!(kind==='spreadsheets'&&action==='write'||kind==='word-tools'&&action==='append'||kind==='wechat-docx'&&action==='url'))throw Error('请先添加源文件');
    const format=field('format')||'txt';
    if(!['md','json','txt'].includes(format))throw Error('请选择有效的导出格式');
    const options=Object.fromEntries(['content','find','paragraph','sheet','range','first','last','url'].map(key=>[key,field(key)]));
    if(Object.values(options).some(v=>v.length>100000))throw Error('输入内容过长');
    if(['append','comment'].includes(action)&&!options.content.trim())throw Error('请填写要写入的内容');
    const work=path.join(runtimeDir(),'document-work');
    await fs.mkdir(work,{recursive:true});
    directory=await fs.mkdtemp(path.join(work,'job-'));
    await fs.writeFile(path.join(directory,'request.json'),JSON.stringify({kind,action,extension,format,...options}));
    if(file instanceof File)await fs.writeFile(path.join(directory,'input'),Buffer.from(await file.arrayBuffer()));
    const binary=process.env.COMMERCE_DOCUMENT_PYTHON||path.join(runtimeDir(),'document-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const worker=path.resolve('integrations/commerce-documents/worker.py');
    try {
      await execute(binary,['-I','-B',worker],{cwd:directory,timeout:150000,maxBuffer:300000,windowsHide:true,
        env:{NODE_ENV:process.env.NODE_ENV,...Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP','LANG','LD_LIBRARY_PATH','SSL_CERT_FILE','SSL_CERT_DIR'].flatMap(k=>process.env[k]?[[k,process.env[k]!]]:[])),OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}});
    }catch(error){
      const issue=error as NodeJS.ErrnoException & {killed?:boolean};
      if(issue.code==='ENOENT')return json({error:'文档处理引擎尚未安装'},503);
      if(issue.killed)return json({error:'处理超时，请缩小页码或数据范围'},422);
      if(!(await fs.stat(path.join(directory,'result.json')).catch(()=>null)))return json({error:'文档引擎未能完成处理，请检查安装与输入文件'},422);
    }
    const report=JSON.parse(await fs.readFile(path.join(directory,'result.json'),'utf8'));
    if(report.error)return json({error:report.error},422);
    if(!report.extension)return json(report);
    const ext=String(report.extension);
    if(!Object.hasOwn(mime,ext))throw Error('无法保存该输出格式');
    const title=(field('name')||(file instanceof File?file.name.replace(/\.[^.]+$/,''):'文档')).replace(/[\\/:*?"<>|\p{Cc}]/gu,'_').trim().slice(0,92)||'文档';
    const bytes=await fs.readFile(path.join(directory,'output'));
    if(!bytes.length||bytes.length>32*1024*1024)throw Error('输出文件为空或过大');
    const name=title+'.'+ext;
    const key='member-documents/'+createHash('sha256').update(name).update('\0').update(bytes).digest('hex');
    const asset=await storeAsset(user.id,bytes,mime[ext],name,'generated',undefined,undefined,key);
    return json({...report,asset:publicAsset(asset)});
  }catch(error){return errorResponse(error);}
  finally{if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});if(holder)running.delete(holder);}
}
