"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clapperboard,
  FolderClock,
  Home,
  ImageIcon,
  Layers3,
  LayoutGrid,
  MessageSquareText,
  Mic2,
  PanelsTopLeft,
  PauseCircle,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
  UserRoundCog,
  WandSparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavButton, SubPageHeader } from "@/components/sub-page-header";
import { usePlatformBranding } from "@/hooks/use-platform-branding";
import { CREATION_CAPABILITIES, CREATION_SHOWCASES } from "@/lib/creation-center-catalog";
import type {
  CreationCapability,
  CreationCenterIcon,
  CreationShowcase,
  ModelMetricKey,
  ModelSummary,
} from "@/types/creation-center";
import styles from "@/app/creation-center/creation-center.module.css";

const ICONS: Record<CreationCenterIcon, LucideIcon> = {
  chat: MessageSquareText,
  image: ImageIcon,
  video: Clapperboard,
  shortDrama: Clapperboard,
  storyboard: PanelsTopLeft,
  canvas: Workflow,
  cover: WandSparkles,
  voice: Mic2,
  tools: Wrench,
  assets: FolderClock,
  digitalHuman: UserRoundCog,
};

const INITIAL_MODELS: ModelSummary = {
  chat: 0,
  image: 0,
  video: 0,
  videoAvailable: 0,
  state: "loading",
};

type PublicModel = {
  capabilities?: {
    available?: boolean;
  };
};

async function readModels(path: string): Promise<PublicModel[]> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  const payload = await response.json() as { models?: PublicModel[] };
  return Array.isArray(payload.models) ? payload.models : [];
}

function metricLabel(metric: ModelMetricKey | undefined, summary: ModelSummary): string | null {
  if (!metric) return null;
  if (summary.state === "loading") return "模型同步中";
  if (summary.state === "error") return "状态待恢复";
  if (metric === "chat") return `${summary.chat} 个对话模型`;
  if (metric === "image") return `${summary.image} 个生图模型`;
  return `${summary.videoAvailable}/${summary.video} 个视频模型可用`;
}

function CapabilityCard({ capability, summary }: { capability: CreationCapability; summary: ModelSummary }) {
  const Icon = ICONS[capability.icon];
  const metric = metricLabel(capability.metric, summary);
  const cardClassName = [styles.capabilityCard, styles[capability.accent], !capability.href ? styles.disabledCard : ""]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      <div className={styles.capabilityVisual} aria-hidden="true">
        <div className={styles.visualGrid} />
        <span className={styles.visualGlow} />
        <span className={styles.visualIcon}><Icon /></span>
        <span className={styles.visualLineOne} />
        <span className={styles.visualLineTwo} />
        {capability.status === "ready" && <span className={styles.liveDot} />}
      </div>
      <div className={styles.capabilityBody}>
        <div className={styles.cardTopline}>
          <span>{capability.eyebrow}</span>
          {capability.status === "paused" ? (
            <span className={styles.pausedBadge}><PauseCircle />维护中</span>
          ) : capability.status === "beta" ? (
            <span className={styles.betaBadge}>持续完善</span>
          ) : (
            <ArrowUpRight className={styles.cardArrow} aria-hidden="true" />
          )}
        </div>
        <h3>{capability.title}</h3>
        <p>{capability.description}</p>
        <div className={styles.cardFooter}>
          <span>{metric ?? (capability.href ? "进入原生工作台" : "协议适配完成后开放")}</span>
          {capability.href && <span className={styles.enterMark}>进入</span>}
        </div>
      </div>
    </>
  );

  if (!capability.href) {
    return <article className={cardClassName}>{content}</article>;
  }

  return (
    <Link
      className={cardClassName}
      href={capability.href}
      prefetch={capability.href === "/short-drama" ? false : undefined}
      aria-label={`进入${capability.title}`}
    >
      {content}
    </Link>
  );
}

