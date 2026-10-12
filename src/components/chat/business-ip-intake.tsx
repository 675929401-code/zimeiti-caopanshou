"use client";
import {useEffect,useRef,useState} from 'react';
import {useApp} from '@/contexts/app-context';
import {bipStep, BIP_STEPS} from '@/lib/business-ip/catalog';
import {
 BUSINESS_IP_CONSULTATION_AGENT_ID,
 BUSINESS_IP_PROFILE_MAX_DATA,
 businessIpProfileStatusLabel,
 extractBusinessIpProfileDataFromOutput,
 type BusinessIpMemberProfile,
 type BusinessIpProfileStatus,
} from '@/lib/business-ip/business-profile';
import {
 buildBusinessIpStepIntakeText,
 buildPositioningIntakeText,
 POSITIONING_GOALS,
 POSITIONING_GUIDED_START,
 POSITIONING_SITUATIONS,
 POSITIONING_TEMPLATE,
 positioningTemplateHasAnswers,
 positioningTemplateForSituation,
 type PositioningChoice,
} from '@/lib/business-ip/intake';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import styles from '../agent-intake.module.css';

type Field = {id:string;label:string;hint:string};
type StepIntake = {
 title:string;
 description:string;
 mainLabel:string;
 placeholder:string;
 actions:PositioningChoice[];
 secondary?:{title:string;choices:PositioningChoice[]};
 fields:Field[];
 result:string;
};

