import {IMAGE_SKILLS} from '@/commerce/components/commerce-agent/catalog';
import type {DirectorNavCard} from '@/commerce/components/commerce-agent/director-nav';
import {visibleSceneCards} from './scene-storyboards';
import {imageKeys,imagePath,sceneKeys,videoPath} from './routes';

const videoOrder=[
 'advertising-brand-proposition','advertising-brand-story','advertising-creative-concept','advertising-lifestyle',
 'ecommerce-function-demo','ecommerce-pain-point-solution','ecommerce-promotion-conversion','ecommerce-scene-seeding','ecommerce-spoken-selling',
 'local-store-discovery','local-store-group-buy-conversion','local-store-signature-experience','local-store-visit-record','face-slap-reversal',
 'short-drama-dialogue','short-drama-emotional','short-drama-product-placement','short-drama-reversal','short-drama-suspense',
];
export function sceneSkills(cards:DirectorNavCard[]){
 const choices=visibleSceneCards(cards);
 const videos=videoOrder.flatMap(key=>{
  const card=choices.find(c=>c.key===key);
  return card?[{key,name:card.name,description:card.description,route:videoPath+'?scene='+sceneKeys[key]+'&mode=director'}]:[];
 });
 const images=Object.keys(imageKeys).flatMap(key=>{
  const card=IMAGE_SKILLS.find(c=>c.id===key);
  return card?[{key,name:card.name,description:card.description,route:imagePath+'?tool='+imageKeys[key]}]:[];
 });
 return [...videos,...images];
}
