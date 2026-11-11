"use client";

import Image from "next/image";
import {
  HOMEPAGE_HERO_MP4,
  HOMEPAGE_HERO_POSTER,
  HOMEPAGE_HERO_WEBM,
} from "@/lib/youcai-hero-assets";
import {
  ArrowRight,
  Bot,
  CalendarCheck2,
  Clock3,
  FileText,
  Film,
  ImageIcon,
  Layers3,
  Music2,
  PanelsTopLeft,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Video,
  WandSparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { AppRouteShell, useManjuShowcaseCatalog } from "@/components/app-route-shell";
import { AppScopedLink } from "@/components/app-scoped-link";
import { useApp } from "@/contexts/app-context";
import { OFFICIAL_INSPIRATION_ITEMS } from "@/features/official-inspiration/inspiration-data";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import { applyManjuInspirationOverrides } from "@/lib/manju-showcase-runtime";
import { storeYoucaiAgentPrefill } from "@/lib/youcai-agent-prefill";
import styles from "./official-home-page.module.css";

type IntentLinkProps = ComponentProps<typeof AppScopedLink>;

function Link({ href, onFocus, onPointerEnter, ...props }: IntentLinkProps) {
  const router = useAppScopedRouter();
  const prefetchOnIntent = () => {
    if (typeof href === "string") router.prefetch(href);
  };
  return (
    <AppScopedLink
      {...props}
      href={href}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) prefetchOnIntent();
      }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (!event.defaultPrevented) prefetchOnIntent();
      }}
      prefetch={false}
    />
  );
}

const FEATURE_CARDS = [
  { icon: Zap, title: "一站式创作 · 降本增效", badge: "50+ 工具", text: "告别多平台切换与重复付费，效率提升 5 倍，成本直降 80%。" },
  { icon: Layers3, title: "顶级模型 · 随心调用", badge: "50+ 模型", text: "文本、图像、音频与视频模型集中使用，按创作任务灵活选择。" },
  { icon: ShieldCheck, title: "商用无水印 · 精控参数", badge: "0 水印", text: "创作结果支持直接导出，参数与生成状态清晰可控。" },
] as const;

type HomeToolCard = {
  icon: LucideIcon;
  title: string;
  text: string;
  color: string;
  image: string;
  imageAlt: string;
  label: string;
} & (
  | { available: true; href: string }
  | { available: false; statusLabel: string }
);

const TOOL_CARDS = [
  { icon: Bot, title: "对话式视频创作", text: "用对话组织文生、图生与参考生视频", href: "/tools/video/video-chat", color: "blue", image: "/short-drama/previews/hero-pipeline-v1.webp", imageAlt: "视频创作流程视觉", label: "多模型视频", available: true },
  { icon: ImageIcon, title: "图片生成 - 对话式", text: "独立生图工作台已下线，图片能力保留在创作模块内", color: "pink", image: "/short-drama/previews/inspiration-silent-pet-v1.webp", imageAlt: "对话式图片创作视觉", label: "对话式生图", available: false, statusLabel: "工作台已下线" },
  { icon: Music2, title: "音乐创作", text: "AI 歌曲、纯音乐与歌词创作入口", href: "/tools/audio/minimax-music", color: "orange", image: "/product-assets/youcai-demo-v1/clean-v21/previews/03-shot-02.webp", imageAlt: "AI 音乐创作视觉", label: "AI 音乐", available: true },
  { icon: WandSparkles, title: "即梦AI-智能超清", text: "专项超分与细节增强服务正在准备中", color: "cyan", image: "/short-drama/previews/inspiration-product-film-v1.webp", imageAlt: "图片智能超清视觉", label: "4K/8K 超清", available: false, statusLabel: "暂未开放" },
  { icon: UserRound, title: "视频生成 - 即梦动作模仿2.0", text: "动作与表情驱动服务正在准备中", color: "violet", image: "/short-drama/previews/inspiration-paper-fox-v1.webp", imageAlt: "视频动作模仿视觉", label: "动作模仿", available: false, statusLabel: "暂未开放" },
] satisfies readonly HomeToolCard[];

const FILM_STAGES = [
  { icon: FileText, title: "剧本", text: "原创或改编" },
  { icon: UserRound, title: "角色", text: "统一设定" },
  { icon: Layers3, title: "场景", text: "空间与道具" },
  { icon: PanelsTopLeft, title: "分镜", text: "镜头拆解" },
  { icon: Video, title: "视频", text: "任务与结果" },
] as const;

const INSPIRATION_SPOTLIGHT_IDS = [
  "cmsxb5ygm00y4mxpg5zbm5b42",
  "cmt1majdi02wd7fsa8xed2xe5",
  "cmt164bml00tqa3iw3oa3qbus",
  "cmt1m89hm02rd7fsabxtjkifg",
] as const;