const ROLE_INTAKES:Record<string,StepIntake>={
 'agent-1787158020109-cj3wnh':{
  title:'账号主页包装 · 把定位变成主页',
  description:'有定位报告就直接粘贴；没有也可以说你准备做什么。选一个任务，其余两项都可不填。',
  mainLabel:'粘贴定位结果，或直接说你的情况',
  placeholder:'例如：我想做“不露脸的Excel职场技巧”，帮助刚入职的人解决表格返工；每周能发2条。',
  actions:[
   {value:'生成整套账号包装',label:'生成整套包装'},
   {value:'优化现有主页',label:'优化现有主页'},
   {value:'只改一个部分',label:'只改一个部分'},
  ],
  fields:[
   {id:'existing',label:'现在已有的昵称、简介或头像',hint:'有就粘贴；没有就留空。'},
   {id:'style',label:'喜欢或不想要的感觉',hint:'例如可信、亲切、不像卖课；没有偏好可留空。'},
  ],
  result:'3套有差异的包装方案、1套推荐版、头像方向与生图提示词、3条置顶内容，以及给对标研究和内容选题的接力包。',
 },
 'agent-1787163731976-5xntwm':{
  title:'对标账号拆解 · 看懂价值，学会变成自己的方法',
  description:'粘贴公开账号链接或采集资料。助手会先核对证据，再告诉你真正值得学什么、为什么适合你、怎样学习，以及今天开始做什么；没有看到的口播或画面不会假装已经分析。',
  mainLabel:'粘贴对标账号链接、采集资料或代表作品',
  placeholder:'例如：抖音分享链接、账号主页链接、DY_CAPTURE_V1 采集包，或代表作品的字幕与截图。也可以只说“我有点迷茫，请帮我判断最值得学什么”。',
  actions:[
   {value:'我有点迷茫，请综合判断这个账号最值得我学什么，并给出行动方案',label:'智能判断'},
   {value:'重点拆选题和文案，并转成适合我的练习方案',label:'选题文案'},
   {value:'重点拆拍摄和表达，并转成适合我的练习方案',label:'拍摄表达'},
   {value:'重点拆咨询和变现承接，并转成适合我的行动方案',label:'商业承接'},
  ],
  secondary:{title:'想研究多少条作品？',choices:[
   {value:'快速看10条，先找有价值的机制并给72小时行动',label:'快速10条'},
   {value:'标准看20条，比较高表现与普通作品并给14天学习与验证计划',label:'标准20条'},
   {value:'深度看30条，建立可复用的账号风格方法库和14天验证计划',label:'深度30条'},
  ]},
  fields:[
   {id:'own_goal',label:'你的账号/业务，以及现在最迷茫的地方',hint:'例如不知道该学它的选题、开头还是表达；暂时说不清也可以留空，助手会先判断。'},
   {id:'resources',label:'你能做到的方式和限制',hint:'例如能否出镜、手里有什么真实素材、每周能做几条、哪些内容不能公开；不知道就留空。'},
  ],
  result:'价值分级、账号风格方法、最值得学的一件事、3个原创练习题、72小时行动清单与7—14天验证计划，以及内容选题策划和短视频文案成稿可继续使用的原创接力包。',
 },
 'agent-1787160182534-uk29g4':{
  title:'内容选题策划 · 只决定拍什么、先拍什么',
  description:'可粘贴定位、包装或对标研究结果；本环节负责栏目、选题、顺序和创作简报，不写完整文案。资料不全也能先做。',
  mainLabel:'粘贴上一步结果，或直接说你想做的方向',
  placeholder:'例如：给苏州开荒保洁获客；夫妻两人，每周能拍3条，有施工前后照片，但不能公开顾客住址。',
  actions:[
   {value:'生成栏目、12个选题和14天试跑',label:'从头规划'},
   {value:'优化我已有的选题',label:'优化现有选题'},
   {value:'只安排发布顺序和排期',label:'只做排期'},
  ],
  fields:[
   {id:'materials',label:'手里能拍的真实素材',hint:'例如现场、案例、工具、表格或经历；没有就留空。'},
   {id:'capacity',label:'每周大概能拍几条',hint:'不知道就留空，助手会给低负担方案。'},
  ],
  result:'内容承诺、3—5个栏目、12个不同选题、优先拍的3条、每条创作简报和14天试跑排期；选中题目后再交给“短视频文案成稿”完成正文。',
 },
 'agent-bip-script-2':{
  title:'短视频文案成稿 · 把选题写成完整文案',
  description:'给一个选题、创作简报、旧稿或几条真实素材即可。可以写真人口播、不露脸解说或字幕型文案，不需要先懂文案结构。',
  mainLabel:'粘贴选题、旧稿或这次想讲的事',
  placeholder:'例如：选题Q-03“开荒保洁为什么不能只比价格”；真实素材是同一面积可能因胶渍和柜体数量不同而工时不同。',
  actions:[
   {value:'写一条全新的短视频文案',label:'写一条新稿'},
   {value:'重写我已有的文案',label:'重写现有稿'},
   {value:'同一选题写多个角度',label:'写多个角度'},
  ],
  fields:[
   {id:'facts',label:'必须使用的真实细节',hint:'经历、案例、步骤或数据；没有就留空，不能编造。'},
   {id:'format',label:'时长和表达形式',hint:'例如45秒、真人口播、不露脸解说或字幕型；不填默认按抖音自然口播处理。'},
  ],
  result:'一条可直接拍摄的完整短视频文案、2个备用开头、必要拍摄提示和事实缺口；口播/解说稿可直接朗读，字幕型按画面阅读节奏输出。',
 },
  'agent-1787160183236-5fi3w8':{
   title:'咨询回复与跟进 · 先建业务资料包，再粘贴顾客原话',
    description:'第一次使用可直接放商业IP定位和自家业务资料。平台会整理资料，并补充该细分行业需要核对的专业术语、选购适配、常见问题和风险维度，同时标明来源状态；不会替你编自家参数、价格、资质或政策。以后只需选中这项业务并粘贴顾客聊天。它不连接抖音，不会自动收发消息。',
   mainLabel:'粘贴顾客原话，或说这次想整理哪部分业务数据',
   placeholder:'回复顾客示例：顾客问“会员费多少？有案例吗？一般学多久？”\n首次整理示例：粘贴商业IP定位、主页包装、对标、选题、文案或复盘结果；顾客原话不要保存进业务资料包。',
   actions:[
    {value:'整理或更新一份标准会员业务数据包',label:'整理/更新资料包'},
   {value:'根据会员业务数据回复这一位顾客',label:'回复顾客'},
   {value:'根据会员业务数据设计后续沟通',label:'设计跟进'},
   {value:'整理一批咨询并找共性问题',label:'整理一批咨询'},
  ],
   fields:[
    {id:'businessData',label:'已整理资料包或前面环节成果',hint:'可粘贴已整理的会员业务资料包；还没整理时，也可先放商业IP定位、包装、对标、选题、文案和复盘结果。'},
    {id:'offerAndDelivery',label:'产品、服务和交付资料',hint:'产品/服务名称、套餐、价格或报价方式、规格、周期、步骤、付款、退改、售后、库存/档期；没确定的写“待确认”。'},
    {id:'industryKnowledge',label:'行业术语、材料、型号和规格',hint:'写专业名称、顾客常用叫法、材料/型号/规格、适用场景、区别、兼容性、禁忌或常见误解；可直接粘贴清单。'},
    {id:'customerEvidence',label:'匿名顾客问题和真实反馈',hint:'粘贴去掉姓名、电话、地址后的评论、私信、高频问题、顾虑、成交或流失原因。系统会区分事实与待验证信号。'},
    {id:'policy',label:'本次新增或更正的经营规则',hint:'例如案例能否公开、服务范围、承接上限、预约付款、退改售后；只写已经确定的。'},
    {id:'boundary',label:'不能承诺或需要你本人决定的情况',hint:'例如不保证流量和收益、退款争议先由你本人核实；不知道可留空。'},
   ],
   result:'首次整理会得到统一格式的《会员业务数据包》、逐项《产品/服务卡》和《行业术语与材料清单》；保存并由你绑定后，当前顾客对话会读取这项业务。粘贴顾客聊天后会形成《当前顾客咨询包》，再给可直接复制的回复、需本人核实的内容和下一步建议。平台通用调度底座始终隐藏。',
 },
 'agent-1787160184111-bj5hi3':{
  title:'运营数据复盘 · 看清哪里有效、下一轮改什么',
  description:'有数据就粘贴，没有数据也可以先建立记录表。播放、咨询、预约或成交没记的地方写“未记录”，不要填0。',
  mainLabel:'粘贴这段时间的数据和你最困惑的问题',
  placeholder:'例如：14天发6条；其中3条播放、主页访问、有效咨询分别是……预约和成交未记录；想知道下轮先改什么。',
  actions:[
   {value:'复盘现有数据并找主要问题',label:'复盘现有数据'},
   {value:'没有数据，先建立记录方法',label:'先建记录表'},
   {value:'对比两个内容或承接方案',label:'对比两个方案'},
  ],
  fields:[
   {id:'definitions',label:'数据是怎么统计的',hint:'周期、是否投流、咨询是否去重、来源是否记录；不知道可留空。'},
   {id:'question',label:'这次最想做的决定',hint:'例如下一轮先改选题、开头还是咨询回复。'},
  ],
  result:'数据可信度检查、能算的漏斗、一个主要问题、一个7—14天主实验，以及分别回流给前六个环节的修改指令。',
 },
};

