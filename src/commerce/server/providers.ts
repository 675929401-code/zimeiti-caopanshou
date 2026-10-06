import {chatImageBody,chatImageResult} from './chat-image-protocol';
import {consumeChatStream} from './chat-stream';
import type {Model} from './models';
import {modelSecret} from './models';
import {publicFetch} from './assets';
type ProviderFetch=typeof publicFetch;
let providerFetch:ProviderFetch=publicFetch;
/** Deterministic contract tests can replace the HTTPS transport without
 * weakening production routing or exposing a runtime API switch. */
export function setCommerceProviderFetchForTesting(next?:ProviderFetch){if(process.env.NODE_ENV!=='test')throw Error('供应商传输替身只能用于测试进程');providerFetch=next||publicFetch;}
export type ProviderInput={id:string;prompt:string;system?:string;messages?:{role:string;content:unknown}[];images:string[];audios?:string[];videos?:string[];aspectRatio?:string;resolution?:string;duration?:number;generateAudio?:boolean;responseFormat?:'json_object'};
export type ProviderResult={status:'success'|'processing'|'failed';text?:string;url?:string;videoUrl?:string;taskId?:string;pollPath?:string;usage?:unknown;};
export const PROTOCOLS=['openai-chat','anthropic','openai-image','seedream-image','secure-image-native','secure-image-async','gemini-image','chat-image','coze-workflow','volc-video','secure-video'] as const;
export function directorProviderResponseFormat(input:{kind:string;director?:string}){return input.kind==='agent'&&typeof input.director==='string'&&input.director.trim()?'json_object' as const:undefined;}
function base(model:Model){return String(model.endpoint||'').replace(/\/$/,'');}
function pixelSize(resolution='1K',ratio='1:1'){const [w,h]=ratio.split(':').map(Number);const scale=resolution==='4K'?4:resolution==='2K'?2:1;const side=1024*scale;return `${Math.round(side*Math.sqrt((w||1)/(h||1))/64)*64}x${Math.round(side*Math.sqrt((h||1)/(w||1))/64)*64}`;}
export function buildProviderRequest(model:Model,input:ProviderInput):{url:string;body:Record<string,unknown>;headers:Record<string,string>}{const root=base(model);const generic={model:model.modelName};const headers:Record<string,string>={};let url='',body:Record<string,unknown>={};const messages=input.messages||[{role:'system',content:input.system||''},{role:'user',content:input.prompt}];switch(model.protocol){case 'anthropic':{url=root.replace(/\/v1$/,'')+'/v1/messages';headers['anthropic-version']='2023-06-01';body={...generic,system:input.system||'',messages:messages.filter(m=>m.role!=='system').map(m=>({...m,content:Array.isArray(m.content)?m.content.map(p=>p.type==='image_url'?{type:'image',source:{type:'base64',media_type:p.image_url.url.split(';')[0].slice(5),data:p.image_url.url.split(',')[1]}}:p):m.content})),max_tokens:4096,stream:false};break;}case 'openai-chat':url=root+'/chat/completions';body={...generic,messages,stream:false,...(input.responseFormat?{response_format:{type:input.responseFormat}}:{})};break;case 'chat-image':url=root+'/chat/completions';body=chatImageBody(String(model.modelName),input.prompt,input.images,input.aspectRatio||'1:1',input.resolution||'1K');break;case 'gemini-image':{url=root.replace(/\/v1$/,'')+`/v1beta/models/${encodeURIComponent(String(model.modelName))}:generateContent`;body={contents:[{role:'user',parts:[{text:input.prompt},...input.images.map(image=>{const match=image.match(/^data:(image\/[^;]+);base64,(.+)$/);if(!match)throw Error('Gemini 原生参考图需要内嵌图片数据');return {inlineData:{mimeType:match[1],data:match[2]}};})]}],generationConfig:{responseModalities:['IMAGE'],imageConfig:{aspectRatio:input.aspectRatio||'1:1',imageSize:input.resolution||'2K'}}};break;}case 'secure-image-async':url=root+'/images/generations/async';body={...generic,prompt:input.prompt,n:1,image_size:input.resolution,aspect_ratio:input.aspectRatio,...(input.images.length?{image:input.images}:{})};break;case 'secure-image-native':case 'seedream-image':case 'openai-image':url=root+'/images/generations';if(input.images.some(i=>i.startsWith('data:'))&&['secure-image-native','seedream-image'].includes(model.protocol))throw Error('此接口要求公网参考图，请使用已转存的生成结果或切换 Gemini 原生协议');body={...generic,prompt:input.prompt,n:1,size:pixelSize(input.resolution,input.aspectRatio),response_format:'url',...(input.images.length?{image_urls:input.images}:{})};break;case 'secure-video':if(input.images.some(i=>!i.startsWith('https://')))throw Error('视频模型要求公网参考图；可先使用图片生成结果，或导入公网素材');url=root+'/videos';body={...generic,prompt:input.prompt,seconds:input.duration,resolution:input.resolution?.toLowerCase(),aspect_ratio:input.aspectRatio,...(input.images.length?{images:input.images}:{}),...(input.audios?.length?{audios:input.audios}:{}),...(input.videos?.length?{videos:input.videos}:{})};break;case 'coze-workflow': {
  url = root + '/async_run';
  const inputParam = String(model.capabilities?.cozeInputParam || 'input');
  let extra: Record<string, unknown> = {};
  const rawExtra = model.capabilities?.cozeExtra;
  if (rawExtra && typeof rawExtra === 'object') extra = rawExtra as Record<string, unknown>;
  else if (rawExtra) { try { extra = JSON.parse(String(rawExtra)); } catch { extra = {}; } }
  const contentParam = String(model.capabilities?.cozeContentParam || inputParam);
  body = { [inputParam]: input.prompt, ...extra };
  void contentParam;
  break;
}
case 'volc-video':url=root+'/contents/generations/tasks';body={...generic,content:[{type:'text',text:input.prompt},...input.images.map(url=>({type:'image_url',image_url:{url},role:'reference_image'})),...((input.videos||[]).map(url=>({type:'video_url',video_url:{url},role:'reference_video'}))),...((input.audios||[]).map(url=>({type:'audio_url',audio_url:{url},role:'reference_audio'})))],duration:input.duration,ratio:input.aspectRatio,resolution:input.resolution?.toLowerCase(),...(input.generateAudio!==undefined?{generate_audio:input.generateAudio}:{})};break;default:throw Error('调用协议未实现');}return {url,body,headers};}
function cozeWorkflowResult(data:Record<string,any>):ProviderResult{
  const status=String(data.status||'');
  if(['failed','cancelled','canceled'].includes(status))return {status:'failed'};
  if(status==='completed'){
    let result=data.result;
    if(typeof result==='string'){try{result=JSON.parse(result);}catch{}}
    let text='';
    if(result&&typeof result==='object'){
      if(typeof result.final_result==='string'&&result.final_result.trim())text=result.final_result;
      else if(Array.isArray(result.captions))text=result.captions.map((c:Record<string,unknown>)=>String(c.caption||c.desc||'')).filter(Boolean).join('\n\n');
    } else if(typeof result==='string'&&result.trim())text=result;
    if(text.trim())return {status:'success',text};
    return {status:'failed'};
  }
  const taskId=data.task_id||data.id;
  if(taskId)return {status:'processing',taskId:String(taskId),pollPath:'/task/'+encodeURIComponent(String(taskId))};
  return {status:'processing'};
}

