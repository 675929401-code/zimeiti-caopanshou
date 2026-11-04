import {
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  Clapperboard,
  FileText,
  ImageIcon,
  Layers3,
  Palette,
  ShieldCheck,
  Sparkles,
  Users,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { AppScopedLink as Link } from "@/components/app-scoped-link";
import styles from "./youcai-info-page.module.css";

type InfoKind = "about" | "business";

interface Feature {
  title: string;
  description: string;
  Icon: LucideIcon;
}

interface InfoContent {
  eyebrow: string;
  title: string;
  description: string;
  primaryLabel: string;
  primaryHref: string;
  secondaryLabel: string;
  secondaryHref: string;
  featuresTitle: string;
  featuresDescription: string;
  features: readonly Feature[];
}

const CONTENT: Record<InfoKind, InfoContent> = {
  about: {
    eyebrow: "关于漫剧工作台",
    title: "让每一个创意，都能被看见",
    description: "漫剧工作台面向内容创作者，将文案、图像、音频、视频与影视制作组织在清晰的创作流程中，帮助灵感稳定地走向作品。",
    primaryLabel: "开始创作",
    primaryHref: "/tools",
    secondaryLabel: "阅读帮助文章",
    secondaryHref: "/articles",
    featuresTitle: "一站式 AI 创作体验",
    featuresDescription: "从想法整理到作品输出，为不同创作阶段提供适合的工具与工作台。",
    features: [
      { title: "多模态创作", description: "围绕文本、图片、音频与视频组织任务，按内容目标选择适合的创作方式。", Icon: WandSparkles },
      { title: "创作 Agent", description: "从一句需求开始，逐步整理创意、素材、提示词与输出要求。", Icon: Bot },
      { title: "影视工作流", description: "将剧本、角色、场景、道具、分镜与视频安排在连续的制作过程中。", Icon: Clapperboard },
      { title: "灵感与资产", description: "沉淀可参考的创作案例，并集中管理上传素材与创作结果。", Icon: Layers3 },
    ],
  },
  business: {
    eyebrow: "商务合作",
    title: "共建更高效的 AI 内容生产方式",
    description: "面向模型服务、品牌内容、团队工作流与创作生态，探索可持续、可管理的合作方案。",
    primaryLabel: "查看创作能力",
    primaryHref: "/tools",
    secondaryLabel: "了解漫剧工作台",
    secondaryHref: "/about",
    featuresTitle: "合作方向",
    featuresDescription: "围绕内容生产中的明确场景，设计能力范围、使用流程与交付标准。",
    features: [
      { title: "模型与技术合作", description: "围绕文本、图像、音频与视频能力，探索稳定的创作产品应用。", Icon: BriefcaseBusiness },
      { title: "品牌内容共创", description: "根据品牌调性、内容目标与渠道规格，设计从创意到成片的制作流程。", Icon: Palette },
      { title: "团队与组织应用", description: "按团队分工组织项目、素材、任务和作品，提升内容生产的协同效率。", Icon: Users },
      { title: "创作生态合作", description: "连接创作者、内容服务与专业工具，共同拓展 AI 创作的应用边界。", Icon: Sparkles },
    ],
  },
};

function Footer() {
  return (
    <footer className={styles.footer}>
        <span>© 2026 漫剧工作台</span>
      <span aria-hidden="true">·</span>
      <Link href="/about">关于我们</Link>
      <span aria-hidden="true">·</span>
      <Link href="/business">商务合作</Link>
    </footer>
  );
}

function CooperationProcess() {
  const steps = [
    { title: "场景沟通", description: "明确使用人群、内容目标、制作规模与关键约束。" },
    { title: "方案设计", description: "拆分功能边界、创作步骤、素材流转与交付标准。" },
    { title: "联调验收", description: "按典型内容任务检查操作体验、输出质量与处理效率。" },
    { title: "持续优化", description: "结合使用反馈和内容效果，逐步调整模板、工作流与质检标准。" },
  ] as const;

  return (
    <section className={styles.processSection}>
      <div className={styles.sectionHeading}>
        <span>合作过程</span>
        <h2>从创作场景出发</h2>
        <p>先明确问题与目标，再将方案拆成可检查的阶段。</p>
      </div>
      <ol className={styles.processGrid}>
        {steps.map((step, index) => (
          <li key={step.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <h3>{step.title}</h3>
            <p>{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AboutValues() {
  return (
    <section className={styles.valuesSection}>
      <article>
        <ShieldCheck aria-hidden="true" />
        <div><h2>清晰可控</h2><p>在任务开始前明确输入、参数和输出目标，便于调整与回顾。</p></div>
      </article>
      <article>
        <ImageIcon aria-hidden="true" />
        <div><h2>创作为本</h2><p>把工具融入内容生产过程，让创作者将精力放在表达与作品上。</p></div>
      </article>
      <article>
        <FileText aria-hidden="true" />
        <div><h2>持续积累</h2><p>将灵感、提示词、素材和项目组织起来，形成可继续打磨的创作资产。</p></div>
      </article>
    </section>
  );
}

export function YoucaiInfoPage({ kind }: { kind: InfoKind }) {
  const content = CONTENT[kind];

  return (
    <div className={styles.page}>
      <section className={styles.hero} data-kind={kind}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <div className={styles.heroContent}>
          <span className={styles.eyebrow}>{content.eyebrow}</span>
          <h1>{content.title}</h1>
          <p>{content.description}</p>
          <div className={styles.actions}>
            <Link className={styles.primaryAction} href={content.primaryHref}>
              {content.primaryLabel}<ArrowRight aria-hidden="true" />
            </Link>
            <Link className={styles.secondaryAction} href={content.secondaryHref}>
              {content.secondaryLabel}
            </Link>
          </div>
        </div>
        <div className={styles.heroVisual} aria-hidden="true">
          <span><Sparkles /></span>
          <span><FileText /></span>
          <span><ImageIcon /></span>
          <span><Clapperboard /></span>
          <div><Bot /></div>
        </div>
      </section>

      <section className={styles.featureSection}>
        <div className={styles.sectionHeading}>
          <span>{kind === "about" ? "创作能力" : "携手创作"}</span>
          <h2>{content.featuresTitle}</h2>
          <p>{content.featuresDescription}</p>
        </div>
        <div className={styles.featureGrid}>
          {content.features.map(({ title, description, Icon }) => (
            <article key={title}>
              <span><Icon aria-hidden="true" /></span>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      {kind === "business" ? <CooperationProcess /> : <AboutValues />}

      <section className={styles.ctaSection}>
        <div>
          <span>{kind === "about" ? <CheckCircle2 aria-hidden="true" /> : <BriefcaseBusiness aria-hidden="true" />}</span>
          <div>
            <h2>{kind === "about" ? "从一个灵感开始" : "从具体创作场景开始"}</h2>
            <p>{kind === "about" ? "选择适合的工具，把创意逐步转化为图片、音频或视频作品。" : "先浏览创作能力与帮助文章，明确需要解决的内容生产问题。"}</p>
          </div>
        </div>
        <Link className={styles.primaryAction} href={kind === "about" ? "/tools" : "/articles"}>
          {kind === "about" ? "进入创作中心" : "查看帮助中心"}<ArrowRight aria-hidden="true" />
        </Link>
      </section>

      <Footer />
    </div>
  );
}
