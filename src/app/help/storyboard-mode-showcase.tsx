"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clapperboard,
  Clock3,
  Heart,
  ImageIcon,
  ShieldCheck,
  VideoOff,
  Zap,
} from "lucide-react";
import styles from "./help.module.css";

type StoryboardModeId = "exaggerated" | "cinematic" | "lyrical";

interface StoryboardSegment {
  time: string;
  copy: string;
}

interface StoryboardModeDefinition {
  id: StoryboardModeId;
  label: string;
  recordLabel: string;
  summary: string;
  applicability: string;
  alt: string;
  Icon: typeof Zap;
  segments: StoryboardSegment[];
}

interface StoryboardReviewCard {
  id?: StoryboardModeId;
  label?: string;
  imageStatus?: string;
  imagePath?: string;
  alt?: string;
  bytes?: number;
  sha256?: string;
}

interface StoryboardAssetManifest {
  schemaVersion?: number;
  kind?: string;
  assetReleaseId?: string;
  sourceReviewId?: string;
  cards?: StoryboardReviewCard[];
}

const MODE_ASSET_MANIFEST = "/product-assets/youcai-demo-v1/storyboard-modes/manifest.json";
const MODE_ASSET_PREFIX = "/product-assets/youcai-demo-v1/storyboard-modes/";
const GENERIC_VIDEO_PATH = "/help/storyboard-video-case.mp4";
const GENERIC_VIDEO_POSTER = "/help/storyboard-video-poster.png";
const GENERIC_VIDEO_CAPTIONS = "/help/storyboard-video-case.zh-CN.vtt";

const MODES: StoryboardModeDefinition[] = [
  {
    id: "exaggerated",
    label: "高能夸张",
    recordLabel: "故事版导演｜高能夸张",
    summary: "用弹起、追逐、急刹和尾巴旋风放大动作因果，首秒就建立强钩子。",
    applicability: "宠物趣味、反差喜剧、强节奏短视频，以及需要快速抓住注意力的开场。",
    alt: "高能夸张模式的五格真实故事板封面，展示主人离家、金毛追门、等待和重逢",
    Icon: Zap,
    segments: [
      { time: "0.0-1.8 秒", copy: "主人提起钥匙，金毛从地毯猛然弹起，动作和视线直指门锁。" },
      { time: "1.8-3.6 秒", copy: "金毛叼起拖鞋高速追门，急刹扬起尘屑，门缝冷光迅速收窄。" },
      { time: "3.6-5.6 秒", copy: "它伏在门边守着拖鞋，日光到夜色的长影压过地面，等待被具象化。" },
      { time: "5.6-7.4 秒", copy: "钥匙转动，瞳孔放大，琥珀色心跳波从门锁扩散，金毛完成跃起蓄力。" },
      { time: "7.4-10.0 秒", copy: "主人推门，金毛扑向怀抱，尾巴卷出金色旋风，最后稳定在重逢落幅。" },
    ],
  },
  {
    id: "cinematic",
    label: "影视叙事",
    recordLabel: "故事版导演｜电影叙事",
    summary: "强调空间方向、动作交接与镜头连续，让同一事件像短片一样自然推进。",
    applicability: "剧情短片、品牌故事、知识情境还原，以及重视人物关系和空间连续性的内容。",
    alt: "影视叙事模式的五格真实故事板封面，展示玄关空间中主人离开与金毛等待的连续镜头",
    Icon: Clapperboard,
    segments: [
      { time: "0.0-1.8 秒", copy: "中远景沿地毯推向玄关，主人拿起钥匙，金毛由趴卧转为起身。" },
      { time: "1.8-3.6 秒", copy: "低机位跟随关门，门外光扫过犬眼，并把注意力交给鞋柜下的拖鞋。" },
      { time: "3.6-5.5 秒", copy: "贴地横移跟拍金毛叼起拖鞋冲向门缝，急停后自然下沉身体。" },
      { time: "5.5-7.7 秒", copy: "稳定近景记录它守门等待，斜长日光从晚霞过渡到暮色。" },
      { time: "7.7-10.0 秒", copy: "镜头从门锁后拉，主人回家俯身迎接，金毛跃起后在暖光中收势。" },
    ],
  },
  {
    id: "lyrical",
    label: "抒情情感",
    recordLabel: "故事版导演｜抒情情感",
    summary: "用缓推、柔焦、光线迁移和细小回应积累情绪，把重逢放在克制的落点上。",
    applicability: "治愈陪伴、人物关系、纪念回忆，以及依靠氛围和细节建立共情的内容。",
    alt: "抒情情感模式的五格真实故事板封面，展示金毛守着拖鞋等待主人回家的温暖叙事",
    Icon: Heart,
    segments: [
      { time: "0.0-1.8 秒", copy: "镜头从鞋柜后缓慢推近，钥匙光斑滑向门锁，金毛起身望向门。" },
      { time: "1.8-3.7 秒", copy: "平稳横移跟随主人回望并拉门，金毛压低尾巴，追随逐渐消失的光。" },
      { time: "3.7-5.5 秒", copy: "贴地跟进金毛叼着拖鞋奔向门边，动作减速并落到等待姿态。" },
      { time: "5.5-7.6 秒", copy: "隔着柔焦窗帘缓移，午后光变成蓝紫暮色，犬眼高光始终留在门锁。" },
      { time: "7.6-10.0 秒", copy: "门锁亮起，主人伸手靠近犬鼻，暖金微光升起消散，停在即将触碰的一刻。" },
    ],
  },
];

