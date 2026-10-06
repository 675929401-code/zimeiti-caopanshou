"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  Clapperboard,
  Database,
  FolderOpen,
  Image as ImageIcon,
  LayoutDashboard,
  Lightbulb,
  MessageSquareText,
  Music2,
  Palette,
  RefreshCw,
  ShieldCheck,
  Video,
} from "lucide-react";
import type {
  ManjuAcceptanceState,
  ManjuModelFamily,
  ManjuModelFamilyStatus,
} from "@/lib/manju-workbench-status";
import { ManjuConfigCenter } from "./ManjuConfigCenter";
import styles from "./ManjuWorkbenchAdminTab.module.css";

const ManjuPromptInspector = dynamic(
  () => import("./ManjuPromptInspector").then((module) => module.ManjuPromptInspector),
  { ssr: false, loading: () => <div className={styles.loading}>正在载入提示词事实源…</div> },
);

const ManjuShowcaseCatalogManager = dynamic(
  () => import("./ManjuShowcaseCatalogManager").then((module) => module.ManjuShowcaseCatalogManager),
  { ssr: false, loading: () => <div className={styles.loading}>正在载入展示内容管理器…</div> },
);

const ManjuSkillManager = dynamic(
  () => import("./ManjuSkillManager").then((module) => module.ManjuSkillManager),
  { ssr: false, loading: () => <div className={styles.loading}>正在载入 Skill 治理矩阵…</div> },
);

const ManjuCustomSkillPackageManager = dynamic(
  () => import("./ManjuCustomSkillPackageManager").then((module) => module.ManjuCustomSkillPackageManager),
  { ssr: false, loading: () => <div className={styles.loading}>正在载入用户自建 Skill 包管理器…</div> },
);

interface ManjuStatusPayload {
  application: {
    id: string;
    name: string;
    publicRoute: string;
    accountMode: string;
    billingMode: string;
    assetMode: string;
    modelPolicy: string;
  };
  truthBoundary: {
    configuredMeans: string;
    availableMeans: string;
    verifiedMeans: string;
    limitation: string;
  };
  families: ManjuModelFamilyStatus[];
  generatedAt: string;
}

interface Props {
  token: string;
  onOpenModels: () => void;
  onOpenVoiceStudio: () => void;
}

const FAMILY_ICON: Record<ManjuModelFamily, typeof MessageSquareText> = {
  text: MessageSquareText,
  image: ImageIcon,
  video: Video,
  audio: Music2,
};

const ACCEPTANCE_LABEL: Record<ManjuAcceptanceState, string> = {
  evidence_complete: "证据齐全",
  evidence_pending: "等待验收",
  legacy_unverified: "可见未验收",
  not_available: "当前不可用",
};

const APP_MODULES = [
  { label: "工作台首页", description: "检查首屏与公告内容", href: "/youcai", icon: LayoutDashboard },
  { label: "影视工坊", description: "检查项目与制作流程", href: "/youcai/tools/film-studio", icon: Clapperboard },
  { label: "漫剧画布", description: "检查示例、节点与连线", href: "/youcai/tools/canvas", icon: Palette },
  { label: "灵感广场", description: "检查图片、视频与音频", href: "/youcai/inspiration", icon: Lightbulb },
  { label: "创作 Agent", description: "检查对话与多模态入口", href: "/youcai/tools/text/text-chat", icon: MessageSquareText },
  { label: "个人资产", description: "检查真实生成记录", href: "/youcai/assets", icon: FolderOpen },
] as const;

const GOVERNANCE_AREAS = [
  { name: "运行状态", state: "只读审计", detail: "可查账户、计费、资产与模型接入状态。" },
  { name: "配置内容", state: "草稿与发布已分离", detail: "漫剧自己的导航、提示词、示例、素材、启停、排序与回滚必须在本页闭环，不借主站 Skill/Agent 市场。" },
  { name: "前台生效", state: "公开与私有分流", detail: "前台仅读取 content、media、feature_flags；私有 Prompt 只进漫剧创作 Agent 服务端链路。" },
  { name: "模型与计费", state: "由主站管理", detail: "继续使用统一模型管理和主站积分协议。" },
] as const;

const ADMIN_QUICK_ENTRIES = [
  { label: "配置中心", description: "提示词、导航、功能开关与发布回滚", href: "#manju-config-center", icon: Database },
  { label: "内置 Skill", description: "36 张 Skill 专家卡片逐张治理", href: "#manju-skill-manager", icon: MessageSquareText },
  { label: "用户 Skill", description: "客户自建/导入 Skill 包生命周期", href: "#manju-custom-skill-packages", icon: FolderOpen },
  { label: "提示词事实源", description: "核对漫剧 Agent 私有 Prompt 来源", href: "#manju-prompt-inspector", icon: ShieldCheck },
  { label: "素材示例", description: "上传、登记、启停与示例映射", href: "#manju-showcase-catalog", icon: ImageIcon },
] as const;