const CREATIVE_CATEGORIES = [
  { icon: Bot, title: "文本创作", text: "剧本、文案、提示词与叙事设计", href: "/tools/text" },
  { icon: ImageIcon, title: "视觉创作", text: "角色、场景、分镜与图片生成", href: "/tools/image" },
  { icon: Music2, title: "音频创作", text: "配音、音色、歌词和音乐前期", href: "/tools/audio" },
  { icon: Video, title: "视频创作", text: "文生视频、图生视频与任务管理", href: "/tools/video" },
  { icon: Film, title: "影视工坊", text: "从剧本项目到角色、场景和分镜", href: "/tools/film-studio" },
] as const;

function HomeHero() {
  const showcaseCatalog = useManjuShowcaseCatalog();
  const [shouldLoadVideo, setShouldLoadVideo] = useState(false);
  const override = showcaseCatalog?.hero;
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const handle = window.setTimeout(() => setShouldLoadVideo(true), 1200);
    return () => window.clearTimeout(handle);
  }, []);
  if (override?.enabled === false) return null;
  const videoPath = override?.asset?.path || HOMEPAGE_HERO_MP4;
  const posterPath = override?.poster?.path || HOMEPAGE_HERO_POSTER;

  return (
    <section className={styles.hero}>
      <video
        aria-label="漫剧工作台多模态创作演示"
        autoPlay
        className={styles.heroImage}
        loop
        muted
        playsInline
        poster={posterPath}
        preload="none"
      >
        {shouldLoadVideo && videoPath === HOMEPAGE_HERO_MP4 ? <source src={HOMEPAGE_HERO_WEBM} type="video/webm" /> : null}
        {shouldLoadVideo ? <source src={videoPath} type="video/mp4" /> : null}
      </video>
      <div className={styles.heroShade} />
      <div className={styles.heroContent}>
        <span className={styles.eyebrow}><Sparkles size={15} /> AI 创作平台</span>
        <h1>让创作更精彩<br /><span>让想象看得见</span></h1>
        <p>文本 · 图像 · 音频 · 视频，全流程 AI 创作。<br />顶级模型驱动，支持合规创作与导出。</p>
        <div className={styles.heroActions}>
          <Link className={styles.primaryAction} href="/tools">开始创作 <ArrowRight size={17} /></Link>
          <Link className={styles.glassAction} href="/youcai/about"><Film size={17} /> 了解平台</Link>
          <Link className={styles.glassAction} href="/youcai/business">商务合作</Link>
        </div>
        <div className={styles.heroStats}>
          <span><strong>5×</strong><small>效率提升</small></span>
          <span><strong>80%</strong><small>成本降低</small></span>
          <span><strong>全自动</strong><small>影视工坊/无限画布</small></span>
        </div>
      </div>
    </section>
  );
}

function HomeInspirationSpotlights() {
  const showcaseCatalog = useManjuShowcaseCatalog();
  const items = useMemo(() => {
    const configured = applyManjuInspirationOverrides(OFFICIAL_INSPIRATION_ITEMS, showcaseCatalog);
    const byId = new Map(configured.map((item) => [item.id, item]));
    return INSPIRATION_SPOTLIGHT_IDS.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }, [showcaseCatalog]);

  return (
    <div className={styles.inspirationGrid}>
      {items.map((item) => (
        <Link href={`/inspiration?item=${encodeURIComponent(item.id)}`} key={item.id}>
          <span className={styles.inspirationArtwork}>
            <Image alt={item.imageAlt} fill sizes="(max-width: 767px) 100vw, (max-width: 1100px) 50vw, 25vw" src={item.previewPath || item.imagePath} unoptimized />
          </span>
          <span className={styles.inspirationCopy}><small>{item.category}</small><strong>{item.title}</strong></span>
        </Link>
      ))}
    </div>
  );
}