export function parseProviderResult(model:Model,data:Record<string,any>):ProviderResult{
  if(model.protocol==='coze-workflow')return cozeWorkflowResult(data);
if(data.error||['failed','FAILED','cancelled','expired'].includes(data.status)||data.data?.status==='FAILED')return {status:'failed'};if(model.protocol==='chat-image'){const url=chatImageResult(data);return url?{status:'success',url,usage:data.usage}:{status:'failed'};}if(model.protocol==='anthropic'){const text=(data.content||[]).filter((p:Record<string,unknown>)=>p.type==='text').map((p:Record<string,unknown>)=>String(p.text)).join('\n');return text?{status:'success',text,usage:data.usage}:{status:'failed'};}if(model.kind==='agent'){const text=data.choices?.[0]?.message?.content;return typeof text==='string'&&text.trim()?{status:'success',text,usage:data.usage}:{status:'failed'};}const inline=data.candidates?.[0]?.content?.parts?.find((p:Record<string,any>)=>p.inlineData)?.inlineData;const url=inline?`data:${inline.mimeType};base64,${inline.data}`:data.data?.[0]?.url||(data.data?.[0]?.b64_json?`data:image/png;base64,${data.data[0].b64_json}`:'')||data.data?.result_url||data.result_url||data.video_url||data.url||data.content?.video_url||data.output?.[0]?.url;if(url)return {status:'success',...(model.kind==='image'?{url}:{videoUrl:url}),usage:data.usage};const taskId=data.task_id||data.data?.task_id||data.id;if(taskId){const encoded=encodeURIComponent(String(taskId));const pollPath=model.protocol==='secure-image-async'?`/images/async/${encoded}`:model.kind==='image'?`/images/generations/${encoded}`:model.protocol==='volc-video'?`/contents/generations/tasks/${encoded}`:`/videos/${encoded}`;return {status:'processing',taskId:String(taskId),pollPath};}if(['queued','pending','processing','in_progress','running','IN_PROGRESS','PENDING','RUNNING'].includes(data.status)||['PENDING','RUNNING','IN_PROGRESS'].includes(data.data?.status))return {status:'processing'};return {status:'failed'};}
export function providerUsesTextStream(model:Pick<Model,'kind'|'protocol'|'modelName'|'displayName'>,input:Pick<ProviderInput,'responseFormat'>,hasListener:boolean){
  if(!hasListener||input.responseFormat||model.kind!=='agent')return false;
  if(!['openai-chat','anthropic'].includes(model.protocol||''))return false;
  // NewAPI/OpenAI compatible Claude relays have returned unframed terminal
  // SSE chunks to this worker. Use non-stream JSON for those models; the
  // response contract is identical.
  if(/^claude/i.test(String(model.modelName||'')+String(model.displayName||'')))return false;
  return true;
}
export async function submitProvider(model:Model,input:ProviderInput,onText?:(text:string)=>void){const built=buildProviderRequest(model,input);if(providerUsesTextStream(model,input,Boolean(onText)))built.body.stream=true;const key=await modelSecret(model.id);const response=await providerFetch(built.url,{method:'POST',headers:{...built.headers,'Content-Type':'application/json',Authorization:`Bearer ${key}`,...(model.protocol==='anthropic'?{'x-api-key':key}:{}),...(model.protocol==='gemini-image'?{'x-goog-api-key':key}:{}),'Idempotency-Key':input.id},body:JSON.stringify(built.body)});if(!response.ok)throw Error(`模型接口返回 HTTP ${response.status}`);if(response.headers.get('content-type')?.includes('text/event-stream')&&onText)return consumeChatStream(response,model.protocol||'',onText);return parseProviderResult(model,await response.json());}
export async function pollProvider(model:Model,path:string){if(!/^\/(images\/(async|generations)|videos|contents\/generations\/tasks|task)\/[A-Za-z0-9_%.-]+$/.test(path))throw Error('任务查询路径无效');const response=await providerFetch(base(model)+path,{headers:{Authorization:`Bearer ${await modelSecret(model.id)}`}});if(!response.ok)throw Error(`任务查询返回 HTTP ${response.status}`);return parseProviderResult(model,await response.json());}
