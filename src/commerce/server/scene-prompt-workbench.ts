import {sceneCallChain} from './scene-call-chain';
import observed from '../components/commerce-agent/observed-catalog.json';
import {visualDirectorCatalog} from '../components/commerce-agent/personal-ip-cards';
import {IMAGE_SKILLS} from '../components/commerce-agent/catalog';
import type {ScenePromptEntry,SceneTrial} from '../shared/scene-prompt-workbench';
import {directorScenes,type DirectorScene} from '../shared/director-scenarios';
import {imageKeys} from '@/features/commerce-studio/routes';
import {directorCatalog} from './director-catalog';
import {sceneBriefContent,sceneBriefKey} from './director-scene-brief';
import {operations} from './operation-routing';
import {baselinePromptTemplates,resolveOperationPrompt} from './prompts';
import {currentPublishedCommerceConfiguration} from './configuration-platform';
import evidenceFile from './scene-prompt-evidence.json';
import auxFile from './scene-prompt-aux-trials.json';
import trialFile from './scene-prompt-trials.json';
import guidanceFile from './scene-prompt-guidance.json';

const evidence:Record<string,{guide:string[];caseStudy?:{title:string;thumb:string;reading:string;id:string};sample?:ScenePromptEntry['sample']}>=evidenceFile;
const extraTrials:Record<string,ScenePromptEntry['auxiliaryTrial']>=auxFile;
const trials:Record<string,SceneTrial[]>=trialFile;
const rules:Record<string,string[]>=guidanceFile;
const videoLesson='智能编导第 2 课，00:16 观察素材，00:33 拆解，00:48 设定创作参数，01:02 连接脚本和视频，01:18 更换商品。教程说明共用流程。';
const imageLesson='图片创作第 3 课，文字、参考图和原图分别用于生成、图生图或局部替换。按当前卡片单独检查参考职责与结果。';