export function OfficialHomePage() {
  const router = useAppScopedRouter();
  const { state } = useApp();
  const [prompt, setPrompt] = useState("");

  function openAgent() {
    const value = prompt.trim();
    if (value) storeYoucaiAgentPrefill(value);
    router.push("/tools/text/text-chat");
  }

  return (
    <AppRouteShell>
      <main className={styles.page} data-testid="official-home-page">
        <section className={styles.promoStrip} data-testid="official-home-promo" aria-label="平台公告">
          <span><Clock3 size={15} /> 限时创作福利</span>
          <strong>多模态创作工具与精选模型，助你从灵感快速走向作品</strong>
          <Link href="/articles/changelog">查看更新 <ArrowRight size={14} /></Link>
        </section>

        <HomeHero />

        <section className={styles.memberStrip} data-testid="official-home-member-strip" aria-label="会员与积分状态">
          <span><CalendarCheck2 size={18} /> {state.auth.isAuthenticated ? "账户已连接" : "登录后同步创作权益"}</span>
          <p>{state.auth.isAuthenticated ? `当前可用 ${Number(state.credits?.remaining ?? 0).toLocaleString("zh-CN")} 积分，项目、素材与生成历史已同步。` : "使用同一账户访问模型、项目、素材、会员和积分。"}</p>
          <Link href={state.auth.isAuthenticated ? "/profile" : "/login?redirect=%2Fyoucai"}>{state.auth.isAuthenticated ? "查看账户" : "登录"} <ArrowRight size={14} /></Link>
        </section>

        <section className={styles.agentCard}>
          <div className={styles.agentHeading}>
            <span className={styles.agentIcon}><Bot size={22} /></span>
            <div><h2>说出灵感，让创意成为作品</h2><p>描述你的想法，Agent 会调用专业技能，并直接生成图片、音乐、音频或视频。</p></div>
            <span className={styles.agentBadge}>创作 Agent</span>
          </div>
          <textarea
            aria-label="描述创作需求"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                openAgent();
              }
            }}
            placeholder="例如：为国风茶饮品牌创作一张夏日海报，再配一段轻快的古筝音乐"
            rows={4}
            value={prompt}
          />
          <div className={styles.agentFooter}>
            <span>Enter 开始创作 · Shift+Enter 换行</span>
            <button disabled={!prompt.trim()} onClick={openAgent} type="button">开始创作 <Send size={16} /></button>
          </div>
        </section>

        <section className={styles.featureGrid}>
          {FEATURE_CARDS.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.title}>
                <span><Icon size={20} /></span>
                <div><h3>{item.title} <small>{item.badge}</small></h3><p>{item.text}</p></div>
              </article>
            );
          })}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><span>HOT TOOLS</span><h2>热门工具</h2><p>覆盖当前热门的视频、图像与音乐创作场景。</p></div>
          <div className={styles.toolGrid}>
            {TOOL_CARDS.map((item) => {
              const Icon = item.icon;
              const content = (
                <>
                  <span className={styles.toolArtwork}>
                    <Image alt={item.imageAlt} fill sizes="(max-width: 767px) 100vw, (max-width: 1024px) 50vw, 33vw" src={item.image} unoptimized />
                    <span className={styles.toolIcon}><Icon size={21} /></span>
                    <em>{item.label}</em>
                  </span>
                  <span className={styles.toolCopy}>
                    <h3>{item.title}</h3><p>{item.text}</p><small>{item.available ? <>进入工具 <ArrowRight size={13} /></> : item.statusLabel}</small>
                  </span>
                </>
              );

              if (!item.available) {
                return <article data-color={item.color} data-disabled="true" key={item.title}>{content}</article>;
              }

              return (
                <Link data-color={item.color} href={item.href} key={item.title}>
                  {content}
                </Link>
              );
            })}
          </div>
        </section>

        <section className={styles.filmSection}>
          <div>
            <span className={styles.eyebrow}><Film size={15} /> 影视创作工坊</span>
            <h2>从剧本到成片，全流程一站式创作</h2>
            <p>剧本创作、角色与场景设定、素材生成、分镜脚本和视频制作在同一项目中有序衔接。</p>
            <div className={styles.filmStages} aria-label="影视工坊五阶段">
              {FILM_STAGES.map((step, index) => {
                const Icon = step.icon;
                return (
                  <span key={step.title}>
                    <i><Icon size={16} /></i>
                    <strong>{index + 1}. {step.title}</strong>
                    <small>{step.text}</small>
                  </span>
                );
              })}
            </div>
            <Link className={styles.primaryAction} href="/tools/film-studio">进入影视工坊 <ArrowRight size={17} /></Link>
          </div>
          <Image alt="影视工坊视觉图" height={420} src="/short-drama/previews/film-studio-promo-bg-v2.webp" width={720} unoptimized />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeadingRow}>
            <div className={styles.sectionHeading}><span>INSPIRATION</span><h2>创作灵感</h2><p>探索角色、场景、道具、风格与分镜的创作方法。</p></div>
            <Link href="/inspiration">查看灵感广场 <ArrowRight size={15} /></Link>
          </div>
          <HomeInspirationSpotlights />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><span>CREATE</span><h2>创作入口</h2><p>按创作任务选择入口，在同一平台完成多模态内容生产。</p></div>
          <div className={styles.categoryGrid}>
            {CREATIVE_CATEGORIES.map((item) => {
              const Icon = item.icon;
              return <Link href={item.href} key={item.title}><Icon size={24} /><h3>{item.title}</h3><p>{item.text}</p><ArrowRight size={16} /></Link>;
            })}
          </div>
        </section>

        <section className={styles.cta}>
          <Sparkles size={32} />
          <h2>准备好开始创作了吗？</h2>
          <p>50+ AI 创作工具，让文字、画面、声音与影像在这里汇合。</p>
          <Link className={styles.primaryAction} href="/tools">开始创作 <ArrowRight size={17} /></Link>
        </section>
      </main>
    </AppRouteShell>
  );
}
