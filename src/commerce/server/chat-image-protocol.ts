import { imageTargetDimensions } from './image-output-contract';

/** Image output carried by a Chat Completions relay; distinct from Gemini native. */
export function chatImageBody(model:string,prompt:string,references:string[],ratio:string,resolution:string){
 const {width,height}=imageTargetDimensions(ratio,resolution),size=`${width}x${height}`;
 return {model,messages:[{role:'user',content:references.length?[{type:'text',text:prompt},...references.map(url=>({type:'image_url',image_url:{url}}))]:prompt}],stream:false,image_size:resolution,aspect_ratio:ratio,size,image_config:{aspect_ratio:ratio,image_size:resolution},generation_config:{image_config:{aspect_ratio:ratio,image_size:resolution}}};
}
export function chatImageResult(data:Record<string,unknown>):string{
 const choices=data.choices as {message?:{content?:unknown;images?:unknown[]}}[]|undefined,message=choices?.[0]?.message;
 function read(value:unknown):string{if(typeof value==='string'){if(/^(https:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(value))return value;if(/^iVBORw0KGgo[A-Za-z0-9+/=\s]{1000,}$/.test(value.trim()))return 'data:image/png;base64,'+value.replace(/\s/g,'');return ''}if(value&&typeof value==='object'){const v=value as Record<string,unknown>;for(const key of ['image_url','url']){const result=read(v[key]);if(result)return result;}if(typeof v.data==='string'&&/^[A-Za-z0-9+/=\r\n]+$/.test(v.data))return 'data:image/png;base64,'+v.data;}return '';}
 for(const item of [...(message?.images||[]),...(Array.isArray(message?.content)?message.content:[])]){const result=read(item);if(result)return result;}
 if(typeof message?.content==='string'){const text=message.content.trim();return read(text)||text.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+|data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)\)/i)?.[1]||'';}return '';
}
