import type {Operation} from './operation-routing';
import type {SceneCallStep} from '../shared/scene-prompt-workbench';

type Transfer={id:string;input:string;output:string;when:string};
const video:Transfer={id:'video.generate',input:'已确认脚本、引用素材、时长与声音设置',output:'会员视频资产和原任务记录',when:'用户将脚本应用到视频，选择模型并确认生成'};
const analyze:Transfer={id:'prompt-assist.analyze',input:'新商品的资料、图片和用户要求',output:'可修改并确认的商品洞察',when:'用户选择分析商品资料'};
const breakdown:Transfer={id:'prompt-assist.breakdown',input:'原片的抽帧、时间位置和来源快照',output:'带来源依据的参考结构',when:'用户发起参考视频拆解'};
const original:Transfer={id:'prompt-assist.remix-script',input:'已确认商品事实、参考结构与当前创作方式',output:'项目中的独立脚本版本',when:'用户确认参考结构与商品事实后生成新稿'};
const assist:Transfer={id:'prompt-assist.script',input:'已确认的商品洞察与创作参数',output:'可编辑、可应用的脚本版本',when:'用户确认创作参数后生成脚本'};
const detailPlan:Transfer={id:'detail-set.analyze',input:'商品、人物和风格素材，勾选模块与屏数、画幅',output:'按模块排列的逐屏视觉指令',when:'用户提交商品分析'};
const detailImage:Transfer={id:'detail-set.generate',input:'已确认的分析版本、逐屏指令与引用素材',output:'逐屏图片资产与失败项记录',when:'用户确认所选屏的生成报价'};

export function sceneCallChain(operation:string,routes:readonly Operation[]):SceneCallStep[]{
 let steps:Transfer[];
 if(operation.startsWith('director.'))steps=[{id:operation,input:'本卡场景规则、用户文案、素材职责、语言、时长与上轮脚本',output:'补充问题或包含事实、逐镜时间、画面、机位、声音和引用的脚本',when:'本轮新稿或定点改稿'},video];
 else if(operation.startsWith('image.'))steps=[{id:operation,input:'本卡视觉规则、绑定到各槽位的图片、画幅和用户修改要求',output:'会员图片资产及生成版本',when:'引用与必填素材检查通过，用户确认生成'}];
 else if(operation.startsWith('detail-set.'))steps=[detailPlan,detailImage];
 else if(operation===breakdown.id||operation===original.id)steps=[breakdown,analyze,original,video];
 else if(operation===analyze.id||operation===assist.id)steps=[analyze,assist,video];
 else if(operation==='depth-video-clone.generate')steps=[{id:operation,input:'准备好的原片区间、替换图、参考声音、保留及替换约束',output:'参考原片生成的视频资产',when:'确认具备原片输入、图片参考和输出声音开关的渠道后提交'}];
 else if(operation===video.id)steps=[video];
 else if(operation==='agent.chat')steps=[{id:operation,input:'当前会话、用户要求和已绑定素材',output:'对话回复，或可审阅的图像与视频步骤',when:'会员发送消息'},{id:'image.default',input:'计划中已确认的图片步骤与绑定素材',output:'可供下个步骤引用的图片资产',when:'计划包含图片步骤且会员确认执行时'}, {...video,input:'计划中的视频要求、引用的素材或上一步图片',when:'计划包含视频步骤且会员确认执行时'}];
 else steps=[{id:operation,input:'当前步骤保存的素材、要求与配置',output:'该步骤的任务结果',when:'执行此功能'}];
 return steps.map(step=>{const route=routes.find(r=>r.id===step.id);return {...step,label:route?.label||step.id,kind:route?.kind||null,revision:route?.revision||null,primary:route?.modelId||'',fallbacks:route?.fallbackModelIds||[],selectable:!!route?.userSelectable,stages:route?.stages||[]};});
}
