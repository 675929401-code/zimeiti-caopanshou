import {DIRECTOR_REFERENCE_LIMIT,type DirectorReply,type DirectorScript,type DirectorReference,type DirectorSettings,type DirectorOutputProtocol} from './director-conversation-schema';
import {assertDirectorVisibleOutputFormat} from './director-prompt-compiler';
/** Old instructions retained as source documentation; saved jobs retain their own compiled version. */
export const legacyDirectorOutputContract=`按以下层次输出可直接应用的视频脚本，内容必须服务于本次选中的编导类型，不要只给一张泛泛的镜头表。
1. 素材分析：逐个参考编号记录可见的商品/人物/环境。商品列出能看清的品牌类别、外观、配色、结构与包装文字；辨认不出的文字和规格标为待确认。人物列出外观、服装与可见姿态；场景列出空间、光线、物件和风格。
2. 创意与营销方向：明确受众、使用情境、一个主要展示重点。把创意建议与商品事实区分，不能仅凭外观推断功效、材质、价格、认证或用户体验。
3. 剧情概述：用一段话串联人物目标、商品出场、展示动作和结尾。匹配用户指定时长。
4. 素材与职责：为每个参考编号说明它提供身份、商品外观、场景、动作还是声音。指出哪些属性必须继承，哪些只是灵感；不要把白底商品照片或证件照的静止姿态和背景原样搬进动态镜头，除非用户要求保留。
5. 主体与全片设定：统一人物身份、衣物、商品大小、手持方式、连续动作、画幅、环境、时间、主光方向、色彩及镜头节奏。声音区分人声、环境声、拟音与背景音乐。
6. 逐秒分镜：从 0 秒写到指定总时长，各段连续不重叠。每段写景别、机位与运动、人物和商品动作、空间关系、归属清楚的口播/对白、环境声与音乐变化；每个镜头标注实际存在的参考编号。口播字数与时间匹配，留出自然停顿。
7. 生成约束：商品结构与文字一致，人物身份不跳变，手与商品接触合理，动作与声音同步。明确用户是否要求字幕和原口播保持，不擅自增加字幕或广告承诺。
只使用本次实际提供的参考编号；没有参考音频时不能声称已识别音色。视频如果仅提供抽帧，不得伪称听到了原台词。修订时保留用户已确认且未要求修改的设定。用户选择“应用脚本”后，下游会使用这份完整内容。`;

