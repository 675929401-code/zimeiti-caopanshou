import type {DirectorNavCard} from '@/commerce/components/commerce-agent/director-nav';
import {directorScenes} from '@/commerce/shared/director-scenarios';
import {sceneKeys} from './routes';
import {visualDirectorCatalog} from '@/commerce/components/commerce-agent/personal-ip-cards';

export const storyboards:Record<string,{name:string;fields:readonly string[];legacy?:string}>={
  'personal-story':directorScenes['personal-story'],
  'personal-diary':directorScenes['personal-diary'],
  'personal-advice':directorScenes['personal-advice'],
  'personal-opinion':directorScenes['personal-opinion'],
  'reversal-payoff':directorScenes['reversal-payoff'],
  'brand-product-showcase':{...directorScenes['brand-product-showcase'],legacy:'品牌主张'},
  'brand-benefit':{...directorScenes['brand-benefit'],legacy:'品牌故事'},
  'brand-creative-ad':{...directorScenes['brand-creative-ad'],legacy:'生活方式'},
  'drama-selling':directorScenes['drama-selling'],
  'thai-selling':directorScenes['thai-selling'],
  'absurd-selling':directorScenes['absurd-selling'],
  'reverse-attribution-ad':directorScenes['reverse-attribution-ad']
};
export function manualSceneNeeded(scene:string,cards:DirectorNavCard[]){
  const spec=storyboards[scene];
  const card=cards.find(item=>sceneKeys[item.key]===scene);
  return !!spec&&!!cards.length&&(spec.legacy?!!card&&card.name===spec.legacy:!card);
}
export function visibleSceneCards(cards:DirectorNavCard[]):DirectorNavCard[]{
  const visible=cards.filter(item=>!item.default).map(item=>{
    const scene=sceneKeys[item.key];
    const reference=manualSceneNeeded(scene,cards)&&visualDirectorCatalog.find(row=>row.key===item.key);
    return reference||item;
  });
  if(cards.some(card=>card.default))for(const reference of visualDirectorCatalog){
    const scene=sceneKeys[reference.key];
    if(!visible.some(card=>card.key===reference.key)&&manualSceneNeeded(scene,cards))visible.push(reference);
  }
  return visible;
}
