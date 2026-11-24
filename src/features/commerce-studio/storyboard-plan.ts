import type {DirectorScene} from '@/commerce/shared/director-scenarios';
import {storyboards} from './scene-storyboards';

const cameras:Record<DirectorScene,readonly string[]>={
 'personal-story':['人物中景建立讲述环境','特写呈现转折相关的实物','跟随人物完成当时的关键动作','回到叙述者现在的反应'],
 'personal-diary':['广角建立环境与时段','中景跟随日常动作','近景留住可观察的细节','用结束动作或环境声收尾'],
 'personal-advice':['中景说明操作对象','近景摆明准备材料','连续特写展示步骤','对照完成状态与检查点'],
 'personal-opinion':['正面中景点出议题','保持视轴呈现核心判断','插入能支持观点的示例画面','回到讲述者说明边界'],
 'reversal-payoff':['双人中景交代双方站位','近景保留伏笔所在物件或动作','同角度特写揭示证据','反应近景回到误判者'],
 'brand-product-showcase':['全景建立商品轮廓','推近同一处结构细节','固定机位呈现完整操作','回到全貌并停留'],
 'brand-benefit':['中景呈现使用需求','近景定位与卖点有关的部位','保持同一机位拍到动作及结果','回到使用者与商品'],
 'brand-creative-ad':['全景建立视觉设定','近景引入可辨认的商品','以同一动作或形状完成转场','回扣首镜并停在商品上'],
 'drama-selling':['中景建立人物目标或冲突','跟随动作让情绪逐镜升级','近景抓住反转高点','商品出场兑现价值并收尾'],
 'thai-selling':['全景给出荒诞或失控的结果画面','中景保留前段线索细节','沿同一空间逐步揭示原因','把真实因果落到商品并留余味'],
 'absurd-selling':['全景建立夸张的世界规则','中景让离谱事件按规则发生','近景呈现商品成为规则关键','顺滑收尾并停在记忆画面'],
 'reverse-attribution-ad':['定格目标记忆点画面','反推并建立归因情境','逐级铺垫画面证据','商品出场兑现归因并收束'],
};
export function storyboardShots(scene:DirectorScene,facts:string[],seconds:number){
 return storyboards[scene].fields.map((label,i)=>({
  id:'shot-'+i,label,fact:(facts[i]||'').trim(),camera:cameras[scene][i],
  start:Math.floor(i*seconds/4),end:Math.floor((i+1)*seconds/4),
 }));
}
export function shotText(shot:ReturnType<typeof storyboardShots>[number]){
 return `${shot.start}–${shot.end}秒 · ${shot.label}\n${shot.fact}\n机位：${shot.camera}`;
}