export const DIRECTOR_OUTPUT_PROTOCOL='director-script/v2' as const;
export const LEGACY_DIRECTOR_OUTPUT_PROTOCOL='director-script/v1' as const;
export const directorOutputContract=`
【回复业务协议 director-script/v2】仅返回一个完整 JSON 对象，不用 Markdown 代码块或额外解释。字段固定：
{"schema":"director-script/v2","replyType":"needs_input或script","skillKey":"本轮真实编导key","durationSeconds":本轮总秒数,"spokenLanguage":"本轮语言原值","generateAudio":本轮布尔值,"questions":[],"script":null或脚本对象}。
缺少会改变商品承诺、交易规则、角色职责或冲突结局的资料，replyType=needs_input，questions写1–3个必要问题，script=null。非关键风格可作明确创意建议。不要把提问写成已完成脚本。资料足够才replyType=script、questions=[]。
script对象字段固定为：title、creativeDirection、factLedger、story、setting、characters、materials、productContinuity、shots、conversionClose、preserve、forbid。title、creativeDirection、story、setting、conversionClose均为完整非空字符串；factLedger至少一项，每项为{fact:事实或明确创意,source:user或reference或creative,evidence:来源说明}；characters可为空，每项为{id,identity,appearance,wardrobe,relationships,continuity}；materials数组每个参考编号恰好一次，条目为{referenceNumber:整数,observation:可见事实字符串,inherit:[应继承内容],exclude:[不得继承内容]}；productContinuity、preserve与forbid字符串数组均至少一项。
shots每项固定为{id:不重复镜头编号,start:起始秒数,end:结束秒数,visual:具体主体与商品动作/空间关系,camera:景别机位与运动,referenceNumbers:[本镜头实际引用的整数],speech:带说话人归属的台词字符串,ambient:环境声字符串,foley:拟音字符串,music:背景音乐字符串}。无某种声音就写空字符串，generateAudio=false时四个声音字段必须全为空字符串。
镜头id严格按顺序使用「镜头N｜本镜功能标题」。从0秒连续写到本轮durationSeconds，每段end大于start，不得空隙、重叠或超过总长。素材编号严格按本轮参考素材绑定的1开始顺序；materials覆盖每个编号，各镜头只用已有编号。保留身份、服装、品牌文字、商品结构、连续动作和空间关系。没有参考时materials与镜头referenceNumbers都为空数组。generateAudio=true时全片至少要有一项明确的台词、环境声、拟音或音乐计划。
observation只列看得见且能对应到该参考的内容，不能凭外观推断功效、材质、价格、认证。creativeDirection可以提出建议，但story/setting/shots只使用确认事实与明确允许的创意，不把待确认推断写成承诺。白底、原图静止姿态和背景只有明确指定才继承到动态镜头。无字幕不意味着去掉商品标签或实体店招。
factLedger必须把用户明确事实、素材可见事实和创意设定分开；characters必须锁定每个角色身份、外观、服装、关系和跨镜连续性；productContinuity逐项锁定商品结构、包装、文字、色彩、比例和使用状态；conversionClose必须写明最终可见动作与合规转化收尾。多轮修订保留历史已确认但本轮未要求改动的条件，返回一份完整新稿，不能只返回“已修改”或差异清单。关掉配乐不等于关闭全部声音。短口播留出自然停顿。字段中不写模型ID、费用、任务ID、JSON协议说明或自评分数。
用户未明确提供的方位、材质、性能、开合难易、比例、文字细节与体验，不得标成user或reference事实，也不得在商品一致性或镜头动作中写成既定商品属性。逐镜头必须给出唯一可执行的动作和状态，不能使用“二选一”“任选”“盖回或搭在”等让下游自行选择的描述。每个镜头的口播正文按每秒最多5个汉字或等量音节编排，并为商品动作和自然停顿留出时间。
应用时服务器只编译素材职责、创意/剧情/全片设定、逐秒镜头和保持/禁止为生成正文；观察分析单独展示。它不等于已经生成视频。
`;
export class DirectorOutputError extends Error {constructor(message:string){super(message);this.name='DirectorOutputError';}}
const fail=(text:string):never=>{throw new DirectorOutputError(text);};
function record(v:unknown,keys:string[],label:string):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v))return fail(label+'必须为对象');
 const r=v as Record<string,unknown>;
 if(Object.keys(r).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(r,k)))return fail(label+'字段不完整或含未知字段');return r;
}
function text(v:unknown,label:string,max=4000,empty=false):string{if(typeof v!=='string'||v.length>max||(!empty&&!v.trim()))return fail(label+'缺少完整正文或超过长度限制');return v;}
function array(v:unknown,label:string,max:number,min=0):unknown[]{if(!Array.isArray(v)||v.length<min||v.length>max)return fail(label+'数量无效');return v;}
function lines(v:unknown,label:string,min=0){return array(v,label,30,min).map(x=>text(x,label,2000));}
function number(v:unknown,label:string){if(typeof v!=='number'||!Number.isFinite(v))return fail(label+'不是有效数字');return v;}
function referenceNumber(v:unknown,count:number){const n=number(v,'素材编号');if(!Number.isInteger(n)||n<1||n>count)return fail('脚本引用了不存在的素材编号');return n;}
export function isStructuredDirectorOutput(raw:string){return /^\s*(?:\{|\[|```(?:json)?)/i.test(raw);}

/** Pure validation against the server's actual turn context, never model-declared authority. */
export function parseDirectorOutput(raw:string,settings:DirectorSettings,references:DirectorReference[],expectedProtocol?:DirectorOutputProtocol):DirectorReply{
 if(typeof raw!=='string'||raw.length>100000)return fail('脚本回复为空或过长');
 let clean=raw.trim();if(/^```json\s/i.test(clean)&&clean.endsWith('```'))clean=clean.replace(/^```json\s*/i,'').slice(0,-3).trim();
 let parsed:unknown;try{parsed=JSON.parse(clean);}catch{return fail('回复不是完整的编导 JSON；原文已保留，请要求编导按新协议输出完整脚本');}
 const r=record(parsed,['schema','replyType','skillKey','durationSeconds','spokenLanguage','generateAudio','questions','script'],'编导回复');
 const protocol=String(r.schema) as DirectorOutputProtocol;
 if(![LEGACY_DIRECTOR_OUTPUT_PROTOCOL,DIRECTOR_OUTPUT_PROTOCOL].includes(protocol)||expectedProtocol&&protocol!==expectedProtocol||!['needs_input','script'].includes(String(r.replyType)))return fail('编导回复协议或业务类型无效');
 if(r.skillKey!==settings.skillKey||r.durationSeconds!==settings.durationSeconds||r.spokenLanguage!==settings.spokenLanguage||r.generateAudio!==settings.generateAudio)return fail('回复的编导场景、时长、语言或声音与本轮设置不一致');
 const questions=array(r.questions,'待补充问题',3).map(v=>text(v,'待补充问题',2000));
 if(r.replyType==='needs_input'){
  if(!questions.length||r.script!==null)return fail('追问必须包含问题且不能包含可应用脚本');
  return {schema:protocol,replyType:'needs_input',skillKey:settings.skillKey,durationSeconds:settings.durationSeconds,spokenLanguage:settings.spokenLanguage,generateAudio:settings.generateAudio,questions,script:null};
 }
 if(questions.length)return fail('完整脚本不能夹带尚未解决的追问');
 const v2=protocol===DIRECTOR_OUTPUT_PROTOCOL;
 const s=record(r.script,v2?['title','creativeDirection','factLedger','story','setting','characters','materials','productContinuity','shots','conversionClose','preserve','forbid']:['title','creativeDirection','story','setting','materials','shots','preserve','forbid'],'脚本');
 const factLedger=v2?array(s.factLedger,'事实台账',50,1).map(value=>{const row=record(value,['fact','source','evidence'],'事实台账');if(!['user','reference','creative'].includes(String(row.source)))return fail('事实台账来源无效');return {fact:text(row.fact,'事实台账',2000),source:row.source as 'user'|'reference'|'creative',evidence:text(row.evidence,'事实证据',2000)};}):undefined;
 const characters=v2?array(s.characters,'人物关系',10).map(value=>{const row=record(value,['id','identity','appearance','wardrobe','relationships','continuity'],'人物关系');return {id:text(row.id,'人物编号',80),identity:text(row.identity,'人物身份',1000),appearance:text(row.appearance,'人物外观',1000),wardrobe:text(row.wardrobe,'人物服装',1000),relationships:text(row.relationships,'人物关系',1000),continuity:text(row.continuity,'人物连续性',1000)};}):undefined;
 const productContinuity=v2?lines(s.productContinuity,'商品一致性',1):undefined;
 const conversionClose=v2?text(s.conversionClose,'转化收尾',2000):undefined;
 const seen=new Set<number>();const materials=array(s.materials,'素材职责',DIRECTOR_REFERENCE_LIMIT).map(v=>{
  const m=record(v,['referenceNumber','observation','inherit','exclude'],'素材职责'),n=referenceNumber(m.referenceNumber,references.length);
  if(seen.has(n))return fail('脚本重复描述同一素材编号');seen.add(n);
  return {referenceNumber:n,observation:text(m.observation,'素材观察'),inherit:lines(m.inherit,'继承内容',1),exclude:lines(m.exclude,'排除内容')};
 });
 if(seen.size!==references.length)return fail('脚本遗漏了本轮参考素材职责');
 let previous=0;const ids=new Set<string>();const shots=array(s.shots,'分镜',30,1).map((v,index)=>{
  const q=record(v,['id','start','end','visual','camera','referenceNumbers','speech','ambient','foley','music'],'分镜');
  const id=text(q.id,'镜头编号',60);if(v2&&!new RegExp(`^镜头${index+1}｜\\S+`,'u').test(id))return fail('镜头编号必须按「镜头N｜本镜功能标题」连续排列');if(ids.has(id))return fail('分镜编号重复');ids.add(id);
  const start=number(q.start,'起始时间'),end=number(q.end,'结束时间');
  if(start<0||Math.abs(start-previous)>0.000001||end<=start||end>settings.durationSeconds+0.000001)return fail('分镜时间必须从0连续到目标时长，不可空隙、重叠或超时');previous=end;
  const referenceNumbers=array(q.referenceNumbers,'分镜参考',DIRECTOR_REFERENCE_LIMIT).map(x=>referenceNumber(x,references.length));
  if(new Set(referenceNumbers).size!==referenceNumbers.length)return fail('镜头中的素材编号重复');
  const audio={speech:text(q.speech,'台词',4000,true),ambient:text(q.ambient,'环境声',2000,true),foley:text(q.foley,'拟音',2000,true),music:text(q.music,'背景音乐',2000,true)};
  if(!settings.generateAudio&&Object.values(audio).some(x=>x.trim()))return fail('无声脚本不能包含台词、环境声、拟音或音乐');
  return {id,start,end,visual:text(q.visual,'镜头动作'),camera:text(q.camera,'机位运镜'),referenceNumbers,...audio};
 });
 if(Math.abs(previous-settings.durationSeconds)>0.000001)return fail('分镜总时长与本轮目标时长不一致');
 if(v2&&settings.generateAudio&&!shots.some(shot=>[shot.speech,shot.ambient,shot.foley,shot.music].some(value=>value.trim())))return fail('有声脚本必须包含至少一项明确声音计划');
 const script:DirectorScript={title:text(s.title,'标题',200),creativeDirection:text(s.creativeDirection,'创意方向'),...(factLedger?{factLedger}:{}),story:text(s.story,'剧情概述'),setting:text(s.setting,'全片设定'),...(characters?{characters}:{}),materials,...(productContinuity?{productContinuity}:{}),shots,...(conversionClose?{conversionClose}:{}),preserve:lines(s.preserve,'保持约束',1),forbid:lines(s.forbid,'禁止约束',1)};
 for(const match of JSON.stringify(script).matchAll(/(?:@图片|参考)\s*(\d+)/g))referenceNumber(Number(match[1]),references.length);
 const reply:DirectorReply={schema:protocol,replyType:'script',skillKey:settings.skillKey,durationSeconds:settings.durationSeconds,spokenLanguage:settings.spokenLanguage,generateAudio:settings.generateAudio,questions:[],script};
 if(directorGenerationText(reply,references).length>20000)return fail('生成正文超过视频输入的20000字限制，请减少重复描述后再应用');
 return reply;
}

function spokenUnits(value:string){
 const body=value.replace(/^[^：:\n]{0,40}[：:]\s*/u,'').trim();
 const han=body.match(/[\u3400-\u9fff]/gu)?.length||0;
 const words=body.replace(/[\u3400-\u9fff]/gu,' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu)?.length||0;
 return han+words;
}

/** Deterministic quality blockers used before a director canary can be accepted. */
export function directorCanaryQualityIssues(reply:DirectorReply){
 if(reply.replyType!=='script'||!reply.script)return ['编导没有返回可应用完整脚本'];
 const issues:string[]=[];
 const unresolved=/(?:待确认|无法确认|不能确定|二选一|任选其一|任选|或(?:者)?(?:放|搭|盖|置|用|使用|选择|保持|改|换))/u;
 const emptyAudioPlaceholder=/^[\s（(]*(?:无(?:台词|对白|旁白|人声|环境声|拟音|音效|音乐|配乐|声音)?|无声|静音|none|n\/?a|not\s+applicable)[\s）)]*$/iu;
 const hasBranching=(value:string)=>value.split(/[。；;\n]/u).some((clause)=>{
  if(/(?:待确认|无法确认|不能确定|二选一|任选其一|任选)/u.test(clause))return true;
  if(!/或(?:者)?/u.test(clause))return false;
  return !/(?:不|禁止|避免|无(?:需|须|任何)?)/u.test(clause);
 });
 for(const shot of reply.script.shots){
  const seconds=shot.end-shot.start;
  const units=spokenUnits(shot.speech);
  if(units>Math.max(1,Math.floor(seconds*5)))issues.push(`${shot.id}口播约${units}个音节，超过${seconds}秒镜头的自然口播上限`);
  if(unresolved.test(`${shot.visual}\n${shot.camera}`))issues.push(`${shot.id}含二选一或待确认的生成动作`);
  for(const [label,value] of [['台词',shot.speech],['环境声',shot.ambient],['拟音',shot.foley],['背景音乐',shot.music]] as const){
   if(value.trim()&&emptyAudioPlaceholder.test(value))issues.push(`${shot.id}${label}使用无内容占位词，必须改为空字符串`);
  }
 }
 const deterministicFields:[string,string][]=[['全片设定',reply.script.setting]];
 for(const character of reply.script.characters||[]){deterministicFields.push([`${character.id}外观`,character.appearance],[`${character.id}服装`,character.wardrobe],[`${character.id}关系`,character.relationships],[`${character.id}连续性`,character.continuity]);}
 for(const [label,value] of deterministicFields){if(hasBranching(value))issues.push(`${label}含二选一或待确认状态`);}
 for(const [label,values] of [['商品一致性',reply.script.productContinuity||[]],['保持约束',reply.script.preserve]] as const){
  if(values.some(value=>unresolved.test(value)))issues.push(`${label}含二选一或待确认状态`);
 }
 return issues;
}

function directorReferenceLabel(number:number,references:DirectorReference[]){
 const reference=references[number-1];
 const media=`${reference?.type||''} ${reference?.name||''}`.toLowerCase();
 const kind=media.includes('video')||/\.(?:mp4|mov|webm|mkv)$/u.test(media)?'视频':media.includes('audio')||/\.(?:mp3|wav|m4a|aac|flac)$/u.test(media)?'音频':'图片';
 return `@${kind}${number}`;
}

function directorShotTitle(id:string,index:number){
 return id.match(/^镜头\d+｜(.+)$/u)?.[1]?.trim()||`镜头${index+1}`;
}

function directorShotText(shot:DirectorScript['shots'][number],index:number,references:DirectorReference[]){
 const referenceText=shot.referenceNumbers.length?`参考${shot.referenceNumbers.map(number=>directorReferenceLabel(number,references)).join('、')}`:'';
 const audio=[shot.music?`(${shot.music})`:'',[shot.ambient,shot.foley].filter(Boolean).length?`<${[shot.ambient,shot.foley].filter(Boolean).join('、')}>`:'',shot.speech?`{${shot.speech}}`:''].filter(Boolean).join(' ');
 const body=[shot.visual,referenceText,shot.camera,audio].filter(Boolean).join('；');
 return `**[镜头${index+1}：${shot.start}-${shot.end}s｜${directorShotTitle(shot.id,index)}]**\n\n"${body}"`;
}

/**
 * Deterministic visible/generation projection.
 *
 * The internal v2 JSON keeps stronger fact, continuity and validation fields,
 * while the public script follows the benchmark-observed five-section format.
 */
export function directorGenerationText(reply:DirectorReply,references:DirectorReference[]=[]){
 if(reply.replyType!=='script'||!reply.script)return '';
 const s=reply.script;
 const characters=s.characters?.length?s.characters.map(character=>`${character.id}（${character.identity}）：${character.appearance}；服装 ${character.wardrobe}；关系 ${character.relationships}；连续性 ${character.continuity}`).join('\n'):'本片无人物角色。';
 const keep=[s.setting,...(s.productContinuity||[]),...s.preserve].filter(Boolean).join('；');
 const output=[
  '## 剧情梗概',
  `${s.story}\n\n创意核心与风格：${s.creativeDirection}`,
  '## 素材与职责',
  ...(s.materials.length?s.materials.map(material=>{
   const label=directorReferenceLabel(material.referenceNumber,references);
   return `- ${label.replace('@','')}：${material.observation}；采用 ${material.inherit.join('；')}；不采用 ${material.exclude.join('；')||'无额外排除项'}。`;
  }):['本轮没有外部参考素材，全部画面按用户已确认的文字设定生成。']),
  '## 主体与全片设定',
  `人物与关系：\n${characters}\n\n全片保持：\n${keep}${s.conversionClose?`\n\n转化收尾：\n${s.conversionClose}`:''}\n\n声音：\n${reply.generateAudio?'按逐镜头标注同步生成人声、环境声、拟音与音乐。':'全片无声，不生成口播、音乐、环境声或拟音。'}`,
  '## 镜头 / 时间轴',
  ...s.shots.map((shot,index)=>directorShotText(shot,index,references)),
  '## 始终禁止',
  s.forbid.join('；')
 ].join('\n\n');
 return assertDirectorVisibleOutputFormat(output);
}

export function directorDisplayText(reply:DirectorReply,references:DirectorReference[]=[]){
 if(reply.replyType==='needs_input')return '请补充以下信息：\n\n'+reply.questions.map((question,index)=>`${index+1}. ${question}`).join('\n');
 return directorGenerationText(reply,references);
}
