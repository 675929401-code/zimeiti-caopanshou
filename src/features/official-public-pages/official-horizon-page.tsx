import { AppScopedLink } from "@/components/app-scoped-link";
import { CircleAlert, Trophy } from "lucide-react";
import type { CSSProperties } from "react";
import { PublicFooter } from "./official-public-page-shared";
import styles from "./official-public-pages.module.css";

const HORIZON_COPY = {
  title: "视界杯",
  description: "创作者激励活动与比赛，展示你的才华赢取丰厚奖励",
  background: "/cover-assets/business-landscape.png",
} as const;

export function OfficialHorizonPage() {
  return (
    <div
      className={styles.showcasePage}
      data-kind="horizon"
      data-page="youcai-horizon"
      style={{ "--showcase-image": `url(${HORIZON_COPY.background})` } as CSSProperties}
    >
      <div className={styles.showcaseShade} aria-hidden="true" />
      <header className={styles.showcaseContent} aria-labelledby="showcase-horizon-title">
        <span className={styles.showcaseIcon} aria-hidden="true">
          <Trophy size={42} strokeWidth={1.75} />
        </span>
        <h1 id="showcase-horizon-title">{HORIZON_COPY.title}</h1>
        <p>{HORIZON_COPY.description}</p>
        <span className={styles.launchState}>
          <i aria-hidden="true" />当前没有可核验的开放赛事
        </span>
      </header>

      <main className={styles.horizonState}>
        <section className={styles.showcaseEmptyState} role="status">
          <CircleAlert size={34} aria-hidden="true" />
          <h2>暂无公开报名中的视界杯赛事</h2>
          <p>当前源码没有可核验的赛事期次、报名规则、截止时间或奖项数据，因此不展示虚构倒计时和报名成功状态。</p>
          <p>
            视界杯会作为漫剧工作台的作品活动入口保留：后台发布真实赛事后，前台再展示报名时间、作品规则、奖励说明和作品提交状态；
            未发布前只提供安全空状态与创作入口，避免把测试活动或旧活动误部署到线上。
          </p>
          <dl>
            <div><dt>公开赛事</dt><dd>0 场</dd></div>
            <div><dt>报名入口</dt><dd>未开放</dd></div>
            <div><dt>自动提交</dt><dd>不会触发</dd></div>
            <div><dt>活动配置</dt><dd>待后台发布</dd></div>
            <div><dt>作品数据</dt><dd>不伪造</dd></div>
            <div><dt>上线策略</dt><dd>配置先行</dd></div>
          </dl>
          <div className={styles.showcaseActions}>
            <AppScopedLink href="/youcai-tv">浏览本站视频</AppScopedLink>
            <AppScopedLink href="/tools">进入创作中心</AppScopedLink>
            <AppScopedLink href="/articles">查看帮助中心</AppScopedLink>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
