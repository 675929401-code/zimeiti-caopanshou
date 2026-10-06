export type DepthMention={assetId:string;label:string;start:number;end:number;status:'resolved'|'missing'};
export type DepthMentionDocument={text:string;mentions:DepthMention[]};
/** String offsets use JavaScript UTF-16 units, matching textarea selections. */
export function depthMentions(text:string,ids:string[]):DepthMentionDocument{return {text,mentions:[...text.matchAll(/@图片(\d+)/g)].map(m=>{const index=Number(m[1])-1,valid=String(index+1)===m[1]&&index>=0&&index<ids.length;return {assetId:valid?ids[index]:'',label:m[0],start:m.index!,end:m.index!+m[0].length,status:valid?'resolved':'missing'};})};}
export function editDepthMentionText(previous:DepthMentionDocument,text:string,ids:string[]):DepthMentionDocument{
 let prefix=0;while(prefix<previous.text.length&&prefix<text.length&&previous.text[prefix]===text[prefix])prefix++;
 let oldEnd=previous.text.length,newEnd=text.length;while(oldEnd>prefix&&newEnd>prefix&&previous.text[oldEnd-1]===text[newEnd-1]){oldEnd--;newEnd--;}
 const delta=newEnd-oldEnd,kept=previous.mentions.flatMap(m=>{if(m.end<=prefix)return [{...m}];if(m.start>=oldEnd)return [{...m,start:m.start+delta,end:m.end+delta}];return [];});
 const fresh=depthMentions(text,ids).mentions;return {text,mentions:fresh.map(m=>kept.find(k=>k.start===m.start&&k.end===m.end&&k.label===m.label)||m)};
}
export function rebindDepthMentions(previous:DepthMentionDocument,ids:string[],replacement?:{from:string;to:string}):DepthMentionDocument{
 let text='',cursor=0;const mentions:DepthMention[]=[];
 for(const m of previous.mentions){text+=previous.text.slice(cursor,m.start);const assetId=replacement&&m.assetId===replacement.from?replacement.to:m.assetId,index=ids.indexOf(assetId),label=index>=0?'@图片'+(index+1):m.label,start=text.length;text+=label;mentions.push({...m,assetId,label,start,end:text.length,status:index>=0?'resolved':'missing'});cursor=m.end;}
 return {text:text+previous.text.slice(cursor),mentions};
}
export function validateDepthMentions(value:unknown,text:string,ids:string[],allowMissing=false):DepthMentionDocument{
 if(!value||typeof value!=='object')throw Error('图片引用文档缺失');const d=value as DepthMentionDocument;
 if(d.text!==text||!Array.isArray(d.mentions)||d.mentions.length>100)throw Error('图片引用与正文不一致');const parsed=depthMentions(text,ids);
 if(parsed.mentions.length!==d.mentions.length)throw Error('存在未绑定的图片引用');
 d.mentions.forEach((m,i)=>{const expected=parsed.mentions[i];if(m.start!==expected.start||m.end!==expected.end||m.label!==expected.label||typeof m.assetId!=='string'||!['resolved','missing'].includes(m.status))throw Error('图片引用位置无效');if(m.status==='resolved'&&(expected.assetId!==m.assetId||!m.assetId))throw Error('图片编号与资产绑定不一致');if(!allowMissing&&m.status==='missing')throw Error('补充说明中有已失效的图片引用，请重新选择或删除');});return structuredClone(d);
}