function ChoiceGroup({title,choices,value,onChange,testId}:{title:string;choices:PositioningChoice[];value:string;onChange:(value:string)=>void;testId:string}) {
 return <fieldset className="space-y-2" data-testid={testId}>
  <legend className="text-sm font-semibold text-[var(--foreground)]">{title}</legend>
  <div className="grid gap-2 sm:grid-cols-2">
   {choices.map(choice=><button key={choice.value} type="button" aria-pressed={value===choice.value} onClick={()=>onChange(choice.value)} className={`rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${value===choice.value?'border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]':'border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:border-[var(--primary)]/60'}`}>{choice.label}</button>)}
  </div>
 </fieldset>;
}

export function BusinessIpIntake({agentId,conversationId,open,onClose,onPrepare,onSkip,supplement=false}:{agentId:string;conversationId?:string;open:boolean;onClose:()=>void;onPrepare:(text:string,meta?:{businessProfileId?:string})=>void|Promise<void>;onSkip?:()=>void;supplement?:boolean}) {
 const {state}=useApp();
 const [description,setDescription]=useState('');
 const [values,setValues]=useState<Record<string,string>>({});
 const [action,setAction]=useState('');
 const [secondaryAction,setSecondaryAction]=useState('');
 const [positioningSituation,setPositioningSituation]=useState('');
 const [positioningGoal,setPositioningGoal]=useState('');
 const [positioningProfile,setPositioningProfile]=useState(POSITIONING_TEMPLATE);
 const [businessProfiles,setBusinessProfiles]=useState<BusinessIpMemberProfile[]>([]);
 const [businessProfileId,setBusinessProfileId]=useState('');
 const [boundBusinessProfileId,setBoundBusinessProfileId]=useState('');
 const [businessProfileName,setBusinessProfileName]=useState('我的业务');
 const [businessProfileStatus,setBusinessProfileStatus]=useState<BusinessIpProfileStatus>('draft');
 const [businessProfileLoading,setBusinessProfileLoading]=useState(false);
 const [businessProfileLoaded,setBusinessProfileLoaded]=useState(false);
 const [businessProfileSaving,setBusinessProfileSaving]=useState(false);
 const [businessProfileSwitching,setBusinessProfileSwitching]=useState(false);
 const [businessProfilePreparing,setBusinessProfilePreparing]=useState(false);
 const [businessProfileBindingStale,setBusinessProfileBindingStale]=useState(false);
 const [businessProfileError,setBusinessProfileError]=useState('');
 const [businessProfileNotice,setBusinessProfileNotice]=useState('');
 const [businessProfileDirty,setBusinessProfileDirty]=useState(false);
 const businessProfileDirtyRef=useRef(false);
 const businessProfileSaveInFlightRef=useRef(false);
 const businessProfileSwitchInFlightRef=useRef(false);
 const prepareInFlightRef=useRef(false);
 const profileLoadRequestRef=useRef(0);
 const assistantPackageAppliedRef=useRef('');
 const step=bipStep(agentId);
 const isConsultation=agentId===BUSINESS_IP_CONSULTATION_AGENT_ID;
 const token=state.auth.token;
 const setProfileDirty=(value:boolean)=>{
  businessProfileDirtyRef.current=value;
  setBusinessProfileDirty(value);
 };
 const activeConversation=conversationId?state.conversations.find(conversation=>conversation.id===conversationId):undefined;
 const latestAssistantBusinessData=isConsultation&&conversationId
  ? [...(activeConversation?.messages||[])].reverse().reduce<string|null>((found,message)=>found||(message.role==='assistant'?extractBusinessIpProfileDataFromOutput(message.content):null),null)
  : null;

 useEffect(()=>{
  setDescription('');
  setValues({});
  setAction('');
  setSecondaryAction('');
  businessProfileDirtyRef.current=false;
  assistantPackageAppliedRef.current='';
  },[agentId]);

 useEffect(()=>{
   let cancelled=false;
   const requestId=++profileLoadRequestRef.current;
   if(!open||!isConsultation||!token){
   setBusinessProfiles([]);
   setBusinessProfileId('');
    setBusinessProfileError('');
    setBusinessProfileNotice('');
    setBusinessProfileBindingStale(false);
    setBusinessProfileLoaded(false);
    return ()=>{cancelled=true;};
   }
   setBusinessProfileLoaded(false);
   setBusinessProfileLoading(true);
  setBusinessProfileError('');
   const query=conversationId?`?conversation_id=${encodeURIComponent(conversationId)}`:'';
   void fetch(`/api/business-ip/profiles${query}`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'})
   .then(async response=>{
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||'业务资料暂时无法读取');
     if(cancelled||profileLoadRequestRef.current!==requestId) return;
      const profiles=Array.isArray(data.profiles)?data.profiles as BusinessIpMemberProfile[]:[];
      setBusinessProfiles(profiles);
      setBoundBusinessProfileId(typeof data.bound_profile_id==='string'?data.bound_profile_id:'');
      setBusinessProfileBindingStale(false);
     const current=profiles.find(profile=>profile.id===data.active_profile_id)||profiles[0];
     if(current){
      if(!businessProfileDirtyRef.current){
       setBusinessProfileId(current.id);
       setBusinessProfileName(current.name);
       setBusinessProfileStatus(current.status);
       setValues(previous=>({...previous,businessData:current.business_data,offerAndDelivery:'',industryKnowledge:'',customerEvidence:'',policy:'',boundary:''}));
       setProfileDirty(false);
      }
     }
    })
    .catch(error=>{if(!cancelled&&profileLoadRequestRef.current===requestId)setBusinessProfileError(error instanceof Error?error.message:'业务资料暂时无法读取');})
    .finally(()=>{
     if(!cancelled&&profileLoadRequestRef.current===requestId){
      setBusinessProfileLoading(false);
      setBusinessProfileLoaded(true);
     }
    });
   return ()=>{cancelled=true;};
   },[conversationId,isConsultation,open,token]);

 useEffect(()=>{
  if(!open||!isConsultation||!conversationId||!businessProfileLoaded||businessProfileLoading||!latestAssistantBusinessData)return;
  const saved=businessProfiles.find(profile=>profile.id===businessProfileId)?.business_data||'';
  if(latestAssistantBusinessData===saved){
   assistantPackageAppliedRef.current=latestAssistantBusinessData;
   return;
  }
  if(businessProfileDirtyRef.current&&assistantPackageAppliedRef.current!==latestAssistantBusinessData)return;
  if(assistantPackageAppliedRef.current===latestAssistantBusinessData)return;
  assistantPackageAppliedRef.current=latestAssistantBusinessData;
  setValues(previous=>({...previous,businessData:latestAssistantBusinessData}));
  setProfileDirty(true);
  setBusinessProfileError('');
  setBusinessProfileNotice('发现小助理刚整理好的标准业务资料包，已放进编辑框。请先核对，再点击更新；确认前不会覆盖你已保存的版本。');
 },[businessProfileId,businessProfileLoaded,businessProfileLoading,businessProfiles,conversationId,isConsultation,latestAssistantBusinessData,open]);

 const bindBusinessProfileToConversation=async(id:string)=>{
  if(!conversationId)return null;
  const response=await fetch('/api/business-ip/profiles',{
   method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
   body:JSON.stringify({id,activate:true,conversation_id:conversationId}),
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'业务资料绑定失败');
  const rebound=data.profile as BusinessIpMemberProfile|undefined;
  if(rebound)setBusinessProfiles(previous=>[rebound,...previous.filter(item=>item.id!==rebound.id)]);
  setBoundBusinessProfileId(typeof data.bound_profile_id==='string'?data.bound_profile_id:id);
  setBusinessProfileBindingStale(false);
  return data;
 };

 const activateBusinessProfile=async(id:string)=>{
   if(businessProfileSwitchInFlightRef.current)return;
   businessProfileSwitchInFlightRef.current=true;
   setBusinessProfileSwitching(true);
   setBusinessProfileId(id);
  setDescription('');
  setAction('');
  setBusinessProfileError('');
  setBusinessProfileNotice('');
  if(!id){
   setBusinessProfileName('我的业务');
   setBusinessProfileStatus('draft');
   setValues(previous=>({...previous,businessData:'',offerAndDelivery:'',industryKnowledge:'',customerEvidence:'',policy:'',boundary:''}));
    setProfileDirty(false);
    if(token&&conversationId){
    try{
     const response=await fetch('/api/business-ip/profiles',{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({unbind:true,conversation_id:conversationId})});
     const data=await response.json().catch(()=>({}));
     if(!response.ok)throw new Error(data.error||'业务资料解绑失败');
      setBoundBusinessProfileId('');
      setBusinessProfileBindingStale(false);
     setBusinessProfileNotice('当前顾客对话已解除旧业务绑定，请填写并保存新业务资料。');
    }catch(error){setBusinessProfileError(error instanceof Error?error.message:'业务资料解绑失败');}
   }
    businessProfileSwitchInFlightRef.current=false;
    setBusinessProfileSwitching(false);
    return;
  }
   const profile=businessProfiles.find(item=>item.id===id);
   if(!profile){
    businessProfileSwitchInFlightRef.current=false;
    setBusinessProfileSwitching(false);
    return;
   }
  setBusinessProfileName(profile.name);
  setBusinessProfileStatus(profile.status);
  setValues(previous=>({...previous,businessData:profile.business_data,offerAndDelivery:'',industryKnowledge:'',customerEvidence:'',policy:'',boundary:''}));
   setProfileDirty(false);
   if(!token||!conversationId){
    setBoundBusinessProfileId('');
    setBusinessProfileBindingStale(false);
    setBusinessProfileNotice(`已选择“${profile.name}”，进入小助理时会绑定到新顾客对话。`);
    setBusinessProfiles(previous=>{
     const selected=previous.find(item=>item.id===id);
     return selected?[selected,...previous.filter(item=>item.id!==id)]:previous;
    });
    businessProfileSwitchInFlightRef.current=false;
    setBusinessProfileSwitching(false);
    return;
   }
   try{
    await bindBusinessProfileToConversation(id);
     setBusinessProfileNotice(`已把“${profile.name}”绑定到当前顾客对话。`);
   setBusinessProfiles(previous=>{
    const selected=previous.find(item=>item.id===id);
    return selected?[selected,...previous.filter(item=>item.id!==id)]:previous;
   });
   }catch(error){setBusinessProfileError(error instanceof Error?error.message:'业务资料切换失败');}
   finally{
    businessProfileSwitchInFlightRef.current=false;
    setBusinessProfileSwitching(false);
   }
  };

 const saveBusinessProfile=async()=>{
   if(businessProfileSaveInFlightRef.current)throw new Error('业务资料正在保存，请稍候');
   const baseData=(values.businessData||'').trim();
   const additions=[
    ['产品、服务和交付资料',values.offerAndDelivery],
    ['行业术语、材料、型号和规格',values.industryKnowledge],
    ['匿名顾客问题和真实反馈',values.customerEvidence],
    ['经营规则',values.policy],
    ['边界与需本人决定事项',values.boundary],
   ].filter((item):item is [string,string]=>Boolean(item[1]?.trim()));
   const additionBlock=additions.length>0
    ? `【会员本次补充资料｜${new Date().toISOString()}】\n${additions.map(([label,value])=>`${label}：\n${value.trim()}`).join('\n\n')}`
    : '';
   const businessData=[baseData,additionBlock].filter(Boolean).join('\n\n');
  if(!token)throw new Error('请先登录，再保存业务资料');
  if(!businessProfileName.trim())throw new Error('请给这项业务起一个名称');
  if(!businessData)throw new Error('请先粘贴定位结果、前五环资料或已经确认的业务规则');
  businessProfileSaveInFlightRef.current=true;
  setBusinessProfileSaving(true);
  setBusinessProfileError('');
  setBusinessProfileNotice('');
  try{
   const response=await fetch('/api/business-ip/profiles',{
    method:businessProfileId?'PUT':'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      ...(businessProfileId?{id:businessProfileId}:{}),
      ...(businessProfileId?{expected_version:businessProfiles.find(item=>item.id===businessProfileId)?.version}:{}),
      name:businessProfileName,
     business_data:businessData,
      status:'draft',
    }),
   });
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(data.error||'业务资料保存失败');
   const saved=data.profile as BusinessIpMemberProfile;
   setBusinessProfileId(saved.id);
   setBusinessProfileName(saved.name);
   setBusinessProfileStatus(saved.status);
   setBusinessProfiles(previous=>[saved,...previous.filter(item=>item.id!==saved.id)]);
    setValues(previous=>({...previous,businessData:saved.business_data,offerAndDelivery:'',industryKnowledge:'',customerEvidence:'',policy:'',boundary:''}));
    setProfileDirty(false);
    if(conversationId)setBusinessProfileBindingStale(true);
    setBusinessProfileNotice(`已保存“${saved.name}”v${saved.version}，小助理会在每次回答前自动读取。`);
   return saved;
  }catch(error){
   const message=error instanceof Error?error.message:'业务资料保存失败';
   setBusinessProfileError(message);
   throw error;
   }finally{
    businessProfileSaveInFlightRef.current=false;
    setBusinessProfileSaving(false);
   }
  };

 const saveAndBindBusinessProfile=async()=>{
  let selected=businessProfiles.find(item=>item.id===businessProfileId);
  let savedNow=false;
  if(businessProfileDirty){
   try{
    selected=await saveBusinessProfile();
    savedNow=true;
   }catch{return null;}
  }
  if(!selected)return null;
  if(conversationId&&(savedNow||businessProfileBindingStale||boundBusinessProfileId!==selected.id)){
   try{
    await bindBusinessProfileToConversation(selected.id);
    setBusinessProfileNotice(`已保存并把“${selected.name}”绑定到当前顾客对话。`);
   }catch(error){
    setBusinessProfileBindingStale(true);
    setBusinessProfileError(`“${selected.name}”已保存为 v${selected.version}，但当前顾客对话绑定失败。请点击“重新绑定资料”再试；不会重复保存或覆盖新版本。${error instanceof Error?` ${error.message}`:''}`);
    return null;
   }
  }
  return selected;
 };

 const handleBusinessProfileSave=async()=>{
  if(businessProfilePreparing||businessProfileSwitching)return;
  await saveAndBindBusinessProfile();
 };

 if(step?.id===BIP_STEPS[0].id){
  const hasProfile=positioningTemplateHasAnswers(positioningProfile);
  const canSubmit=Boolean(positioningSituation||positioningGoal||hasProfile);
  const chooseSituation=(value:string)=>{
   setPositioningSituation(value);
   if(!positioningTemplateHasAnswers(positioningProfile)) setPositioningProfile(positioningTemplateForSituation(value));
  };
  const positioningExample=positioningSituation==='有实体店或本地生意'
   ? '例如：在无锡做开荒保洁，顾客常问价格和效果，有现场照片，每周能拍3条。'
   : positioningSituation==='有职业或技能想做IP'
    ? '例如：做过5年财务，擅长Excel，有表格案例，不露脸，每周能录2条。'
    : positioningSituation==='已有账号或线上业务但定位模糊'
     ? '例如：已发过30条，但来的人很杂；想保留现有昵称，重新理清人群和内容。'
     : '例如：做过8年幼师，朋友常问亲子沟通，不想让孩子出镜，每周能拍3条。';
  const submit=()=>onPrepare(buildPositioningIntakeText({situation:positioningSituation,goal:positioningGoal,profile:positioningProfile,supplement}));
  return <Dialog open={open} onOpenChange={value=>{if(!value)onClose();}}><DialogContent className={`${styles.surface} ${styles.businessSurface} flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-xl`} data-testid="business-ip-intake">
   <DialogHeader>
    <DialogTitle>{supplement?'补充你的经历或想法':'商业IP定位 · 帮你找到方向'}</DialogTitle>
    <DialogDescription>先选你的起点，下面会换成对应模板。从零个人不用先有产品；实体商家则从真实生意、顾客问题和可拍现场开始。不会的地方可以空着。</DialogDescription>
   </DialogHeader>
   <div className={`${styles.body} min-h-0 space-y-4 overflow-y-auto pr-1`}>
    <ChoiceGroup title="你现在最像哪种情况？" choices={POSITIONING_SITUATIONS} value={positioningSituation} onChange={chooseSituation} testId="positioning-situation" />
    <ChoiceGroup title="你做自媒体最想得到什么？" choices={POSITIONING_GOALS} value={positioningGoal} onChange={setPositioningGoal} testId="positioning-goal" />
    <label className="block space-y-2 text-sm">
     <span className="font-semibold text-[var(--foreground)]">照着这个模板说说你自己</span>
    <span className="block text-xs leading-5 text-[var(--text-secondary)]">知道多少写多少，写“不知道”也可以。{positioningExample}</span>
     <textarea value={positioningProfile} onChange={e=>setPositioningProfile(e.target.value)} aria-label="照着模板说说你自己" rows={6} maxLength={12000} className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-3 text-sm leading-6 outline-none focus:border-[var(--primary)]" />
    </label>
    <div className="rounded-lg bg-[var(--muted)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
     <p className="font-semibold text-[var(--foreground)]">你会得到</p>
     <p>系统会先识别你属于哪类起点，再给1个主方向、最多2个备选、适合服务的人、内容方向、商业路径、14天试跑和两张下游交接卡。</p>
     <p className="mt-1">从零个人主要看经历、特长和现实条件；实体商家主要看本地顾客的购买问题、真实现场、服务范围和承接能力，不会把两套问题混在一起。</p>
    </div>
   </div>
   <DialogFooter>
    <Button variant="outline" onClick={()=>onPrepare(POSITIONING_GUIDED_START)}>我说不清，先问我</Button>
    <Button onClick={submit} disabled={!canSubmit}>{supplement?'加入输入框':'开始定位'}</Button>
   </DialogFooter>
  </DialogContent></Dialog>;
 }

 const config=ROLE_INTAKES[agentId]||{
  title:`${step?.name||'商业IP智能体'} · 先说说你想做什么`,
  description:'选一个任务，再提供你手里已有的资料。不会的地方可以留空。',
  mainLabel:'说说这次想完成什么',
  placeholder:'可以直接用自己的话描述。',
  actions:[{value:'根据现有资料继续处理',label:'继续处理'}],
  fields:[],
  result:'本环节结果和下一环节可直接使用的接力摘要。',
 };
 const hasContent=Boolean(action||secondaryAction||description.trim()||Object.values(values).some(v=>v.trim()));
 const prepare=async()=>{
   if(prepareInFlightRef.current)return;
   prepareInFlightRef.current=true;
   setBusinessProfilePreparing(true);
   try{
   if(!hasContent){onSkip?.();return;}
   let preparedBusinessProfileId=businessProfileId||undefined;
   if(isConsultation&&(businessProfileDirty||(conversationId&&businessProfileId&&(businessProfileBindingStale||boundBusinessProfileId!==businessProfileId)))){
    const saved=await saveAndBindBusinessProfile();
    if(!saved)return;
    preparedBusinessProfileId=saved.id;
   }
  try{
   await onPrepare(buildBusinessIpStepIntakeText({
    agentId,
    action,
    secondaryAction,
    description,
    fields:[
     ...(isConsultation&&businessProfileName.trim()?[{label:'当前使用的业务档案',value:`${businessProfileName.trim()}（${businessIpProfileStatusLabel(businessProfileStatus)}）`}]:[]),
     ...(!isConsultation?config.fields.map(field=>({label:field.label,value:values[field.id]||''})):[]),
    ],
    supplement,
   }),isConsultation?{businessProfileId:preparedBusinessProfileId}:undefined);
   }catch(error){
    setBusinessProfileError(error instanceof Error?error.message:'进入小助理失败，请重试');
   }
   }finally{
    prepareInFlightRef.current=false;
    setBusinessProfilePreparing(false);
   }
  };
 const profileControlsDisabled=(isConsultation&&!businessProfileLoaded)||businessProfileLoading||businessProfileSaving||businessProfileSwitching||businessProfilePreparing;
 const needsConversationBinding=Boolean(conversationId&&businessProfileId&&(businessProfileBindingStale||boundBusinessProfileId!==businessProfileId));
 const renderField=(field:Field)=><label key={field.id} className="block space-y-1 text-sm">
   <span>{field.label} <span className="text-xs text-[var(--text-secondary)]">选填</span></span>
   <textarea value={values[field.id]||''} disabled={isConsultation&&profileControlsDisabled} onChange={e=>{setValues(v=>({...v,[field.id]:e.target.value}));if(isConsultation)setProfileDirty(true);}} aria-label={field.label} rows={field.id==='businessData'?8:field.id==='industryKnowledge'||field.id==='offerAndDelivery'||field.id==='customerEvidence'?4:2} maxLength={field.id==='businessData'?BUSINESS_IP_PROFILE_MAX_DATA:12000} placeholder={field.hint} className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--primary)] disabled:opacity-60" />
 </label>;
 return <Dialog open={open} onOpenChange={value=>{if(!value)onClose();}}><DialogContent className={`${styles.surface} ${styles.businessSurface} flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-2xl`} data-testid="business-ip-intake">
  <DialogHeader><DialogTitle>{supplement?'补充本项目资料':config.title}</DialogTitle><DialogDescription>{supplement?'已有资料不用重填，只写新增或更正；不会的地方可以留空。':config.description} 填写后先进入草稿，发送才开始分析。</DialogDescription></DialogHeader>
  <div className={`${styles.body} min-h-0 space-y-4 overflow-y-auto pr-1`}>
   {isConsultation&&<section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--muted)]/40 p-3" data-testid="business-profile-manager">
    <div><p className="text-sm font-semibold text-[var(--foreground)]">我的业务资料包</p><p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">这里保存的是你自己的业务事实，不是平台提示词。请由你本人选择要用于当前顾客对话的业务；绑定后，这个对话只读取这项业务，切换其他业务不会串档。</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm"><span>给当前顾客对话绑定哪项业务</span><select value={businessProfileId} disabled={profileControlsDisabled} onChange={event=>void activateBusinessProfile(event.target.value)} aria-label="给当前顾客对话绑定哪项业务" className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2"><option value="">新建一项业务</option>{businessProfiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name} · v{profile.version} · {businessIpProfileStatusLabel(profile.status)}{boundBusinessProfileId===profile.id&&!businessProfileBindingStale?' · 当前已绑定':''}</option>)}</select></label>
      <label className="space-y-1 text-sm"><span>这项业务叫什么</span><input value={businessProfileName} disabled={profileControlsDisabled} onChange={event=>{setBusinessProfileName(event.target.value);setProfileDirty(true);}} maxLength={80} aria-label="这项业务叫什么" placeholder="例如：抖音自媒体陪跑" className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 disabled:opacity-60" /></label>
     <div className="space-y-1 text-sm sm:col-span-2"><span>资料可用程度</span><p className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2">{businessIpProfileStatusLabel(businessProfileStatus)} <span className="text-xs text-[var(--text-secondary)]">由整理结果和关键事实完整度判断，手工补充后先回到草稿</span></p></div>
    </div>
     <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" disabled={profileControlsDisabled||(!businessProfileDirty&&!needsConversationBinding)||!(values.businessData||values.offerAndDelivery||values.industryKnowledge||values.customerEvidence||values.policy||values.boundary||'').trim()} onClick={()=>void handleBusinessProfileSave()}>{businessProfileSaving?'保存中…':!businessProfileDirty&&needsConversationBinding?'重新绑定资料':businessProfileId?'更新业务资料':'保存业务资料'}</Button><span className="text-xs text-[var(--text-secondary)]">顾客姓名、电话、地址不要放进业务资料包；每位顾客仍要单独新建对话。</span></div>
    {businessProfileNotice&&<p role="status" className="text-xs text-emerald-600">{businessProfileNotice}</p>}
    {businessProfileError&&<p role="alert" className="text-xs text-red-600">{businessProfileError}</p>}
   </section>}
   <ChoiceGroup title="这次想做什么？" choices={config.actions} value={action} onChange={setAction} testId="business-ip-action" />
   {config.secondary&&<ChoiceGroup title={config.secondary.title} choices={config.secondary.choices} value={secondaryAction} onChange={setSecondaryAction} testId="business-ip-depth" />}
   <label className="block space-y-2 text-sm font-medium"><span>{supplement?'这次补充或更正什么':config.mainLabel}</span><textarea autoFocus value={description} onChange={e=>setDescription(e.target.value)} aria-label="本环节主要资料" placeholder={config.placeholder} rows={5} maxLength={12000} className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-3 text-sm font-normal leading-6 outline-none focus:border-[var(--primary)]" /></label>
   {config.fields.length>0&&<div className="space-y-3 rounded-xl border border-[var(--border)] p-3"><p className="text-sm font-semibold">有的话再补充</p>{config.fields.map(renderField)}</div>}
   <div className="rounded-lg bg-[var(--muted)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]"><p className="font-semibold text-[var(--foreground)]">你会得到</p><p>{config.result}</p></div>
   <p className="text-xs text-[var(--text-secondary)]">不会的地方可以留空，助手只会追问会改变结果的关键信息。换客户请新建对话，避免资料混用。</p>
  </div>
  <DialogFooter>{onSkip&&<Button variant="outline" disabled={businessProfilePreparing} onClick={onSkip}>先聊再补充</Button>}<Button onClick={()=>void prepare()} disabled={!hasContent||profileControlsDisabled}>{businessProfilePreparing?'处理中…':supplement?'加入当前草稿':isConsultation?'进入小助理':'发给智能体'}</Button></DialogFooter>
 </DialogContent></Dialog>;
}
