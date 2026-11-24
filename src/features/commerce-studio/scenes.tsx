'use client';
import { useEffect, useRef } from 'react';
import { PanelLeftClose } from 'lucide-react';
import { IMAGE_SKILLS } from '@/commerce/components/commerce-agent/catalog';
import type {DirectorNavCard} from '@/commerce/components/commerce-agent/director-nav';
import { imageKeys, groupKeys, sceneKeys, imagePath, videoPath } from './routes';
import {visibleSceneCards} from './scene-storyboards';
import { observedImage } from '@/commerce/components/commerce-agent/reference-ui';
const sidebarOrder=['pcc62f09b-6a69c3','pcc62f09b-6d3d7e','pcc62f09b-c92a82','pcc62f09b-d5eb08','ecommerce-spoken-selling','ecommerce-promotion-conversion','ecommerce-scene-seeding','ecommerce-pain-point-solution','ecommerce-function-demo','local-store-discovery','local-store-visit-record','local-store-signature-experience','local-store-group-buy-conversion','face-slap-reversal','advertising-brand-proposition','advertising-brand-story','advertising-lifestyle','advertising-creative-concept','short-drama-dialogue','short-drama-reversal','short-drama-suspense','short-drama-emotional','short-drama-product-placement','test-characterstories','test-dailydocumentary','test-experience','test-opinion'];
const imageSidebar:Record<string,{category:string;description:string;order:number}>={
  "脸部三视图":{category:"人物",description:"生成正脸、侧脸、半侧脸参考",order:0},
  "人物四视图":{category:"人物",description:"生成全身三视角与脸部特写",order:1},
  "模特换脸":{category:"人物",description:"一键替换面部与发型",order:2},
  "人脸融合":{category:"人物",description:"融合两张人脸生成全新虚拟头像资产",order:3},
  "服装上身":{category:"商品",description:"替换模特身上的服装衣物",order:4},
  "商品使用":{category:"商品",description:"生成真人试用与使用场景",order:5},
  "商品白底图":{category:"商品",description:"生成高级白底商品图与多角度资产",order:6},
  "服装改款":{category:"商品",description:"替换服装的面料、印花等",order:7},
  "人物入景":{category:"场景",description:"替换模特图背景",order:8},
  "人物真人感":{category:"增强",description:"AI虚拟人添加真实感",order:9},
  "图片精修":{category:"增强",description:"修复画质、光影和清晰度",order:10}
};
export const sceneSidebarOrder=(key:string)=>{const index=sidebarOrder.indexOf(key);return index===-1?sidebarOrder.length:index;};
const currentDramaCards = new Set(['face-slap-reversal', 'short-drama-dialogue', 'short-drama-suspense', 'short-drama-emotional']);
const videoGroupOrder = ['创意带货', '电商带货', '同城到店', '品牌广告', '短剧编导', '个人IP', '剧情短片'];
// 对标目录中"茂隆掌柜"分组承载四个创意带货编导，本站以自有分组名展示。
const displayCategory = (category:string)=>category==='茂隆掌柜'?'创意带货':category;
type Props={embedded?:boolean;image:boolean;cards:DirectorNavCard[];active:string;group:string;collapse:()=>void;go:(url:string)=>void;error:string;retry:()=>void};
export function StudioScenes({image,embedded,cards,active,group,collapse,go,error,retry}:Props) {
  const root=useRef<HTMLElement>(null);
  const items=image?IMAGE_SKILLS.filter(s=>imageKeys[s.id]).map(s=>{const reference=observedImage(s.name),display=imageSidebar[s.name];return {key:s.id,name:s.name,description:display?.description||reference?.description||s.description,category:display?.category||reference?.category||s.category,icon:reference?.icon,order:display?.order??reference?.order??100};}).sort((a,b)=>a.order-b.order):visibleSceneCards(cards).map(card=>currentDramaCards.has(card.key)?{...card,category:'短剧编导'}:card).map(card=>({...card,category:displayCategory(card.category)})).sort((a,b)=>sceneSidebarOrder(a.key)-sceneSidebarOrder(b.key));
  const categories=[...new Set(items.map(c=>c.category))].sort((a,b)=>{if(image)return 0;const order=videoGroupOrder;return (order.includes(a)?order.indexOf(a):99)-(order.includes(b)?order.indexOf(b):99);});
  useEffect(()=>{if(group)root.current?.querySelector('[data-group="'+CSS.escape(group)+'"]')?.scrollIntoView({block:'nearest'});},[group,items.length]);
  return <aside className="cs-scenes-nav" ref={root} aria-label={image?'图片工具':'视频场景'}>{!embedded&&<header><h2>{image?'AI 图片':'AI 视频'}</h2><button title="收起场景栏" onClick={collapse}><PanelLeftClose size={18}/></button></header>}<div>{!image&&error&&<p>{error} <button onClick={retry}>重试</button></p>}
    {categories.map(category=><section key={category} data-group={groupKeys[category]}><h3>{category}</h3>{items.filter(c=>c.category===category).map(c=><button key={c.key} aria-current={c.key===active?'page':undefined} onClick={()=>go(image?imagePath+'?tool='+imageKeys[c.key]:videoPath+'?scene='+encodeURIComponent(sceneKeys[c.key]||c.key)+'&mode=director')}>{c.icon&&<img src={c.icon} alt=""/>}<span><b>{c.name}</b><small>{c.description}</small></span></button>)}</section>)}</div></aside>;
}
