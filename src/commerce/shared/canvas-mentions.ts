export type CanvasMention={instanceId:string|null;assetId:string|null;sourceNodeId:string|null;slot:string|null;label:string;start:number;end:number;status:'resolved'|'upload-pending'|'unassigned'|'missing'};
export type CanvasMentionDocument={version:1;text:string;mentions:CanvasMention[]};
const id=(value:unknown):string|null=>{if(value===undefined||value===null)return null;if(typeof value!=='string'||!value||value.length>160||/[\u0000-\u001f]/.test(value)||['__proto__','constructor','prototype'].includes(value))throw Error('画布引用标识无效');return value;};
const boundary=(text:string,index:number)=>index<=0||index>=text.length||!(text.charCodeAt(index-1)>=0xd800&&text.charCodeAt(index-1)<=0xdbff&&text.charCodeAt(index)>=0xdc00&&text.charCodeAt(index)<=0xdfff);
export function normalizeCanvasMentionDocument(value:unknown,text:string):CanvasMentionDocument{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('画布引用文档格式无效');const raw=value as Record<string,any>;
 if(raw.version!==1||raw.text!==text||!Array.isArray(raw.mentions)||raw.mentions.length>100)throw Error('画布引用文档与正文不一致或版本不支持');let previousEnd=0;
 const mentions:CanvasMention[]=raw.mentions.map((entry:any)=>{
  if(!entry||typeof entry!=='object'||typeof entry.label!=='string'||!entry.label||entry.label.length>80||!Number.isInteger(entry.start)||!Number.isInteger(entry.end)||entry.start<previousEnd||entry.end<=entry.start||entry.end>text.length||!boundary(text,entry.start)||!boundary(text,entry.end)||text.slice(entry.start,entry.end)!=='@'+entry.label)throw Error('画布引用的正文区间无效');
  if(!['resolved','upload-pending','unassigned','missing'].includes(entry.status))throw Error('画布引用状态无效');
  const result:CanvasMention={instanceId:id(entry.instanceId),assetId:id(entry.assetId),sourceNodeId:id(entry.sourceNodeId),slot:id(entry.slot),label:entry.label,start:entry.start,end:entry.end,status:entry.status};
  if(result.status==='resolved'&&(!result.instanceId||(!result.assetId&&!result.sourceNodeId)))throw Error('已绑定画布引用缺少明确来源');previousEnd=entry.end;return result;
 });
 return {version:1,text,mentions};
}
export function remapCanvasMentionDocument(document:CanvasMentionDocument,mapping:{nodes:Record<string,string>;assets:Record<string,string>;instances:Record<string,string>}):CanvasMentionDocument{
 const doc=normalizeCanvasMentionDocument(document,document.text);
 return {...doc,mentions:doc.mentions.map(mention=>{const instanceId=mention.instanceId?mapping.instances[mention.instanceId]||null:null,assetId=mention.assetId?mapping.assets[mention.assetId]||null:null,sourceNodeId=mention.sourceNodeId?mapping.nodes[mention.sourceNodeId]||null:null;
  const missing=mention.status!=='resolved'||!!mention.assetId&&!assetId||!!mention.sourceNodeId&&!sourceNodeId||!instanceId;
  return {...mention,instanceId,assetId:missing?null:assetId,sourceNodeId:missing?null:sourceNodeId,slot:missing?null:mention.slot,status:missing?'missing':'resolved'};
 })};
}
export function editCanvasMentionText(document:CanvasMentionDocument,text:string):CanvasMentionDocument{
 const old=normalizeCanvasMentionDocument(document,document.text);if(old.text===text)return old;
 let start=0;while(start<old.text.length&&start<text.length&&old.text[start]===text[start])start++;
 let before=old.text.length,after=text.length;while(before>start&&after>start&&old.text[before-1]===text[after-1]){before--;after--;}
 const delta=after-before;
 return {version:1,text,mentions:old.mentions.flatMap(m=>m.end<=start?[m]:m.start>=before?[{...m,start:m.start+delta,end:m.end+delta}]:[])};
}
