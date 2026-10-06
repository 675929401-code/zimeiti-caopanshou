// Scope-aware guard for the BIP suite. This is one layer, not a secrecy guarantee.
import {
 BUSINESS_IP_MEMBER_DATA_BLOCK_BEGIN,
 BUSINESS_IP_MEMBER_DATA_BLOCK_END,
} from './business-profile';

type InputMessage = {role?:string;content?:unknown};
export function messageText(content:unknown):string {
 if(typeof content==='string')return content;
 if(Array.isArray(content))return content.map(part=>part&&typeof part==='object'&&typeof part.text==='string'?part.text:'').join('\n');
 return '';
}
function normalize(text:string){return text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').replace(/\s+/g,'').toLowerCase();}
const TARGET=/(?:你的?(?:系统|隐藏|内部|初始|原始|底层|完整|全部)?(?:提示词|指令|配置|规则)|系统提示词|系统指令|隐藏指令|隐藏上下文|开发者消息|systemprompt|systemmessage|developerinstructions|your(?:prompt|instructions|configuration)|api密钥|apikey|secretkey)/i;
const EXTRACT=/(?:输出|展示|显示|给我|发给|告诉|透露|复述|重复|抄写|打印|列出|翻译|编码|base64|转码|首字|逐字|重建|还原|导出|验证|是否正确|第一句|前.{0,5}字|续写|reveal|show|repeat|print|output|translate|encode|export|extract|reconstruct)/i;
function attack(text:string){
 const n=normalize(text);
 return (TARGET.test(n)&&EXTRACT.test(n))
  || /(?:忽略|无视|覆盖|取消|绕过)(?:你|此前|之前|所有|全部|以上|的)*(?:系统|安全|保密|开发者)(?:指令|规则|限制|边界)/.test(n)
  || /(?:repeat|print|output)(?:everything|all)(?:above|before)/.test(n)
  || /(?:输出|复述|重复)(?:以上|上面)(?:全部|所有)(?:内容|文本|指令)/.test(n)
  || /(?:ignore|override)(?:all|previous|your)*(?:system|developer|safety)(?:instructions|rules)/.test(n);
}
export function checkBipInput(messages:InputMessage[]):boolean {
 const users=messages.filter(m=>m.role==='user').map(m=>messageText(m.content));
 const current=users.at(-1)||'';
 if(attack(current))return true;
 // A bounded decoder catches simple encoded instructions without executing any content.
 for(const token of current.match(/[A-Za-z0-9+/]{24,}={0,2}/g)||[]){
  if(token.length>8192)continue;
  try{if(attack(Buffer.from(token,'base64').toString('utf8')))return true;}catch{/* not base64 */}
 }
 const previous=users.at(-2)||'';
 return TARGET.test(normalize(previous)) && /^(?:继续|下一句|第二句|再给.{0,5}字|continue|nextsentence)[。.!！\s]*$/i.test(current.trim());
}
export function containsPromptLeak(output:string, systemPrompt:string):boolean {
 const text=normalize(output), hidden=normalize(stripMemberBusinessDataBlocks(systemPrompt));
 // Sliding windows catch substrings across chunk boundaries and whitespace edits.
 if(text.length<90||hidden.length<90)return false;
 for(let i=0;i<=hidden.length-90;i+=15){if(text.includes(hidden.slice(i,i+90)))return true;}
 return false;
}

function stripMemberBusinessDataBlocks(systemPrompt:string):string {
 let remaining=systemPrompt;
 let result='';
 while(true){
  const start=remaining.indexOf(BUSINESS_IP_MEMBER_DATA_BLOCK_BEGIN);
  if(start<0)return result+remaining;
  result+=remaining.slice(0,start);
  const contentStart=start+BUSINESS_IP_MEMBER_DATA_BLOCK_BEGIN.length;
  const end=remaining.indexOf(BUSINESS_IP_MEMBER_DATA_BLOCK_END,contentStart);
  // A missing closing marker is treated as untrusted member data through EOF.
  if(end<0)return result;
  remaining=remaining.slice(end+BUSINESS_IP_MEMBER_DATA_BLOCK_END.length);
 }
}
