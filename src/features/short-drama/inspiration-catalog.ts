import type { InspirationCategory, InspirationExample } from "./types";

export const INSPIRATION_CATEGORIES = [
  "全部",
  "无对白叙事",
  "风格实验",
  "商业短片",
  "知识故事",
] as const satisfies readonly InspirationCategory[];

/**
 * 全部文案为本项目原创方法示例，图片来自主站 public/short-drama。
 * 本配置不得加入对标官网 URL、抓取素材或隐藏提示词。
 */
export const INSPIRATION_EXAMPLES = [
  {
    id: "silent-pet-care",
    title: "无对白萌宠照护",
    category: "无对白叙事",
    summary: "让宠物只通过动作、视线和环境反馈推进故事，旁白承担信息表达。",
    method: "先拆旁白语义，再为每个语义节拍匹配可见动作；禁止角色口型对白。",
    style: "温暖商业 3D 动画",
    ratio: "9:16",
    imagePath: "/short-drama/previews/inspiration-silent-pet-v1.webp",
    imageAlt: "原创无对白萌宠动画方法示例",
    primaryHref: "/storyboard-workbench?entry=inspiration&template=silent-pet-care",
  },
  {
    id: "paper-fox-adventure",
    title: "纸艺狐狸奇遇",
    category: "风格实验",
    summary: "用统一纸张纹理、折痕方向和舞台光建立可持续扩展的风格规则。",
    method: "先锁定材质与色板，再让每个镜头只改变动作、景别和空间关系。",
    style: "手工纸艺定格感",
    ratio: "16:9",
    imagePath: "/short-drama/previews/inspiration-paper-fox-v1.webp",
    imageAlt: "原创纸艺狐狸风格实验示例",
    primaryHref: "/storyboard-workbench?entry=inspiration&template=paper-fox-adventure",
  },
  {
    id: "product-micro-film",
    title: "产品微电影",
    category: "商业短片",
    summary: "将卖点转译为可见的使用动作、环境变化与结果镜头，而不是堆叠口号。",
    method: "一镜一卖点，产品外观保持一致；结尾用结果画面承接品牌记忆。",
    style: "克制质感广告片",
    ratio: "9:16",
    imagePath: "/short-drama/previews/inspiration-product-film-v1.webp",
    imageAlt: "原创产品微电影创作示例",
    primaryHref: "/storyboard-workbench?entry=inspiration&template=product-micro-film",
  },
  {
    id: "moon-observatory",
    title: "月面观测站的一天",
    category: "知识故事",
    summary: "把抽象知识点绑定到人物任务、装置变化和可验证的视觉结果。",
    method: "每段只解释一个概念；先出现问题，再给实验过程，最后用画面完成验证。",
    style: "未来科普动画",
    ratio: "16:9",
    imagePath: "/short-drama/previews/inspiration-moon-observatory-v1.webp",
    imageAlt: "原创月面观测站知识故事示例",
    primaryHref: "/storyboard-workbench?entry=inspiration&template=moon-observatory",
  },
] as const satisfies readonly InspirationExample[];
