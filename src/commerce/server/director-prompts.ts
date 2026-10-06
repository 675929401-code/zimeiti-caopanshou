import {directorOutputContract} from './director-output';
import {directorCatalog} from './director-catalog';
import {directorCorePrompt} from './director-core-prompt';
import {compileDirectorPromptLayers} from './director-prompt-compiler';
const rules:Record<string,string>={
 'ecommerce-spoken-selling':'以可信的真人推荐为主线，呈现面对面闺蜜分享的笃定语气，拒绝推销感与夸张叫卖。先确定一个受众、具体使用困扰和有资料支持的展示重点；把使用动作、口播句、可见证据逐一对应。镜头数量按共同的目标时长容量表决定，每个镜头承担一个明确叙事功能（如截停痛点、展示动作、可见证据、锁定人群与购买建议）。素材职责必须写明参考图采用什么（如瓶身设计、文字排版）与不采用什么（如白底抠图光影）。台词为中文短句、口语化、留自然停顿；功效表述不使用极限词，严格贴合真实使用体验。只有用户确认的体验可写为亲历，外观不能证明香味、持久度或功效。缺少影响承诺的资料先追问。',
 'ecommerce-promotion-conversion':'先核对用户已给出的价格、币种、活动期限、适用对象、权益限制与购买入口；缺少影响促销承诺的资料先追问。选一项真实利益开场，用商品演示说明用途，结尾只给一个已存在的购买动作。不能用虚构原价、库存、全网最低、限时或包邮制造紧迫感。时长放不下条件时减少卖点，不删除限制。局部改价需同时清除旧价、旧赠品和冲突台词。',
 'ecommerce-scene-seeding':'从具体生活场景和自然动作开始，把商品融入真实使用过程，以使用变化表达价值，避免堆砌口号。',
 'ecommerce-pain-point-solution':'先展示可观察的困扰，再逐步展示解决动作和结果。对比画面使用相同条件，避免虚构功效。',
 'ecommerce-function-demo':'围绕一个核心功能拆解操作步骤，写清手部动作、商品位置、细节特写和可见反馈，保持结构一致。',
 'local-store-discovery':'从真实门头、环境或招牌项目切入，给出具体到店理由；地址、营业时间、价格缺失时不编造。',
 'local-store-visit-record':'先把门头、前台、体验区、离店路线各参考图分配到具体镜头，列采用与不采用内容。按人物来店目标组织到达、进入、体验、离店建议，保持人物衣物、物件和空间路线连续。可见环境与角色感受分开，情境演示不能冒充真实客户评价；缺资料不补出独立包间、安静程度、服务步骤或疗效。无叠加字幕仍保留实体店招与商品标签。',
 'local-store-signature-experience':'聚焦一个招牌项目，展示制作或体验过程，使用细节与反应证明体验价值。',
 'local-store-group-buy-conversion':'逐项核对套餐内容与份数、适用人数、价格、有效期、预约规则、不可用日期、核销和购买路径。未知不能默认不限、无需预约或节假日通用，不能凭盘数猜套餐人数。用实际菜品或项目图展示权益，再给选择理由与一个真实入口；手机示意画面不等于已接支付。修订规则时保留未改事实，清除旧价格和旧限制。关键条件放不下就减少卖点，不隐去限制。',
 'advertising-brand-proposition':'确定一句清晰的品牌主张，用人物行为和视觉证据支持，结尾回收主张，不生成无依据的品牌历史。',
 'advertising-brand-story':'以人物目标、具体事件、转折和品牌价值构成故事；将事实与创意设定区分。',
 'advertising-lifestyle':'用连贯生活片段、环境氛围和自然商品使用表现生活方式，统一色彩与节奏。',
 'advertising-creative-concept':'用一个可拍摄的视觉创意贯穿全片，明确设定、变化和记忆点；创意画面仍保持商品外形。',
 'short-drama-dialogue':'明确两个人物的目标与冲突，用简短对白和反应镜头推进；写清人物身份、位置和台词归属。',
 'short-drama-reversal':'先确定人物A想要什么、B实际在做什么、观众先看见哪部分，建立具体预期。把可见伏笔绑定前段物件或动作，末尾重新解释同一线索；不得靠突然加入新人物或事实反转。每个角色有清楚的目标、站位、动作与台词归属，脸、发型和服装不互换。用最后的可见动作兑现反转，旁白解释不能代替回收。商品仅按明确要求参与事件，不能中断剧情硬插功效。',
 'short-drama-suspense':'开场提出具体疑问，中段逐步揭示线索，在限定时长内完成有因果的揭晓。',
 'short-drama-emotional':'先明确人物关系、具体压力、双方目标和情绪起点/终点，把感动或释怀转成可见行动、停顿、眼神、接触与空间变化。用合理关怀行动推动变化，商品仅作允许道具或已确认用途，不凭神奇功效换取和解。哭泣拥抱与相视微笑是不同终点，严格兑现用户指定结尾。保持角色衣发和商品不变；关闭全部声音时用动作保留情绪节奏，仅关闭配乐时保留被要求的人声和环境层。',
 'short-drama-product-placement':'先让人物目标推动故事，再让商品参与解决一个具体问题，避免中途打断剧情做硬广告。',
 'default-director':'按用户目标组织清晰、连续、可执行的镜头与口播。'
};
const beatChains:Record<string,string>={
 'ecommerce-spoken-selling':'截停具体困扰→拿出商品建立判断→可见操作或试用证明→反馈结果→锁定适合人群并给出单一建议',
 'ecommerce-promotion-conversion':'真实利益截停→用途与价值证明→完整交代已确认权益和限制→单一购买动作',
 'ecommerce-scene-seeding':'生活情境与需求→商品自然介入→使用过程→可见变化或体验反馈→分享建议',
 'ecommerce-pain-point-solution':'可见困扰→困扰代价→商品介入动作→相同条件下验证→建议与收尾',
 'ecommerce-function-demo':'任务和标准→操作步骤→关键细节特写→可见反馈→确认功能价值',
 'local-store-discovery':'街区或门头发现→进入与目标→招牌环境或项目→体验反馈→真实到店理由',
 'local-store-visit-record':'抵达→进入与沟通→体验过程→现场反馈→离店建议',
 'local-store-signature-experience':'到店动机→招牌项目准备→关键制作或体验→细节反馈→适合人群与到店动作',
 'local-store-group-buy-conversion':'到店动机→套餐内容证明→权益与限制→预约核销和购买动作',
 'advertising-brand-proposition':'人物处境→价值选择→商品参与行动→状态变化→主张回收',
 'advertising-brand-story':'人物或品牌处境→具体事件→选择与转折→价值兑现→品牌收束',
 'advertising-lifestyle':'生活状态建立→具体需求→商品自然介入→状态完成→生活母题回收',
 'advertising-creative-concept':'视觉规则建立→规则升级→商品成为转折媒介→视觉变化兑现→回环首镜形成记忆点',
 'short-drama-dialogue':'目标冲突→对白施压→行动改变判断→关系或选择收束',
 'short-drama-reversal':'先建立可被误读的事实→用同一物件或动作强化预期并埋伏笔→揭开已有线索→新含义收束',
 'short-drama-suspense':'具体异常→追问与线索→关键揭晓→结果反馈→余波收束',
 'short-drama-emotional':'关系与压力→具体关怀行动→防备变化→可见情绪落点→余味收束',
 'short-drama-product-placement':'人物目标与阻碍→商品参与解决→结果改变人物选择→剧情自然收束'
};
export function directorTemplates(common:string){
 return directorCatalog().map(d=>({
  id:'director.'+d.key,
  name:d.name==='默认'?'默认编导':d.name+'编导',
  content:compileDirectorPromptLayers([
   {kind:'common',id:'platform-facts',content:common+' 你负责视频脚本创作与修订。',sourceId:'fire-agent-independent-core'},
   {kind:'category',id:'commerce-video-director',content:directorCorePrompt,sourceId:'benchmark-reconstructed-core'},
   {kind:'skill',id:d.key,content:(rules[d.key]||rules['default-director'])+(beatChains[d.key]?' 本类型功能节拍参考：'+beatChains[d.key]+'。根据本轮总时长压缩或展开，但保持因果顺序。':''),sourceId:'benchmark-reconstructed-core'},
   {kind:'runtime',id:'director-script-v2',content:directorOutputContract+' 本编导skillKey为 '+d.key+'。严格采用本轮给定的总时长和语言。分镜id采用「镜头N｜该镜功能标题」格式（如 镜头1｜截停痛点并引出核心卖点），每个镜头承担一个明确叙事功能；每镜写清画面动作、场景、机位运镜、台词（含语言与语气）、环境声、拟音与背景音乐，按时间段连续覆盖总时长。保持角色与商品在镜头间严格一致，结尾输出禁止约束。结合当前参考素材及已确认的历史信息处理修改意见；缺少关键资料时仅询问必要信息。只要用户已附商品参考图并给出明确创作要求，一律判定创意资料已足够，直接产出完整脚本；仅当缺失会构成虚假承诺的关键事实且完全无法用画面规避时才 needs_input，问题不超过1个。只在真实任务完成后才能说视频已生成。不要输出不存在的下载链接。',sourceId:'fire-agent-independent-core'}
  ]),
  version:8,
  updatedAt:0,
  source:'independent-implementation' as const
 }));
}
export const videoTemplate={id:'video.generate',name:'视频生成输入编译',content:'制作一段连续自然的视频。严格保持参考素材主体的外形、服饰与商品标识，不编造商品事实。参考图片、声音、视频的角色按绑定清单使用。执行已确认的脚本，保持人物动作、空间、镜头及声音连贯。',version:1,updatedAt:0,source:'independent-implementation' as const};
