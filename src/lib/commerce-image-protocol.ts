/** Protocol contract for the independent commerce model capability only. */
export function commerceChatImageBody(model:string,prompt:string,references:string[],ratio:string,resolution:string){
 const dimensions:Record<string,[number,number]>={'1:1':[1,1],'9:16':[9,16],'16:9':[16,9],'3:4':[3,4],'4:3':[4,3],'4:5':[4,5],'5:4':[5,4],'2:3':[2,3],'3:2':[3,2]};
 const [w,h]=dimensions[ratio]||[1,1],base=resolution==='4K'?4096:resolution==='1K'?1024:2048;
 const side=(n:number)=>Math.round(n/8)*8;const size=`${side(base*Math.sqrt(w/h))}x${side(base*Math.sqrt(h/w))}`;
 return {model,messages:[{role:'user',content:references.length?[{type:'text',text:prompt},...references.map(url=>({type:'image_url',image_url:{url}}))]:prompt}],stream:false,image_size:resolution,aspect_ratio:ratio,size,image_config:{aspect_ratio:ratio,image_size:resolution},generation_config:{image_config:{aspect_ratio:ratio,image_size:resolution}}};
}
export function commerceChatImageResult(data:Record<string,unknown>):string{
 const choices=data.choices as {message?:{content?:unknown;images?:unknown[]}}[]|undefined;const message=choices?.[0]?.message;
 const read=(value:unknown):string=>{if(typeof value==='string')return /^(https:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(value)?value:'';if(value&&typeof value==='object'){const v=value as Record<string,unknown>;for(const key of ['image_url','url']){const r=read(v[key]);if(r)return r;}if(typeof v.data==='string'&&/^[A-Za-z0-9+/=\r\n]+$/.test(v.data))return 'data:image/png;base64,'+v.data;}return '';};
 for(const item of [...(message?.images||[]),...(Array.isArray(message?.content)?message.content:[])]){const url=read(item);if(url)return url;}
 if(typeof message?.content==='string'){const direct=read(message.content.trim());if(direct)return direct;return message.content.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+|data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)\)/i)?.[1]||message.content.match(/https:\/\/[^\s"'<>]+/i)?.[0]||'';}return '';
}
