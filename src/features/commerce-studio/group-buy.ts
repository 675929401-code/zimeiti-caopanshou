export const groupBuyScene = 'local-store-group-buy-conversion';
export const factLabels = {
  store: '门店名称', meal: '套餐内容', guests: '适用人数', price: '套餐价格', dates: '可用日期',
  booking: '预约要求', redemption: '核销方式'
} as const;
export type FactKey = keyof typeof factLabels;
export const factKeys = Object.keys(factLabels) as FactKey[];
export type Facts = Record<FactKey, string>;
export const blankFacts: Facts = {store:'', meal:'', guests:'', price:'', dates:'', booking:'', redemption:''};
export type Shot = { title: string; visual: string; speech: string; subtitle: string; sources: FactKey[]; imageIds: string[] };
export type StudioVersion = { brief?:string; id: string; revision: number; facts: Facts; imageIds: string[]; shots: Shot[]; createdAt: number; parentId?: string; origin?: 'local-plan'|'member-edit'; canvasId?: string };
export type StoreProject = { brief?:string; id: string; revision: number; facts: Facts; imageIds: string[]; versionId?: string; updatedAt: number; scene: typeof groupBuyScene };
export function groupBuyDirectorDraft(project:StoreProject,version?:StudioVersion) {
  const source=version||project;
  const lines=factKeys.map(key=>factLabels[key]+'：'+source.facts[key]);
  if(source.brief)lines.push('创作要求：'+source.brief);
  if(version){
    lines.push('已选分镜 v'+version.revision+'，请保留已确认的画面、口播与字幕。');
    version.shots.forEach((shot,index)=>lines.push(
      '镜头 '+(index+1)+' · '+shot.title,'画面：'+shot.visual,'口播：'+shot.speech,'字幕：'+shot.subtitle
    ));
  }
  return {prompt:lines.join('\n'),imageIds:source.imageIds};
}
export function planOffer(facts: Facts, imageIds: string[]): Shot[] {
  const missing = factKeys.filter(key => !facts[key].trim());
  if (missing.length) throw Error('请补充' + missing.map(key => factLabels[key]).join('、'));
  return [
    {title:'到店', visual:'拍摄门店招牌，镜头停在可辨认的店名。', speech:'今天到' + facts.store + '，一起看这份' + facts.meal + '。', subtitle:facts.store, sources:['store','meal'], imageIds:[]},
    {title:'套餐与价格', visual:'按商品参考图展示实际菜品，再切到套餐全景。', speech:facts.meal + '，' + facts.guests + '，' + facts.price + '。', subtitle:[facts.meal,facts.guests,facts.price].join(' · '), sources:['meal','guests','price'], imageIds},
    {title:'预约与核销', visual:'用文字卡展示适用时段和到店核销步骤。', speech:'可用日期：' + facts.dates + '。' + facts.booking + '。' + facts.redemption + '。', subtitle:[facts.dates,facts.booking,facts.redemption].join(' · '), sources:['dates','booking','redemption'], imageIds:[]}
  ];
}
