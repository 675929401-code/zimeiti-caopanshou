/** A scene task adds a creative brief to the active general director. */
export const directorScenes = {
  'personal-story': {name:'个人故事',cardKey:'personal-story',productImage:true,fields:['事情起点','遇到的转折','当时的行动','现在的感受'],question:'哪一段亲身经历值得讲？当时做了什么，后来发生了什么变化？'},
  'personal-diary': {name:'日常记录',cardKey:'personal-diary',productImage:true,fields:['时间地点','日常动作','现场细节','收尾片刻'],question:'想记录哪一天、哪个地方和哪几个自己实际做过的动作？'},
  'personal-advice': {name:'经验分享',cardKey:'personal-advice',productImage:true,fields:['遇到的问题','准备条件','操作步骤','自查方法'],question:'要帮谁解决什么问题？哪几个步骤是你亲自用过、可以演示的？'},
  'personal-opinion': {name:'观点表达',cardKey:'personal-opinion',productImage:true,fields:['话题','核心观点','依据或例子','适用边界'],question:'你想表达哪一个判断？有哪些亲眼见到的例子或可核对的事实？'},
  'reversal-payoff': {name:'反转打脸', cardKey:'face-slap-reversal', productImage:false, fields:['原判断','铺垫','反转证据','人物反应'], question:'谁最初误判了谁？哪一个可以拍到的事实让判断反转？'},
  'brand-product-showcase': {name:'商品展示', cardKey:'advertising-brand-proposition', productImage:true, fields:['商品外观','关键细节','实际使用','展示收尾'], question:'希望观众看清商品的哪个细节或操作？'},
  'brand-benefit': {name:'卖点广告', cardKey:'advertising-brand-story', productImage:true, fields:['用户需求','核心卖点','演示证据','购买理由'], question:'这款商品要解决谁的哪个问题？有什么能拍出来的证据？'},
  'brand-creative-ad': {name:'创意广告', cardKey:'advertising-lifestyle', productImage:true, fields:['创意设定','产品出场','视觉转折','品牌记忆点'], question:'希望观众记住商品的哪个特征，或哪一个创意设定？'},
  'drama-selling': {name:'剧情带货', cardKey:'pcc62f09b-6a69c3', productImage:true, fields:['人物目标','冲突升级','反转高点','商品兑现'], question:'想用一段什么小剧情带这款商品？谁遇到了什么冲突，商品如何在情绪高点解决问题？'},
  'thai-selling': {name:'泰式带货', cardKey:'pcc62f09b-6d3d7e', productImage:true, fields:['荒诞开场','疑问铺垫','因果揭示','商品落点'], question:'开场想呈现哪一个反常或失控的画面？结尾如何把真实原因落到商品上？'},
  'absurd-selling': {name:'脑洞带货', cardKey:'pcc62f09b-c92a82', productImage:true, fields:['脑洞设定','世界规则','离谱事件','商品关键'], question:'想建立一个什么夸张但自洽的设定？商品为什么是这个设定成立的关键？'},
  'reverse-attribution-ad': {name:'创意广告', cardKey:'pcc62f09b-d5eb08', productImage:true, fields:['记忆点','归因情境','画面证据','商品出场'], question:'希望观众记住哪一个画面或一句话？什么情境能让人自然得出这个结论？'},
} as const;
export const sceneCharacterSlot = 'scene-character';
export function sceneImageSlot<T extends {key:string;label:string;kinds:string[]}>(slots:readonly T[]){
  return slots.find(slot=>slot.kinds.includes('image')&&slot.label!=='角色');
}
export type DirectorScene = keyof typeof directorScenes;
export function isDirectorScene(value:unknown):value is DirectorScene {
  return typeof value === 'string' && Object.hasOwn(directorScenes,value);
}