function ShowcaseCard({ item, priority = false }: { item: CreationShowcase; priority?: boolean }) {
  return (
    <Link className={`${styles.showcaseCard} ${styles[item.accent]}`} href={item.href}>
      <div className={styles.showcaseMedia}>
        {item.kind === "video" ? (
          <video
            className={styles.showcaseVideo}
            src={item.source}
            poster={item.poster}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
          />
        ) : (
          <Image
            src={item.source}
            alt=""
            unoptimized
            fill
            priority={priority}
            sizes="(max-width: 760px) 100vw, (max-width: 1200px) 50vw, 33vw"
            className={styles.showcaseImage}
          />
        )}
        <div className={styles.mediaShade} />
        <span className={styles.playBadge}>{item.kind === "video" ? <Play /> : <Sparkles />}</span>
      </div>
      <div className={styles.showcaseCopy}>
        <span>{item.eyebrow}</span>
        <h3>{item.title}</h3>
        <p>{item.description}</p>
        <strong>打开工作流 <ArrowUpRight /></strong>
      </div>
    </Link>
  );
}

export function CreationCenterPage() {
  const platformBranding = usePlatformBranding();
  const platformName = platformBranding.brand.name || "自媒体操盘手";
  const [models, setModels] = useState<ModelSummary>(INITIAL_MODELS);

  useEffect(() => {
    let active = true;

    async function loadPublicStatus() {
      const [chatResult, imageResult, videoResult] = await Promise.allSettled([
        readModels("/api/chat-models"),
        readModels("/api/cover-models"),
        readModels("/api/video/models?surface=video-page"),
      ]);

      if (!active) return;

      const successfulModelCalls = [chatResult, imageResult, videoResult].filter((result) => result.status === "fulfilled").length;
      const chat = chatResult.status === "fulfilled" ? chatResult.value : [];
      const image = imageResult.status === "fulfilled" ? imageResult.value : [];
      const video = videoResult.status === "fulfilled" ? videoResult.value : [];

      setModels({
        chat: chat.length,
        image: image.length,
        video: video.length,
        videoAvailable: video.filter((model) => model.capabilities?.available !== false).length,
        state: successfulModelCalls === 3 ? "ready" : successfulModelCalls > 0 ? "partial" : "error",
      });
    }

    void loadPublicStatus();
    return () => { active = false; };
  }, []);

  const statusText = models.state === "loading"
    ? "正在同步主站能力"
    : models.state === "ready"
      ? "主站能力已连接"
      : models.state === "partial"
        ? "部分能力暂时不可见"
        : "能力状态稍后重试";

  return (
    <div className={`${styles.page} voice-studio-root vs-workbench`} data-page="creation-center">
      <SubPageHeader
        title={`${platformName} · AI创作中心`}
        subtitle="主站原生创作能力聚合入口"
        icon={<Sparkles className={styles.headerIcon} />}
        rightSlot={<NavButton icon={Home} label="应用广场" href="/" title="返回应用广场" />}
      />

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="creation-center-title">
          <div className={styles.heroNoise} aria-hidden="true" />
          <div className={styles.heroGlowOne} aria-hidden="true" />
          <div className={styles.heroGlowTwo} aria-hidden="true" />

          <div className={styles.heroCopy}>
            <div className={styles.heroEyebrow}><Radio /> ONE CREATIVE SYSTEM</div>
            <h1 id="creation-center-title">
              从一个灵感开始，<br />
              <span>完成整条内容生产线</span>
            </h1>
            <p>
              对话、图片、视频、故事板与画布集中在一个创作中心；每次生成前都能确认能力、价格和输入内容。
            </p>
            <div className={styles.heroActions}>
              <Link className={styles.secondaryAction} href="/video">
                <Clapperboard /> 进入视频工作台
              </Link>
            </div>
            <div className={styles.trustLine}>
              <span><ShieldCheck /> 账号数据隔离</span>
              <span><CheckCircle2 /> 费用记录清晰</span>
              <span><Layers3 /> 历史集中管理</span>
            </div>
          </div>

          <div className={styles.heroStage} aria-label="主站创作能力状态">
            <div className={styles.orbitLarge} />
            <div className={styles.orbitSmall} />
            <div className={styles.stageCore}>
              <Bot />
              <span>AI</span>
            </div>
            <div className={`${styles.floatingNode} ${styles.nodeChat}`}><MessageSquareText /><span>文案</span></div>
            <div className={`${styles.floatingNode} ${styles.nodeImage}`}><ImageIcon /><span>图片</span></div>
            <div className={`${styles.floatingNode} ${styles.nodeVideo}`}><Clapperboard /><span>视频</span></div>
            <div className={`${styles.floatingNode} ${styles.nodeFlow}`}><Workflow /><span>编排</span></div>
            <div className={styles.stageStatus}>
              <span className={models.state === "error" ? styles.statusError : styles.statusPulse} />
              {statusText}
            </div>
          </div>
        </section>

        <section className={styles.modelBar} aria-label="公开模型状态">
          <div className={styles.modelIntro}>
            <Activity />
            <div><strong>当前可用能力</strong><span>模型数量和状态实时更新</span></div>
          </div>
          <div className={styles.modelMetric}><span>对话模型</span><strong>{models.state === "loading" ? "—" : models.chat}</strong></div>
          <div className={styles.modelMetric}><span>生图模型</span><strong>{models.state === "loading" ? "—" : models.image}</strong></div>
          <div className={styles.modelMetric}>
            <span>视频可用</span>
            <strong>{models.state === "loading" ? "—" : `${models.videoAvailable}/${models.video}`}</strong>
          </div>
          <div className={styles.modelPrivacy}><ShieldCheck /> 提交前显示能力与价格</div>
        </section>

        <section className={styles.section} aria-labelledby="capability-title">
          <header className={styles.sectionHeader}>
            <div>
              <span className={styles.sectionKicker}>CREATIVE CAPABILITIES</span>
              <h2 id="capability-title">一站式创作工作台</h2>
              <p>每张卡片都指向主站真实功能；未完成适配的能力会明确标注。</p>
            </div>
            <Link className={styles.inlineLink} href="/video">进入视频创作 <ArrowUpRight /></Link>
          </header>
          <div className={styles.capabilityGrid}>
            {CREATION_CAPABILITIES.map((capability) => (
              <CapabilityCard key={capability.id} capability={capability} summary={models} />
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="inspiration-title">
          <header className={styles.sectionHeader}>
            <div>
              <span className={styles.sectionKicker}>INSPIRATION IN MOTION</span>
              <h2 id="inspiration-title">主站创作示例</h2>
              <p>展示主站现有帮助素材与真实工作流，不复制第三方官网演示资源。</p>
            </div>
            <span className={styles.rightNote}><Sparkles /> 本站素材</span>
          </header>
          <div className={styles.showcaseGrid}>
            {CREATION_SHOWCASES.map((item, index) => (
              <ShowcaseCard key={item.id} item={item} priority={index === 1} />
            ))}
          </div>
        </section>

        <section className={styles.workflowStrip} aria-label="创作流程">
          <div className={styles.workflowHeading}>
            <LayoutGrid />
            <div><span>从灵感到资产</span><strong>一条清晰的创作路径</strong></div>
          </div>
          <div className={styles.workflowSteps}>
            <div><b>01</b><span><strong>构思</strong><small>对话与故事板</small></span></div>
            <i />
            <div><b>02</b><span><strong>生成</strong><small>图片与视频</small></span></div>
            <i />
            <div><b>03</b><span><strong>编排</strong><small>画布与工具</small></span></div>
            <i />
            <div><b>04</b><span><strong>沉淀</strong><small>记录与资产</small></span></div>
          </div>
        </section>
      </main>
    </div>
  );
}
