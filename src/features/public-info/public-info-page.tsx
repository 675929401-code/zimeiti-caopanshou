import { AppScopedLink as Link } from "@/components/app-scoped-link";
import {
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  Clapperboard,
  Layers3,
  Palette,
  ShieldCheck,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import styles from "./public-info-page.module.css";

type PublicInfoKind = "about" | "business";

interface InfoCard {
  title: string;
  description: string;
  Icon: LucideIcon;
}

const INFO_CONTENT: Record<PublicInfoKind, {
  eyebrow: string;
  title: string;
  description: string;
  cards: readonly InfoCard[];
}> = {
  about: {
    eyebrow: "关于平台",
    title: "把内容创作需要的 AI 工具放进同一个工作台",
    description: "自媒体操盘手围绕文案、图片、视频、配音、短剧与创作资产提供统一入口。账号、会员、积分和项目数据继续由主站管理，各专业工作台保持模块隔离。",
    cards: [
      { title: "统一创作入口", description: "从创作中心进入已接入并公开可用的主站工具。", Icon: Sparkles },
      { title: "影视项目工作流", description: "组织剧本、角色、场景、道具、分镜与视频生产步骤。", Icon: Clapperboard },
      { title: "多模态创作", description: "按实际可用模型完成文本、图片、视频和声音任务。", Icon: Bot },
      { title: "资产与记录", description: "登录后统一查看可恢复的素材、生成记录与项目数据。", Icon: Layers3 },
    ],
  },
  business: {
    eyebrow: "商务合作",
    title: "围绕内容生产链路开展能力合作",
    description: "合作范围以主站已经接入或经过验收的能力为准。模型、API、定制工作流与品牌方案会分别核验接口、权限、计费、结果存储和运行边界。",
    cards: [
      { title: "模型与 API 接入", description: "对接文本、生图、视频或声音服务，并按主站网关统一鉴权与结算。", Icon: BriefcaseBusiness },
      { title: "工作流定制", description: "根据内容生产场景组合提示词、任务状态、素材与项目步骤。", Icon: Palette },
      { title: "平台与团队应用", description: "在既有账号、会员与权限体系中提供相互隔离的专业应用。", Icon: Users },
      { title: "上线前验收", description: "接口可达、真实结果、持久化和计费证据完整后才标记为可用。", Icon: ShieldCheck },
    ],
  },
};

export function PublicInfoPage({ kind }: { kind: PublicInfoKind }) {
  const content = INFO_CONTENT[kind];

  return (
    <div className={styles.page} data-page={`public-info-${kind}`}>
      <section className={styles.hero}>
        <span className={styles.eyebrow}>{content.eyebrow}</span>
        <h1>{content.title}</h1>
        <p>{content.description}</p>
        <div className={styles.actions}>
          <Link className={styles.primaryAction} href="/tools">查看创作能力<ArrowRight size={16} /></Link>
          <Link className={styles.secondaryAction} href="/articles">阅读帮助文档</Link>
        </div>
      </section>

      <section className={styles.cardGrid} aria-label={`${content.eyebrow}内容`}>
        {content.cards.map(({ title, description, Icon }) => (
          <article className={styles.card} key={title}>
            <span className={styles.cardIcon} aria-hidden="true"><Icon size={23} /></span>
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <section className={styles.truthSection}>
        <CheckCircle2 size={23} aria-hidden="true" />
        <div>
          <h2>{kind === "business" ? "合作链路以真实能力为准" : "平台入口与主站数据相连"}</h2>
          <p>{kind === "business"
            ? "本页不提供虚假的在线提交成功状态。正式合作入口启用前，不会写入线索或触发外部服务。"
            : "公开页面可以浏览；项目、模型调用、会员、积分和个人资产仍需使用主站账号核验。"}</p>
        </div>
        <Link href={kind === "business" ? "/login?redirect=%2Fbusiness" : "/login"}>
          {kind === "business" ? "登录后继续" : "登录平台"}<ArrowRight size={15} />
        </Link>
      </section>
    </div>
  );
}
