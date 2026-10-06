import {DEPTH_PURPOSE,DEPTH_DEFAULT_PROMPT} from './depth-video-clone-schema';
import {REFERENCE_BREAKDOWN_PROMPT,REFERENCE_REMIX_PROMPT} from './reference-video-schema';
import {DETAIL_ANALYSIS_PROMPT,DETAIL_IMAGE_PROMPT} from './detail-set-schema';
import {ASSIST_ANALYSIS_PROMPT,ASSIST_SCRIPT_PROMPT} from './prompt-assist-schema';
import {agentExecutionInstruction} from './agent-plan-schema';
import {directorTemplates,videoTemplate} from './director-prompts';
import {IMAGE_SKILLS} from '../components/commerce-agent/catalog';
import {get,list,put} from './store';
import {benchmarkReferenceFor,type BenchmarkPromptReference} from './benchmark-prompt-references';
import {currentPublishedCommerceConfiguration} from './configuration-platform';
import {sharedConfigurationEnabled} from '../../storage/database/configuration-source';
export type PromptTemplate={id:string;name:string;content:string;version:number;updatedAt:number;source:'independent-implementation';benchmarkReference?:BenchmarkPromptReference};
const common='你是电商视觉制作助手。商品事实以用户提供的资料和参考素材为准，不编造价格、功效、认证、销量或规格。保留商品品牌文字、版型、颜色、材质和结构。缺少事实时明确提出需要补充的资料。不得声称已生成、已保存或已发布媒体；只有实际工具结果才能证明执行完成。';
const constraints:Record<string,string>={
 'face-turnaround':'基于同一个人的脸部参考，制作正面、四分之三侧面、侧面三视图。保持五官比例、肤色、发型和年龄一致；自然光、清晰纹理、统一背景。',
 'character-sheet':'基于同一个模特制作一张四区人物参考图：正面全身、侧面全身、背面全身，以及脸部特写。前三个区域展示完整身形，第四个区域展示清晰五官；不要生成四个全身方向而缺少脸部特写。统一人物身份、身高比例、发型、服饰与背景；纯白棚拍背景；画面内不得出现任何标题、字幕或标注文字。用户提供多张图时综合锁定同一人物特征，不把不同人物混成一人。',
 'change-face':'以 model 角色作为底图，采用 face 角色的面部身份与发型，完成自然换脸。明确保留底图身体、姿态、服装、镜头和背景，匹配肤色、头颈比例、光线与发丝边缘。用户指定保留刘海、调整表情、妆容或其他发型细节时，遵循其具体要求，不改变未要求修改的部分。不要颠倒人物底图与目标人脸的职责。',
 'face-fusion':'自然融合两张人脸参考的面部特征，保持合理骨相、皮肤纹理及一致光照，避免拼贴接缝。只输出一张单人人像特写（胸部以上），不得输出多宫格、分镜故事板或任何字幕文字。',
 'change-cloth':'以 model 角色的图片作为人物和姿态基准，把 cloth 角色上装和 pants 角色下装穿到人物身上。精确保留衣服图案、文字、纽扣、领口、袖口和长度，呈现符合人体姿态的褶皱、遮挡与阴影。未提供的衣物维持原图。不要直接输出服装平铺图。；展示模特从头到脚的全身构图，不含面部裁切',
 'product-use':'人物参考中的模特自然使用或展示 product 角色的商品；保留商品形状、品牌、配色及人物身份，确保手指与接触位置合理、比例真实。',
 'white-background':'把 product 角色的商品完整放在纯白 #FFFFFF 背景上。保留包装文字、商标、颜色、材质和轮廓，去除背景杂物，保留自然轻微接触阴影，不增加装饰和广告文字。多张参考图可能是同一商品的不同角度或细节，先按可见外观对应，不能拼成另一件商品。用户未指定版式时，输出一张商品完整、主体清晰的白底图；用户指定多角度板或细节板时，把要求的视角和细节有序排列在同一张白底图片中，角度以参考图为依据，不编造不可见的结构。用户指定单独角度时，本次只输出其指定视角的一张图。一次任务输出一张图片，参考图数量和板内角度数量都不是额外输出张数；不要把多角度板称作已经分别保存的独立素材。；商品必须完整平铺展示，包含连帽、拉链、下摆等全部结构，不得折叠遮挡',
 'clothing-redesign':'仅按用户要求修改服装款式，以 cloth 为原款、material 为材质、print 为印花参考。保留未指定修改的设计。',
 'background-change':'保持人物外貌、姿态和服装，把人物自然放入 background 场景，匹配透视、光线、色温、比例与接触阴影。；展示模特从头到脚的全身构图',
 'portrait-realism':'保持人物身份与构图，改善真实皮肤纹理、发丝、眼睛反光和光影，避免塑料皮肤、过度磨皮和改变年龄。',
 'image-refine':'保持主体和构图，根据用户指出的缺陷做局部精修，保留产品信息及人物身份。',
 'script-storyboard':'依据已连接并验证的脚本文本及图片参考，制作一张脚本故事版图片。先保留项目名称、产品事实、目标时长、平台、受众、场景、视觉风格、展示重点与转化目标；这些内容以用户及脚本为准，不套用教程案例的商品、功效、价格或促销承诺。每个镜头对应明确序号、起止时间或时长、画面描述、景别与机位、运镜、人物动作、商品展示重点、素材引用职责、声音设计与口播；同时保持全片的光线、色彩、人物服饰、产品结构和剪辑节奏一致。参考素材只用于其明确职责，不将人像参考背景或商品白底自动搬进每个镜头。脚本已给出镜头顺序和时间时保持原意；时间缺失时按给定总时长安排连续、互不重叠的镜头，不照抄示例中的时间空缺。原脚本时间矛盾或产品事实缺失时，不替用户虚构已确认信息；在要求详细说明时列出待确认项。默认交付按从左到右、从上到下阅读的分镜宫格，每格表现该镜头的一个关键瞬间；声音与运镜作为创作约束，不把口播和技术说明自动叠成画面字幕。用户明确要求项目故事版、详细分镜表或带说明版时，交付一张可读的分镜表图片，包含项目摘要、逐镜头的画面/提示词/时间/机位/动作/展示重点/声音/口播/备注，以及摄影、灯光、动作、剪辑和一致性的技术说明区；不要强制所有故事版都使用表格。用户明确指定格数或原脚本已有镜头数量时遵循该结构，不固定为9格或15格，不将多个时间点的动作叠成同一瞬间。无口播、无字幕、无背景音乐等要求逐项遵守，未指定技术参数仅作为视觉建议，不声称图片具有真实帧率、视频时长或音轨。一次任务仅交付一张图片，表格行数和宫格数量均不是独立生成或计费张数；分镜表里的音效/口播文字也不等于已合成声音。',
 'storyboard-replace':'以 grid 角色提供的原故事版为镜头结构，保留原有格数、排列、每格机位、构图、动作顺序与情节。根据 reference 角色素材和用户明确要求，替换指定的人物、商品或背景；未要求替换的元素维持原状。所有格中的新人物身份、商品外观和场景关系保持一致，不因背景替换改变运镜或打乱事件顺序。交付与原分镜相同格数的一张故事版图片，不把宫格数当作独立输出图片数。',
 'video-first-frame':'制作可供图生视频使用的首帧，表现动作发生前的稳定状态，主体完整、景别明确、运动方向留出空间。',
 'product-consistency':'以 product 角色的商品参考图为产品外观依据，在所有视角中保持包装结构、尺寸比例、颜色、材质、商标和可见文字一致。识别多张参考之间的正面、侧面、背面或局部细节对应关系，不把不同商品特征混合。根据用户要求，在一张图片中组织多角度参考板或特写细节板；若用户只指定一个视角，则输出该视角的一张图片。优先使用参考图支持的角度，不凭空生成未见过的标签、零件或背面说明。保持一致的白底或用户指定背景、比例与光照，确保每个视角的主体清晰完整。板内多个视角仍是一张交付图片，不宣称已生成多个独立文件；后续视频需要独立视角素材时应另行生成或拆分保存。'
};
const imagePromptVersions:Record<string,number>={'character-sheet':2,'change-face':2,'storyboard-replace':2,'white-background':2,'product-consistency':2,'script-storyboard':2};
export function baselinePromptTemplates():PromptTemplate[]{return ([{id:DEPTH_PURPOSE,name:'深度复刻：独立参考视频模板',content:DEPTH_DEFAULT_PROMPT,version:1,updatedAt:0,source:'independent-implementation'},{id:'prompt-assist.breakdown',name:'创意复刻：参考视频拆解',content:REFERENCE_BREAKDOWN_PROMPT,version:1,updatedAt:0,source:'independent-implementation'},{id:'prompt-assist.remix-script',name:'创意复刻：新商品脚本',content:REFERENCE_REMIX_PROMPT,version:1,updatedAt:0,source:'independent-implementation'},{id:'detail-set.analyze',name:'商详套图：独立商品分析',content:DETAIL_ANALYSIS_PROMPT,version:1,updatedAt:0,source:'independent-implementation'},{id:'detail-set.generate',name:'商详套图：单屏生成',content:DETAIL_IMAGE_PROMPT,version:1,updatedAt:0,source:'independent-implementation'},{id:'prompt-assist.analyze',name:'帮我写：素材分析',content:ASSIST_ANALYSIS_PROMPT,version:1,updatedAt:0,source:'independent-implementation'},{id:'prompt-assist.script',name:'帮我写：创作脚本',content:ASSIST_SCRIPT_PROMPT,version:1,updatedAt:0,source:'independent-implementation'},{id:'agent',name:'Agent 对话与任务规划',content:common+' 根据用户意图进行多轮沟通，先明确交付目标，再给出可执行的文案或逐镜头方案。方案包含素材角色、镜头描述、图片提示词或视频提示词、时长与待确认事实。用自然中文回答，不输出虚构生成结果。'+agentExecutionInstruction,version:3,updatedAt:0,source:'independent-implementation'}, {id:'director',name:'旧版视频脚本模板（保留历史）',content:common+' 把简短要求扩展为一条可直接用于视频生成的完整提示词。按时间描述主体动作、机位运镜、场景、灯光、商品展示方式与声音，保持动作连续，不编造产品功能。只输出可用的视频提示词。',version:1,updatedAt:0,source:'independent-implementation'},...IMAGE_SKILLS.map(s=>({id:s.id,name:s.name,content:common+' '+(constraints[s.id]||'按用户创作要求生成高质量图片，明确主体、构图、光线与材质。'),version:imagePromptVersions[s.id]||1,updatedAt:0,source:'independent-implementation' as const})),...directorTemplates(common),videoTemplate] as PromptTemplate[]).map(p=>{const ref=benchmarkReferenceFor(p.id);return ref?{...p,benchmarkReference:ref}:p;});}
export function templates(){const published=currentPublishedCommerceConfiguration();if(published)return published.prompts.map(p=>({id:p.promptKey,name:p.name,content:p.content,version:p.version,updatedAt:Date.parse(published.publishedAt)||0,source:'independent-implementation'}));if(sharedConfigurationEnabled())return baselinePromptTemplates();const saved=list<PromptTemplate>('prompts','system');return baselinePromptTemplates().map(p=>saved.find(s=>s.id===p.id)||p);}
export function template(id:string){const values=templates();const found=values.find(p=>p.id===id);if(found)return found;if(currentPublishedCommerceConfiguration()||sharedConfigurationEnabled())throw Error(`当前权威配置缺少提示词 ${id}`);return values[0];}
export function saveTemplate(id:string,content:string){if(!baselinePromptTemplates().some(p=>p.id===id)||!content.trim()||content.length>20000)throw Error('提示词 ID 或内容无效');const previous=template(id);put('prompt-history',`${id}-${previous.version}`,'system',previous);const next={...previous,content,version:previous.version+1,updatedAt:Date.now()};put('prompts',id,'system',next);return next;}
