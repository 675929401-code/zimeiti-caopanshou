"use client";

import { AppScopedLink } from "@/components/app-scoped-link";
import {
  BookOpen,
  Boxes,
  Compass,
  ExternalLink,
  Globe2,
  Link2,
  Rocket,
  Search,
  Star,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { PublicFooter } from "./official-public-page-shared";
import styles from "./official-public-pages.module.css";

type ResourceCategory = "全部" | "AI官网" | "开源项目" | "开发平台" | "实用工具" | "学习资源";
type ResourceGroup = Exclude<ResourceCategory, "全部">;

interface ResourceItem {
  id: string;
  title: string;
  description: string;
  category: ResourceGroup;
  href?: string;
  availability?: "available" | "pending";
  statusLabel?: string;
  featured?: boolean;
}

const RESOURCE_CATEGORIES: readonly { label: ResourceCategory; Icon: LucideIcon }[] = [
  { label: "全部", Icon: Compass },
  { label: "AI官网", Icon: Globe2 },
  { label: "开源项目", Icon: Boxes },
  { label: "开发平台", Icon: Rocket },
  { label: "实用工具", Icon: Wrench },
  { label: "学习资源", Icon: BookOpen },
];

const RESOURCE_ITEMS: readonly ResourceItem[] = [
  {
    id: "minimax-design",
    title: "MiniMax Design",
    description: "集成多种创作能力的设计工作台，适合快速完成创意方案与视觉表达。",
    category: "实用工具",
    href: "https://design.minimaxi.com/",
    featured: true,
  },
  {
    id: "doubao-seedance-25-guide",
    title: "Doubao Seedance 2.5 提示词指南",
    description: "整理视频提示词结构、镜头表达与参考素材使用方法。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
    featured: true,
  },
  {
    id: "seedream-50-pro-guide",
    title: "即梦 Seedream 5.0 Pro 用户手册",
    description: "涵盖生图模型的提示词写法、参数选择与常用创作场景。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
    featured: true,
  },
  {
    id: "douyin-short-drama",
    title: "抖音短剧创作者中心",
    description: "面向短剧创作者的内容发布、作品管理与创作服务入口。",
    category: "AI官网",
    href: "https://creator.douyin.com/",
    featured: true,
  },
  {
    id: "seedance-20-guide",
    title: "Seedance 2.0 系列提示词指南",
    description: "从画面描述到镜头运动，系统整理视频生成提示词方法。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
    featured: true,
  },
  {
    id: "ofox-api",
    title: "Ofox API",
    description: "快速接入多种模型与开发能力。",
    category: "开发平台",
    availability: "pending",
    statusLabel: "入口待核验",
  },
  {
    id: "minimax-h3-manual",
    title: "MiniMax H3 模型 - 使用手册",
    description: "多模态模型能力、使用场景与调用方法说明。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
  },
  {
    id: "mimo-platform",
    title: "MiMo 开放平台",
    description: "体验小米系列模型能力与 API 服务。",
    category: "开发平台",
    href: "https://platform.xiaomimimo.com/",
  },
  {
    id: "hermes-agent",
    title: "Hermes Agent",
    description: "由 Nous Research 构建的可扩展 AI 智能体项目。",
    category: "开源项目",
    href: "https://github.com/NousResearch/hermes-agent",
  },
  {
    id: "arena-ai",
    title: "Arena AI",
    description: "模型能力评测、对比与排行榜平台。",
    category: "开发平台",
    href: "https://arena.ai/",
  },
  {
    id: "artificial-analysis",
    title: "Artificial Analysis",
    description: "Independent analysis of AI models and providers.",
    category: "开发平台",
    href: "https://artificialanalysis.ai/",
  },
  {
    id: "wanjing",
    title: "万镜一刻",
    description: "面向视频创作的成片工具。",
    category: "实用工具",
    availability: "pending",
    statusLabel: "入口待核验",
  },
  {
    id: "kling-video-30-guide",
    title: "可灵视频 3.0 模型使用指南",
    description: "视频模型功能、镜头控制与提示词写作指南。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
  },
  {
    id: "kling-omni-30-guide",
    title: "可灵图片模型Omni 3.0使用指南",
    description: "图片生成能力、参考图使用与场景提示词手册。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
  },
  {
    id: "libtv",
    title: "LibTV",
    description: "专业视频创作与编辑工具。",
    category: "实用工具",
    availability: "pending",
    statusLabel: "入口待核验",
  },
  {
    id: "xiaoyunque",
    title: "小云雀",
    description: "面向故事与视频生产的创作工具。",
    category: "实用工具",
    availability: "pending",
    statusLabel: "入口待核验",
  },
  {
    id: "kling-ai",
    title: "可灵AI",
    description: "图片与视频生成创作平台。",
    category: "实用工具",
    href: "https://kling.ai/",
  },
  {
    id: "minimax-token-plan",
    title: "MiniMax Token Plan",
    description: "查看 MiniMax 模型与开发服务。",
    category: "开发平台",
    href: "https://platform.minimaxi.com/",
  },
  {
    id: "zhipu-coding-plan",
    title: "智谱 Coding Plan",
    description: "面向编码场景的模型与开发工具服务。",
    category: "开发平台",
    href: "https://open.bigmodel.cn/",
  },
  {
    id: "doubao",
    title: "豆包",
    description: "字节跳动旗下 AI 智能助手。",
    category: "AI官网",
    href: "https://www.doubao.com/",
  },
  {
    id: "wanxiang-image-guide",
    title: "万相文生图提示词指南",
    description: "提示词公式、风格描述与画面控制技巧。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
  },
  {
    id: "wanxiang-video-guide",
    title: "万相视频创作提示词指南",
    description: "结构化视频提示词与镜头调度方法。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
  },
  {
    id: "jimeng-ai",
    title: "即梦AI",
    description: "面向图片、视频与设计的一站式创作平台。",
    category: "实用工具",
    href: "https://jimeng.jianying.com/",
  },
  {
    id: "tapnow",
    title: "TapNow",
    description: "支持创作看板与复杂长篇叙事的内容生产工具。",
    category: "实用工具",
    href: "https://www.tapnow.ai/",
  },
  {
    id: "seedream-image-guide",
    title: "Seedream图片提示词指南",
    description: "图像提示词写作、构图与风格控制技巧。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
  },
  {
    id: "seedance-video-guide",
    title: "Seedance视频提示词指南",
    description: "视频提示词方法、相关技巧与镜头表达。",
    category: "学习资源",
    availability: "pending",
    statusLabel: "指南内容待补充",
  },
];

const GROUP_ORDER: readonly ResourceGroup[] = ["开发平台", "学习资源", "开源项目", "实用工具", "AI官网"];

const GROUP_META: Record<ResourceGroup, { Icon: LucideIcon; color: string }> = {
  AI官网: { Icon: Globe2, color: "blue" },
  开源项目: { Icon: Boxes, color: "pink" },
  开发平台: { Icon: Rocket, color: "green" },
  实用工具: { Icon: Wrench, color: "orange" },
  学习资源: { Icon: BookOpen, color: "violet" },
};

function ResourceAnchor({ item, className, children }: {
  item: ResourceItem;
  className: string;
  children: ReactNode;
}) {
  if (!item.href) return null;

  if (/^https:\/\//i.test(item.href)) {
    return (
      <a className={className} href={item.href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  return <AppScopedLink className={className} href={item.href}>{children}</AppScopedLink>;
}

function ResourceCard({ item, featured = false }: { item: ResourceItem; featured?: boolean }) {
  const pending = item.availability === "pending" || !item.href;
  const external = Boolean(item.href && /^https:\/\//i.test(item.href));
  const className = featured ? styles.featuredCard : styles.resourceCard;
  const content = (
    <>
      <span className={styles.linkIcon} data-category={item.category} aria-hidden="true"><Link2 size={22} /></span>
      <span className={styles.resourceCopy}>
        <strong>
          {item.title}
          {featured && <Star className={styles.featuredStar} size={14} fill="currentColor" />}
        </strong>
        <span>{item.description}</span>
        {featured && <small data-category={item.category}>{item.category}</small>}
        {pending && <small className={styles.pendingBadge}>{item.statusLabel || "资料待补充"}</small>}
      </span>
      {external && <ExternalLink className={styles.externalIcon} size={15} aria-hidden="true" />}
    </>
  );

  if (pending) {
    return (
      <article className={className} data-status="pending">
        {content}
      </article>
    );
  }

  return (
    <ResourceAnchor item={item} className={className}>
      {content}
    </ResourceAnchor>
  );
}

export function OfficialResourceNavigationPage() {
  const [category, setCategory] = useState<ResourceCategory>("全部");
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLocaleLowerCase("zh-CN");

  const matched = useMemo(() => RESOURCE_ITEMS.filter((item) => {
    if (category !== "全部" && item.category !== category) return false;
    if (!keyword) return true;
    return `${item.title} ${item.description} ${item.category}`.toLocaleLowerCase("zh-CN").includes(keyword);
  }), [category, keyword]);

  const featured = matched.filter((item) => item.featured);

  return (
    <div className={styles.navigationPage} data-page="youcai-resource-navigation">
      <header className={styles.navigationHeader}>
        <h1><Globe2 size={30} strokeWidth={2.2} aria-hidden="true" />AI 资源导航</h1>
        <p>精选优质 AI 工具、开源项目、开发平台和学习资源，助力你的创作之旅</p>
        <label className={styles.searchBox}>
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="搜索导航链接"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索导航链接..."
          />
        </label>
        <div className={styles.categoryBar} aria-label="资源分类">
          {RESOURCE_CATEGORIES.map(({ label, Icon }) => (
            <button
              type="button"
              key={label}
              data-active={category === label ? "true" : undefined}
              data-category={label}
              onClick={() => setCategory(label)}
            >
              {label !== "全部" && <Icon size={15} aria-hidden="true" />}
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className={styles.navigationContent}>
        {featured.length > 0 && (
          <section className={styles.resourceSection} aria-labelledby="featured-resources-title">
            <h2 id="featured-resources-title"><Star size={19} fill="currentColor" />精选推荐</h2>
            <div className={styles.featuredGrid}>
              {featured.map((item) => <ResourceCard item={item} featured key={item.id} />)}
            </div>
          </section>
        )}

        {GROUP_ORDER.map((group) => {
          const items = matched.filter((item) => !item.featured && item.category === group);
          if (items.length === 0) return null;
          const { Icon, color } = GROUP_META[group];
          return (
            <section className={styles.resourceSection} key={group} aria-labelledby={`resource-group-${group}`}>
              <h2 id={`resource-group-${group}`} data-color={color}>
                <span><Icon size={17} aria-hidden="true" /></span>{group}<small>({items.length})</small>
              </h2>
              <div className={styles.resourceGrid}>
                {items.map((item) => <ResourceCard item={item} key={item.id} />)}
              </div>
            </section>
          );
        })}

        {matched.length === 0 && (
          <div className={styles.emptyState} role="status">
            <Search size={28} aria-hidden="true" />
            <strong>没有找到相关资源</strong>
            <span>请更换关键词或分类后重试</span>
            <button type="button" onClick={() => { setCategory("全部"); setQuery(""); }}>清空筛选</button>
          </div>
        )}
      </main>

      <PublicFooter />
    </div>
  );
}