export function ManjuWorkbenchAdminTab({ token, onOpenModels, onOpenVoiceStudio }: Props) {
  const [payload, setPayload] = useState<ManjuStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/manju-workbench/status", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({})) as ManjuStatusPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || "漫剧工作台配置状态读取失败");
      setPayload(body);
    } catch (reason) {
      setPayload(null);
      setError(reason instanceof Error ? reason.message : "漫剧工作台配置状态读取失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <section className={styles.page} data-admin-panel="manju-workbench">
      <header className={styles.header}>
        <div>
          <span>主站适配层 · 独立应用状态</span>
          <h2>漫剧工作台</h2>
          <p>从当前接入层证据看，上游底座不含完整主站级 SaaS 管理后台；本页是主站为漫剧分支建立的独立接入、巡检与治理适配层。</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" onClick={() => void loadStatus()} disabled={loading}>
            <RefreshCw size={15} />{loading ? "读取中" : "刷新状态"}
          </button>
          <a href="/youcai" target="_blank" rel="noreferrer">
            打开漫剧工作台<ArrowUpRight size={15} />
          </a>
        </div>
      </header>

      <nav className={styles.quickNav} aria-label="漫剧工作台管理员快速入口">
        <div>
          <span>管理员治理入口</span>
          <strong>先改后台事实源，再看前台是否生效</strong>
        </div>
        <div>
          {ADMIN_QUICK_ENTRIES.map((entry) => {
            const Icon = entry.icon;
            return (
              <a key={entry.href} href={entry.href}>
                <Icon size={17} />
                <span><strong>{entry.label}</strong><small>{entry.description}</small></span>
              </a>
            );
          })}
        </div>
      </nav>

      <section className={styles.moduleSection} aria-labelledby="manju-module-heading">
        <div className={styles.sectionHeading}>
          <span>01</span>
          <div>
            <h3 id="manju-module-heading">前台模块巡检</h3>
            <p>以管理员身份在新页签打开，不离开当前后台。</p>
          </div>
        </div>
        <div className={styles.moduleGrid}>
          {APP_MODULES.map((module) => {
            const Icon = module.icon;
            return (
              <a key={module.href} href={module.href} target="_blank" rel="noreferrer">
                <span><Icon size={19} /></span>
                <div><strong>{module.label}</strong><small>{module.description}</small></div>
                <ArrowUpRight size={15} />
              </a>
            );
          })}
        </div>
      </section>

      <section className={styles.governanceSection} aria-labelledby="manju-governance-heading">
        <div className={styles.sectionHeading}>
          <span>02</span>
          <div>
            <h3 id="manju-governance-heading">管理边界</h3>
            <p>只展示已经真实实现的能力，不把硬编内容包装成可编辑后台。</p>
          </div>
        </div>
        <div className={styles.governanceGrid}>
          {GOVERNANCE_AREAS.map((area) => (
            <article key={area.name}>
              <div><strong>{area.name}</strong><em>{area.state}</em></div>
              <p>{area.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <div className={styles.boundary} role="note">
        <AlertTriangle size={20} />
        <div>
          <strong>不把“有记录”写成“已经配好”</strong>
          <p>{payload?.truthBoundary.limitation || "正在读取分支与统一模型池的边界。"}</p>
        </div>
      </div>

      <div className={styles.sectionHeading}>
        <span>03</span>
        <div><h3>应用接入契约</h3><p>漫剧分支与主站共享的责任边界。</p></div>
      </div>
      <div className={styles.contractGrid} aria-label="应用接入方式">
        <article><small>账户</small><strong>共用主站登录</strong><span>分支个人中心留在 /youcai/profile</span></article>
        <article><small>计费</small><strong>共用主站积分协议</strong><span>充值入口留在 /youcai/recharge</span></article>
        <article><small>资产</small><strong>共用生成记录与存储索引</strong><span>只有真实落库结果才显示</span></article>
        <article><small>模型</small><strong>读取主站统一模型池</strong><span>目前没有分支专属白名单</span></article>
      </div>

      <div className={styles.sectionHeading}>
        <span>04</span>
        <div><h3>配置控制平面</h3><p>统一管理漫剧工作台自己的提示词、导航、示例、素材映射、功能开关、草稿、发布与回滚；不是主站 Skill 应用广场或智能体卡片后台。</p></div>
      </div>
      <ManjuConfigCenter token={token} />

      <div className={styles.sectionHeading}>
        <span>05</span>
        <div><h3>Skill 治理矩阵</h3><p>逐张映射 Skill 专家卡片：平台内置由管理员配置，用户自建走 Skill 包生命周期。</p></div>
      </div>
      <ManjuSkillManager token={token} />

      <div className={styles.sectionHeading}>
        <span>06</span>
        <div><h3>用户自建 / 导入 Skill 包</h3><p>新增、校验、编辑草稿、发布与回滚用户可定制 Skill；不混入 36 项平台内置 Skill。</p></div>
      </div>
      <ManjuCustomSkillPackageManager token={token} />

      <div className={styles.sectionHeading}>
        <span>07</span>
        <div><h3>提示词事实源</h3><p>只对照漫剧工作台自己的运行 Prompt；主站 Agent 卡片、Skill 应用广场和通用画布方案不进入这里。</p></div>
      </div>
      <ManjuPromptInspector token={token} />

      <div className={styles.sectionHeading}>
        <span>08</span>
        <div><h3>展示内容与素材示例</h3><p>二进制留在版本化资产包或 COS；后台只发布素材 ID、排序、启停和稀疏文案覆盖。</p></div>
      </div>
      <ManjuShowcaseCatalogManager token={token} />

      {error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={19} />
          <div><strong>状态读取失败</strong><p>{error}</p></div>
          <button type="button" onClick={() => void loadStatus()}>重试</button>
        </div>
      ) : null}

      {loading && !payload ? (
        <div className={styles.loading} role="status"><CircleDashed size={21} />正在读取四类模型绑定…</div>
      ) : null}

      {payload ? (
        <>
          <div className={styles.sectionHeading}>
            <span>09</span>
            <div><h3>统一模型状态</h3><p>以绑定、可用和真实验收三个口径分别展示。</p></div>
          </div>
          <div className={styles.familyGrid}>
            {payload.families.map((family) => {
              const Icon = FAMILY_ICON[family.family];
              return (
                <article className={styles.familyCard} key={family.family} data-family={family.family}>
                  <div className={styles.familyHeader}>
                    <span><Icon size={21} /></span>
                    <div><h3>{family.label}</h3><p>来源：{family.source}</p></div>
                    {family.loadError ? <em data-state="error">读取失败</em> : <em>{family.records} 条</em>}
                  </div>
                  <dl className={styles.counts}>
                    <div><dt>启用</dt><dd>{family.active}</dd></div>
                    <div><dt>可见</dt><dd>{family.visible}</dd></div>
                    <div><dt>绑定完整</dt><dd>{family.bindingComplete}</dd></div>
                    <div><dt>证据齐全</dt><dd>{family.evidenceComplete}</dd></div>
                  </dl>
                  {family.loadError ? (
                    <p className={styles.familyError}>{family.loadError}；不能据此判断模型为空或已经配置。</p>
                  ) : family.models.length === 0 ? (
                    <p className={styles.familyEmpty}>没有读取到配置记录。</p>
                  ) : (
                    <ul className={styles.modelList}>
                      {family.models.slice(0, 8).map((model) => (
                        <li key={model.id}>
                          <div>
                            <strong>{model.name}</strong>
                            <span>{model.reason}</span>
                          </div>
                          <em data-state={model.acceptance}>
                            {model.acceptance === "evidence_complete" ? <CheckCircle2 size={13} /> : null}
                            {ACCEPTANCE_LABEL[model.acceptance]}
                          </em>
                        </li>
                      ))}
                    </ul>
                  )}
                  {family.models.length > 8 ? <p className={styles.more}>另有 {family.models.length - 8} 条记录，请在统一模型管理查看。</p> : null}
                </article>
              );
            })}
          </div>

          <section className={styles.truthSection}>
            <Database size={20} />
            <div>
              <h3>状态口径</h3>
              <p><strong>绑定：</strong>{payload.truthBoundary.configuredMeans}</p>
              <p><strong>可用：</strong>{payload.truthBoundary.availableMeans}</p>
              <p><strong>已验收：</strong>{payload.truthBoundary.verifiedMeans}</p>
              <small>状态快照：{new Date(payload.generatedAt).toLocaleString("zh-CN")}</small>
            </div>
          </section>
        </>
      ) : null}

      <footer className={styles.footerActions}>
        <button type="button" onClick={onOpenModels}>前往统一模型管理</button>
        <button type="button" onClick={onOpenVoiceStudio}>前往智音工坊配置</button>
        <span>本页不修改模型、不调用模型，也不产生积分或外部费用。</span>
      </footer>
    </section>
  );
}