export function scenePromptWorkbench():ScenePromptEntry[]{
 const config=currentPublishedCommerceConfiguration(), catalog=directorCatalog(), routes=operations(), base=baselinePromptTemplates();
 const rows:ScenePromptEntry[]=[], used=new Set<string>();
 function add(id:string,name:string,group:ScenePromptEntry['group'],category:string,operation:string,ruleId:string,observation?:string,scene?:DirectorScene){
  const route=routes.find(r=>r.id===operation);
  // Jobs resolve a card-level prompt pin for directors, and a route prompt key for images and shared actions.
  const director=operation.startsWith('director.')?config?.cards.find(c=>c.stableKey===operation.slice(9)):undefined;
  const baseKey=route?.promptId||ruleId;
  let text='',version='当前缺少执行绑定',key=scene?sceneBriefKey(scene):baseKey;
  let executorPrompt:ScenePromptEntry['executorPrompt'];
  if(scene){
   if(route){try{const source=resolveOperationPrompt(baseKey,director?.promptVersionId,config).prompt;executorPrompt={version:source.version,content:source.content};}catch{/* Leave the unresolved base visible. */}}
   const published=config?.prompts.find(p=>p.promptKey===key);
   text=sceneBriefContent(scene,config?.prompts);version=published?'场景简报 v'+published.version:'本站内置场景简报';
  }else if(route){
   try{const result=resolveOperationPrompt(baseKey,director?.promptVersionId,config);text=result.prompt.content;key=result.prompt.id;version=(result.publishedPrompt?'已发布提示词 v':'本地模板 v')+result.prompt.version;}catch{/* Show a missing binding to the operator. */}
  }
  const obs=observation?evidence[observation]:undefined;
  const ref=observed.images.find(i=>i.key===observation);
  const teacher=group==='视频场景'||ruleId==='default-director'||ruleId.startsWith('prompt-assist.')?videoLesson:
   group==='图片场景'||ref||ruleId.startsWith('detail-set.')?imageLesson:
   ruleId==='agent'?'第 1、2 课展示画布连线和智能编导使用素材、提出建议、再执行。':'视频创作第 4 课展示文字、图片、视频、声音参考进入视频工作区。';
  const sub=rules[ruleId];
  const baseline=text||base.find(p=>p.id===baseKey)?.content||'';
  const sampleTurn=observation?trials[observation]?.[0]:undefined;
  const observedForm=sampleTurn?.continuous&&['表演与台词','摄影设计','转场与配乐'].every(part=>sampleTurn.reply.includes(part))
   ?'每镜分别交代可拍动作及台词、机位与摄影、转场与声音。依场景分配镜数，首尾相接至目标时长。局部改稿核对上下镜依赖；只改指定镜与受其影响的指代或动作。':'';
  const extra=sub?['拆解要求',sub[1],'关键信息不足时，优先围绕本问题澄清：'+sub[0],observedForm].filter(Boolean).join('\n'):'';
  const proposed=extra&&!baseline.includes(extra)?[baseline,extra].filter(Boolean).join('\n\n'):baseline;
  const sources:string[]=[];
  if(obs)sources.push(group==='视频场景'?'现版会员逐卡开场与六项建议（2026-11-19 UTC）。':'现版会员素材槽位、输入引导和示例说明（2026-11-20 核对）。');
  if(obs?.caseStudy)sources.push('对标发现页参考作品：'+obs.caseStudy.title+'。'+obs.caseStudy.reading+' 案例页面未标明执行编导，按表现手法关联。');
  if(ref?.example?.title)sources.push('官方效果示例：'+ref.example.title+'。'+ref.example.description);
  if(!obs?.sample&&!(observation&&trials[observation]))sources.push('本页尚未登记此项的独立对标输出样本。');
  rows.push({id,name,group,category,operation,calls:sceneCallChain(operation,routes),key,executorPrompt,model:route?.modelId||'',effective:text,effectiveVersion:version,proposed,teacher,evidence:sources,guide:obs?.guide||[],sample:obs?.sample,
   example:ref?.example?.images.length?ref.example:obs?.caseStudy?{title:obs.caseStudy.title,description:obs.caseStudy.reading,images:[obs.caseStudy.thumb]}:undefined,test:sub?.[2]||'更换一项输入，核对输出、引用和未改内容。',auxiliaryTrial:extraTrials[id],trials:observation?trials[observation]:undefined,stages:route?.stages||[]});
  used.add(operation);
 }
 for(const card of [...visualDirectorCatalog].filter(c=>!c.default).sort((a,b)=>a.sortOrder-b.sortOrder)){
  const special=(Object.keys(directorScenes) as DirectorScene[]).find(s=>directorScenes[s].cardKey===card.key);
  const current=catalog.find(c=>c.key===card.key);
  const fallback=special&&(!current||current.name!==card.name)?special:undefined;
  add('video/'+card.key,card.name,'视频场景',card.category,'director.'+(fallback?'default-director':card.key),card.key,card.key,fallback);
 }
 for(const skill of IMAGE_SKILLS){
  const ref=observed.images.find(i=>i.name===skill.name||skill.id==='default'&&i.default);
  add('image/'+skill.id,skill.name,imageKeys[skill.id]?'图片场景':skill.canvasOnly?'画布专用':'共用能力',skill.category,'image.'+skill.id,skill.id,ref?.key);
 }
 for(const route of routes){
  const isDirector=route.id.startsWith('director.'),card=isDirector?catalog.find(c=>c.key===route.id.slice(9)):undefined;
  if(used.has(route.id)&&card?.key!=='default-director')continue;
  const name=card?.default?'通用编导':card?card.name:route.label;
  add('operation/'+route.id,name,'共用能力',card&&!card.default?'已有编导版本':route.kind==='agent'?'分析与编导':'媒体生成',route.id,card&&observed.directors.some(c=>c.key===card.key&&c.name!==card.name)?'legacy.'+card.key:card?.key||route.promptId);
 }
 return rows;
}