function trustedCoverPath(card: StoryboardReviewCard | undefined): string {
  if (!card || card.imageStatus !== "ready" || !card.imagePath) return "";
  return card.imagePath.startsWith(MODE_ASSET_PREFIX) && !card.imagePath.includes("..")
    ? card.imagePath
    : "";
}

function StoryboardCover({ mode, src }: { mode: StoryboardModeDefinition; src: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className={styles.modeMediaUnavailable} role="status">
        <AlertCircle aria-hidden="true" />
        <strong>参考封面当前不可访问</strong>
        <span>未使用替代图或模拟结果。</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={mode.alt} onError={() => setFailed(true)} />
  );
}

export function StoryboardModeShowcase() {
  const [activeId, setActiveId] = useState<StoryboardModeId>(MODES[0].id);
  const [assetManifest, setAssetManifest] = useState<StoryboardAssetManifest | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(MODE_ASSET_MANIFEST, { cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error("故事板产品素材清单不可访问");
        return response.json() as Promise<StoryboardAssetManifest>;
      })
      .then((manifest) => {
        if (cancelled) return;
        if (
          manifest.schemaVersion !== 1
          || manifest.kind !== "curated-storyboard-mode-covers"
          || manifest.assetReleaseId !== "youcai-demo-v1"
          || !Array.isArray(manifest.cards)
        ) {
          throw new Error("故事板产品素材清单不匹配");
        }
        setAssetManifest(manifest);
      })
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const activeIndex = MODES.findIndex((mode) => mode.id === activeId);
  const activeMode = MODES[activeIndex] || MODES[0];
  const activeCard = assetManifest?.cards?.find((card) => card.id === activeMode.id && card.label === activeMode.recordLabel);
  const coverUrl = trustedCoverPath(activeCard);

  const selectTab = (index: number) => {
    const normalized = (index + MODES.length) % MODES.length;
    setActiveId(MODES[normalized].id);
    tabRefs.current[normalized]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectTab(index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectTab(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab(MODES.length - 1);
    }
  };

  return (
    <section className={styles.modeShowcase} aria-labelledby="storyboard-modes-title">
      <header className={styles.modeShowcaseHeader}>
        <div>
          <span className={styles.modeEyebrow}>真实案例资产</span>
          <h2 id="storyboard-modes-title">三种故事版导演模式</h2>
          <p>同一段主人离家、金毛等待与重逢的文案，分别采用夸张、影视和抒情节奏。</p>
        </div>
        <span
          className={styles.modeVerified}
          data-status={loadFailed ? "unavailable" : assetManifest ? "verified" : "loading"}
          role="status"
        >
          {loadFailed ? <AlertCircle aria-hidden="true" /> : assetManifest ? <ShieldCheck aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
          {loadFailed ? "产品素材不可访问" : assetManifest ? "本地素材清单已核验" : "正在核验产品素材"}
        </span>
      </header>

      <div className={styles.modeOverview}>
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/help/storyboard-workbench.png" alt="分镜工作台真实桌面截图，右侧显示三张故事版任务卡" />
          <figcaption><ImageIcon aria-hidden="true" />页面实拍 · 2026-08-14</figcaption>
        </figure>
        <div className={styles.modeAuditNote}>
          <strong>资产口径</strong>
          <p>封面示例已稳定保存；当前暂无可直接播放的三模式示例视频。</p>
          <span>素材版本：youcai-demo-v1</span>
        </div>
      </div>

      <section className={styles.modeDemoVideo} aria-labelledby="storyboard-generic-video-title">
        <div className={styles.modeDemoVideoCopy}>
          <span className={styles.modeEyebrow}>真实可播放素材</span>
          <h3 id="storyboard-generic-video-title">故事板图生视频通用样片</h3>
          <p>该片段来自本地 live 测试归档，用于演示“故事板参考图进入视频”的实际结果。它不冒充高能、影视或抒情三种模式的专属成片。</p>
          <span className={styles.modeDemoAudit}><AlertCircle aria-hidden="true" />任务记录与公开模型名仍待补齐核验</span>
        </div>
        <div className={styles.modeDemoVideoFrame}>
          <video controls preload="metadata" poster={GENERIC_VIDEO_POSTER} aria-label="故事板图生视频通用样片">
            <source src={GENERIC_VIDEO_PATH} type="video/mp4" />
            <track kind="captions" src={GENERIC_VIDEO_CAPTIONS} srcLang="zh-CN" label="中文说明" default />
            当前浏览器暂不支持播放该视频。
          </video>
        </div>
      </section>

      <div className={styles.modeTabs} role="tablist" aria-label="故事版导演模式">
        {MODES.map((mode, index) => {
          const selected = mode.id === activeMode.id;
          const Icon = mode.Icon;
          return (
            <button
              key={mode.id}
              ref={(node) => { tabRefs.current[index] = node; }}
              type="button"
              role="tab"
              id={`storyboard-tab-${mode.id}`}
              aria-controls={`storyboard-panel-${mode.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? styles.modeTabActive : ""}
              data-mode={mode.id}
              onClick={() => setActiveId(mode.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <Icon aria-hidden="true" />
              <span><strong>{mode.label}</strong><small>{index + 1} / {MODES.length}</small></span>
            </button>
          );
        })}
      </div>

      <article
        id={`storyboard-panel-${activeMode.id}`}
        className={styles.modePanel}
        role="tabpanel"
        aria-labelledby={`storyboard-tab-${activeMode.id}`}
        tabIndex={0}
      >
        <div className={styles.modePanelHeading}>
          <div><span>{activeMode.label}</span><h3>{activeMode.summary}</h3></div>
          <span className={styles.modeDuration}><Clock3 aria-hidden="true" />约 10 秒 · 5 段</span>
        </div>

        <div className={styles.modePanelGrid}>
          <section className={styles.modeCoverBlock} aria-labelledby={`mode-cover-${activeMode.id}`}>
            <div className={styles.modeBlockHeading}>
              <strong id={`mode-cover-${activeMode.id}`}>参考封面 / 故事板</strong>
              {coverUrl && !loadFailed && <span><CheckCircle2 aria-hidden="true" />真实生成</span>}
            </div>
            <div className={styles.modeCoverFrame}>
              {loadFailed ? (
                <div className={styles.modeMediaUnavailable} role="status">
                  <AlertCircle aria-hidden="true" />
                  <strong>产品素材暂时不可访问</strong>
                  <span>请核对资产 READY 清单与当前版本是否匹配。</span>
                </div>
              ) : assetManifest ? <StoryboardCover key={activeMode.id} mode={activeMode} src={coverUrl} /> : (
                <div className={styles.modeMediaLoading} role="status"><ImageIcon aria-hidden="true" /><span>正在核验版本化封面</span></div>
              )}
            </div>
            <p className={styles.modeSource}>来源：<span>product-assets/youcai-demo-v1/storyboard-modes</span></p>
          </section>

          <section className={styles.modeTimelineBlock} aria-labelledby={`mode-timeline-${activeMode.id}`}>
            <div className={styles.modeBlockHeading}><strong id={`mode-timeline-${activeMode.id}`}>约 10 秒分段文案</strong></div>
            <ol className={styles.modeTimeline}>
              {activeMode.segments.map((segment, index) => (
                <li key={segment.time}>
                  <span>{index + 1}</span>
                  <div><time>{segment.time}</time><p>{segment.copy}</p></div>
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.modeVideoBlock} aria-labelledby={`mode-video-${activeMode.id}`}>
            <div className={styles.modeBlockHeading}><strong id={`mode-video-${activeMode.id}`}>视频演示</strong></div>
            <div className={styles.modeVideoPending} role="status">
              <VideoOff aria-hidden="true" />
              <div><strong>待补充演示</strong><p>当前没有可公开访问的该模式真实视频文件，不使用通用视频或动画占位冒充。</p></div>
            </div>
          </section>

          <section className={styles.modeUseBlock} aria-labelledby={`mode-use-${activeMode.id}`}>
            <div className={styles.modeBlockHeading}><strong id={`mode-use-${activeMode.id}`}>适用场景</strong></div>
            <p>{activeMode.applicability}</p>
          </section>
        </div>
      </article>
    </section>
  );
}
