// Public product metadata only. Never import the server prompt package here.
export const BIP_VERSION = '2.3.1';
export const BIP_CATEGORY = 'bip:loop';
export const BIP_CATEGORY_LABEL = '商业IP';
export type BusinessScenario = 'all' | 'local';
export const BIP_STEPS = [
 { id:'agent-1787079707230-h0sdiq', name:'商业IP定位', short:'定方向', category:'商业定位IP', task:'定位策划', icon:'🧭', description:'从经历、特长、兴趣和现实条件出发，筛选适合长期做的自媒体方向。没有赛道、产品或客户也能开始。' },
 { id:'agent-1787158020109-cj3wnh', name:'账号主页包装', short:'包主页', category:'商业定位IP', task:'定位策划', icon:'🪪', description:'把定位转成抖音昵称、简介、头像方案与置顶内容，让潜在客户一眼看懂账号是谁、讲什么、能解决什么问题。' },
 { id:'agent-1787163731976-5xntwm', name:'对标账号拆解', short:'拆对标', category:'商业定位IP', task:'定位策划', icon:'🔎', description:'核对公开账号的高表现与普通样本，找出真正有价值、适合你学习的方法，说明哪些不能照搬，并给出原创迁移与下一步行动。' },
 { id:'agent-1787160182534-uk29g4', name:'内容选题策划', short:'做选题', category:'商业定位IP', task:'定位策划', icon:'🗓️', description:'决定长期讲什么、先拍什么和为什么拍，输出栏目、选题、创作简报与14天排期；本环节不写完整文案。' },
 { id:'agent-bip-script-2', name:'短视频文案成稿', short:'写成稿', category:'商业定位IP', task:'文案创作', icon:'📝', description:'把选题和真实素材写成可直接拍摄的完整短视频文案；可按需要输出真人口播、不露脸解说或字幕型表达。' },
 { id:'agent-1787160183236-5fi3w8', name:'咨询回复与跟进', short:'接咨询', category:'商业定位IP', task:'获客转化', icon:'💬', description:'读取这位会员的标准业务数据与顾客聊天，自动整理顾客咨询要点，生成可直接复制的回复和后续沟通建议；事实不全时不乱编。' },
 { id:'agent-1787160184111-bj5hi3', name:'运营数据复盘', short:'看数据', category:'商业定位IP', task:'运营复盘', icon:'📈', description:'核对内容、咨询、预约与成交数据，找到主要流失环节和下一轮最值得验证的一个问题。' },
] as const;
export function bipStep(id?: string | null) { return BIP_STEPS.find(step=>step.id===id); }
export function bipAllowsSkills(id?: string | null) { return id==='agent-1787163731976-5xntwm'; }
export function bipOrder(id: string) { const i=BIP_STEPS.findIndex(step=>step.id===id); return i<0?Number.MAX_SAFE_INTEGER:i; }
export const TASK_CATEGORIES = [
 {key:'task:影像编导',label:'影像编导',icon:'🎬'},
 {key:'task:文案创作',label:'文案创作',icon:'✍️'},
 {key:'task:获客转化',label:'运营增长',icon:'💬'},
] as const;
// Display facets do not mutate legacy categories, which are also permission scopes.
export function taskCategory(agent: {id:string;name:string;category?:string}) {
 const step=bipStep(agent.id); if(step) return step.task;
 if(agent.category==='自用') return '内部工具';
 if(/3D|2D|影像|故事导演/.test(agent.name)) return '影像编导';
 if(/复盘|试跑|对比/.test(agent.name)) return '运营复盘';
 if(/文案|编导|脚本|爆点|钩子|标题|封面|知识爆款/.test(agent.name)) return '文案创作';
 if(/定位|画像|洞察|优势|对标|主页|信任|变现|品牌|选题|排期|起盘/.test(agent.name)) return '定位策划';
 return '获客转化';
}
type DisplayAgent = {id:string;name:string;category?:string};
// The seven-step suite has one home. Individual task roles remain step metadata.
export function displayCategory(agent:DisplayAgent):string {
 if(bipStep(agent.id)) return BIP_CATEGORY;
 if(agent.category==='自用'||agent.category?.startsWith('custom_cat_')) return agent.category;
 const task=taskCategory(agent);
 if(task==='定位策划'||task==='运营复盘') return 'task:获客转化';
 return `task:${task}`;
}
export function normalizeDisplayCategory(key:string):string {
 return ['商业定位IP','task:定位策划'].includes(key)?BIP_CATEGORY:key;
}
export function matchesDisplayCategory(agent:DisplayAgent, key:string) {
 const category=normalizeDisplayCategory(key);
 if(category===BIP_CATEGORY||category.startsWith('task:')) return displayCategory(agent)===category;
 return category==='all'||agent.category===category;
}
// A scenario filters already-authorized cards; it never grants access or splits the suite.
export function matchesBusinessScenario(agent:DisplayAgent, scenario:BusinessScenario) {
 return scenario==='all'||Boolean(bipStep(agent.id))||agent.category==='实体引流';
}
export function pinBipAgents<T extends {id:string}>(agents:T[]):T[] {
 return [...agents].sort((a,b)=>bipOrder(a.id)-bipOrder(b.id));
}
