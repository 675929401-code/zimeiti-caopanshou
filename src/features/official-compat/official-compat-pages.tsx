"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import {
  ArrowRight,
  BookOpen,
  Check,
  Clapperboard,
  Clock3,
  Coins,
  Compass,
  Copy,
  Film,
  FolderOpen,
  Gift,
  ImageIcon,
  Loader2,
  Mic2,
  Search,
  Sparkles,
  Trophy,
  Tv,
  UserPlus,
  Users,
  Video,
  WalletCards,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LoginForm } from "@/components/login-form";
import { RechargeDialog } from "@/components/recharge-dialog";
import { useApp } from "@/contexts/app-context";
import { buildInvitationShareText } from "@/lib/invitation-share";
import styles from "./official-compat.module.css";

type ComingSoonKind = "tv" | "horizon";

const COMING_SOON_COPY: Record<ComingSoonKind, {
  eyebrow: string;
  title: string;
  description: string;
  Icon: LucideIcon;
  preview: readonly { title: string; description: string }[];
}> = {
  tv: {
    eyebrow: "成片广场",
    title: "优秀作品展示即将上线",
    description: "后续将集中展示由主站创作工具完成并由作者主动公开的短剧、动画与商业视频。",
    Icon: Tv,
    preview: [
      { title: "原创短剧", description: "按题材、画幅与更新状态浏览公开成片。" },
      { title: "动画作品", description: "展示无对白动画、口播动画与故事短片。" },
      { title: "创作档案", description: "在作者授权后关联作品使用的工具与流程。" },
    ],
  },
  horizon: {
    eyebrow: "创作赛事",
    title: "创作者赛事与激励计划即将上线",
    description: "赛事规则、投稿、评审和奖励链路尚在准备中；当前不会接受投稿或产生任何费用。",
    Icon: Trophy,
    preview: [
      { title: "主题赛道", description: "未来按短剧、动画、视觉与声音方向发布赛题。" },
      { title: "作品投稿", description: "投稿前会明确素材、版权、格式和公开范围。" },
      { title: "评审激励", description: "排名、奖励和发放状态将在正式上线后可追踪。" },
    ],
  },
};

export function ComingSoonPage({ kind }: { kind: ComingSoonKind }) {
  const copy = COMING_SOON_COPY[kind];
  const Icon = copy.Icon;

  return (
    <div className={styles.page} data-page={`official-compat-${kind}`}>
      <section className={styles.comingHero}>
        <span className={styles.eyebrow}>{copy.eyebrow}</span>
        <span className={styles.heroIcon} aria-hidden="true"><Icon size={34} /></span>
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
        <span className={styles.comingBadge}><Clock3 size={16} /> 即将上线</span>
      </section>

      <section className={styles.previewGrid} aria-label={`${copy.eyebrow}功能预告`}>
        {copy.preview.map((item, index) => (
          <article className={styles.previewCard} key={item.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <h2>{item.title}</h2>
            <p>{item.description}</p>
            <small>准备中</small>
          </article>
        ))}
      </section>
    </div>
  );
}

type ResourceCategory = "全部" | "创作平台" | "视觉工具" | "视频工具" | "音频工具" | "效率工具";

interface ResourceEntry {
  title: string;
  description: string;
  href: string;
  category: Exclude<ResourceCategory, "全部">;
  Icon: LucideIcon;
  tags: readonly string[];
}

const RESOURCE_CATEGORIES: readonly ResourceCategory[] = [
  "全部",
  "创作平台",
  "视觉工具",
  "视频工具",
  "音频工具",
  "效率工具",
];

const LOCAL_RESOURCES: readonly ResourceEntry[] = [
  {
    title: "AI 创作中心",
    description: "查看主站已接入的对话、生图、视频、影视和画布能力。",
    href: "/creation-center",
    category: "创作平台",
    Icon: Sparkles,
    tags: ["模型目录", "创作入口"],
  },
  {
    title: "影视工坊",
    description: "管理短剧项目，并进入剧本、角色、场景、分镜与成片流程。",
    href: "/short-drama",
    category: "创作平台",
    Icon: Film,
    tags: ["短剧", "项目"],
  },
  {
    title: "视频生成工作台",
    description: "统一提交、轮询、恢复、预览和下载主站视频任务。",
    href: "/video",
    category: "视频工具",
    Icon: Video,
    tags: ["视频生成", "任务恢复"],
  },
  {
    title: "故事版导演",
    description: "把文案整理为镜头、关键帧和图生视频制作节拍。",
    href: "/storyboard-workbench",
    category: "视频工具",
    Icon: Clapperboard,
    tags: ["分镜", "导演工作流"],
  },
  {
    title: "智音工坊",
    description: "使用主站已有音色、语音合成、音色设计与复刻能力。",
    href: "/voice-studio/workspace",
    category: "音频工具",
    Icon: Mic2,
    tags: ["配音", "TTS"],
  },
  {
    title: "内容工具箱",
    description: "集中处理智能分段、文案提取、视频解析与文字排版。",
    href: "/tools",
    category: "效率工具",
    Icon: Wrench,
    tags: ["提取", "排版"],
  },
  {
    title: "帮助中心",
    description: "搜索使用说明、常见问题与主站功能文档。",
    href: "/articles",
    category: "效率工具",
    Icon: BookOpen,
    tags: ["文档", "帮助"],
  },
];

export function ResourceNavigationPage() {
  const [category, setCategory] = useState<ResourceCategory>("全部");
  const [query, setQuery] = useState("");

  const visibleResources = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    return LOCAL_RESOURCES.filter((resource) => {
      if (category !== "全部" && resource.category !== category) return false;
      if (!keyword) return true;
      return [resource.title, resource.description, resource.category, ...resource.tags]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword));
    });
  }, [category, query]);

  return (
    <div className={styles.page} data-page="official-compat-navigation">
      <header className={styles.pageHeader}>
        <span className={styles.headerIcon} aria-hidden="true"><Compass size={26} /></span>
        <div>
          <span className={styles.eyebrow}>资源导航</span>
          <h1>主站创作资源目录</h1>
          <p>这里展示自媒体操盘手当前已有的本地入口；目录使用静态配置，不声称来自第三方或官网 API。</p>
        </div>
      </header>

      <section className={styles.resourceToolbar} aria-label="资源筛选">
        <label className={styles.searchBox}>
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="搜索资源"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索工具名称、能力或标签..."
          />
        </label>
        <div className={styles.categoryRow}>
          {RESOURCE_CATEGORIES.map((item) => (
            <button
              type="button"
              key={item}
              data-active={category === item ? "true" : undefined}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      {visibleResources.length > 0 ? (
        <section className={styles.resourceGrid} aria-live="polite">
          {visibleResources.map((resource) => {
            const Icon = resource.Icon;
            return (
              <Link className={styles.resourceCard} href={resource.href} key={resource.title}>
                <span className={styles.resourceIcon} aria-hidden="true"><Icon size={22} /></span>
                <div>
                  <span className={styles.resourceCategory}>{resource.category}</span>
                  <h2>{resource.title}</h2>
                  <p>{resource.description}</p>
                  <div className={styles.tagRow}>
                    {resource.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>
                </div>
                <ArrowRight className={styles.resourceArrow} size={18} aria-hidden="true" />
              </Link>
            );
          })}
        </section>
      ) : (
        <div className={styles.emptyState}>
          <Search size={28} aria-hidden="true" />
          <strong>没有匹配的本地资源</strong>
          <span>请更换关键词或分类。</span>
        </div>
      )}
    </div>
  );
}

function LoginPanel({ title, description }: { title: string; description: string }) {
  return (
    <section className={styles.loginSection} aria-labelledby="compat-login-title">
      <div className={styles.loginCopy}>
        <span className={styles.headerIcon} aria-hidden="true"><Users size={24} /></span>
        <div>
          <h2 id="compat-login-title">{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className={styles.loginFormWrap} data-login-drawer="light">
        <LoginForm />
      </div>
    </section>
  );
}

function useCheckedAuth() {
  const { state, dispatch, checkAuth } = useApp();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    void checkAuth()
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecked(true);
      });
    return () => { active = false; };
  }, [checkAuth]);

  return { state, dispatch, checked };
}

export function RechargeCompatPage() {
  const { state, dispatch, checked } = useCheckedAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loginVisible, setLoginVisible] = useState(false);
  const authenticated = state.auth.isAuthenticated && Boolean(state.auth.user && state.auth.token);
  const credits = Number(state.auth.user?.credits ?? state.credits.remaining ?? 0);

  const startRecharge = () => {
    if (!authenticated) {
      setLoginVisible(true);
      return;
    }
    setDialogOpen(true);
  };

  return (
    <div className={styles.page} data-page="official-compat-recharge">
      <header className={styles.pageHeader}>
        <span className={styles.headerIcon} aria-hidden="true"><WalletCards size={26} /></span>
        <div>
          <span className={styles.eyebrow}>积分充值</span>
          <h1>沿用主站真实支付与积分链路</h1>
          <p>本页不虚构套餐价格；实际金额、支付方式、订单状态和到账结果均由主站现有支付组件与接口处理。</p>
        </div>
      </header>

      <section className={styles.balanceStrip}>
        <div><span>当前积分</span><strong>{authenticated ? credits.toLocaleString("zh-CN") : "登录后查看"}</strong></div>
        <div><span>现金余额</span><strong>{authenticated ? `¥${Number(state.cashBalance || 0).toFixed(2)}` : "登录后查看"}</strong></div>
      </section>

      <section className={styles.purchaseGrid}>
        <article className={styles.purchaseCard}>
          <span className={styles.purchaseIcon}><Coins size={24} /></span>
          <h2>积分充值</h2>
          <p>用于主站已上线且通过验收的文本、图片、视频和语音能力；最终扣费仍以各工具实际结算为准。</p>
          <button type="button" onClick={startRecharge}>{authenticated ? "进入充值" : "登录后充值"}<ArrowRight size={16} /></button>
        </article>
        <article className={styles.purchaseCard}>
          <span className={styles.purchaseIcon}><WalletCards size={24} /></span>
          <h2>账户余额</h2>
          <p>继续使用主站现有现金充值、支付订单、状态轮询和到账校验，不在兼容页复制资金逻辑。</p>
          <button type="button" onClick={startRecharge}>{authenticated ? "打开支付组件" : "登录后查看"}<ArrowRight size={16} /></button>
        </article>
        <article className={styles.purchaseCard}>
          <span className={styles.purchaseIcon}><Gift size={24} /></span>
          <h2>卡密与会员</h2>
          <p>卡密兑换、会员状态和充值记录继续由个人中心管理。</p>
          <Link href="/profile?tab=cami">进入个人中心<ArrowRight size={16} /></Link>
        </article>
        <article className={styles.purchaseCard}>
          <span className={styles.purchaseIcon}><WalletCards size={24} /></span>
          <h2>发布套餐</h2>
          <p>开通发布中心权限后，可使用本站现金余额购买发布次数；可用套餐、价格和有效期以发布中心为准。</p>
          <Link href="/publish-center?tab=plans">查看发布套餐<ArrowRight size={16} /></Link>
        </article>
      </section>

      {!checked && <div className={styles.loadingState}><Loader2 className={styles.spin} size={20} /> 正在核验登录状态...</div>}
      {checked && loginVisible && !authenticated && (
        <LoginPanel title="登录后继续充值" description="这里使用主站原有登录、注册和验证码流程；登录完成后仍停留在充值页。" />
      )}

      <RechargeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        credits={credits}
        cashBalance={Number(state.cashBalance || 0)}
        mode="both"
        onCreditsUpdated={(nextCredits) => {
          dispatch({
            type: "SET_CREDITS",
            payload: { total: nextCredits, used: 0, remaining: nextCredits, costPerMessage: 0 },
          });
        }}
        onCashUpdated={(nextCash) => dispatch({ type: "SET_CASH_BALANCE", payload: nextCash })}
      />
    </div>
  );
}

interface InviteCode {
  id: string;
  code: string;
  is_used: boolean;
  used_at: string | null;
  created_at: string;
}

interface InviteRecord {
  id: string;
  invitee: { display_name: string; phone: string; member_status: string };
  invitee_activated: boolean;
  invited_at: string;
  activated_at: string | null;
}

interface InviteBenefit {
  id: string;
  title: string;
  content: string;
  created_at: string;
}

interface InvitationPayload<T> {
  success?: boolean;
  error?: string;
  codes?: InviteCode[];
  records?: InviteRecord[];
  benefits?: InviteBenefit[];
  stats?: { totalInvited?: number; activatedCount?: number };
  quota?: { monthlyLimit: number; issuedThisMonth: number; remainingThisMonth: number; resetsAt: string; canGenerate: boolean };
  code?: InviteCode;
  data?: T;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function ReferralCompatPage() {
  const { state, checked } = useCheckedAuth();
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [records, setRecords] = useState<InviteRecord[]>([]);
  const [benefits, setBenefits] = useState<InviteBenefit[]>([]);
  const [stats, setStats] = useState({ totalInvited: 0, activatedCount: 0 });
  const [quota, setQuota] = useState({ monthlyLimit: 6, issuedThisMonth: 0, remainingThisMonth: 0, resetsAt: "", canGenerate: false });
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");
  const token = state.auth.token;
  const authenticated = state.auth.isAuthenticated && Boolean(state.auth.user && token);
  const inviteOwnerEligible = state.auth.user?.role === "admin" || state.auth.user?.memberStatus === "active";
  const openCode = codes.find((item) => !item.is_used);

  const loadInvitationData = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [codesResponse, recordsResponse, benefitsResponse] = await Promise.all([
        fetch("/api/invitation/my-codes", { headers, cache: "no-store" }),
        fetch("/api/invitation/records", { headers, cache: "no-store" }),
        fetch("/api/invitation/benefits", { cache: "no-store" }),
      ]);
      const codesPayload = await codesResponse.json().catch(() => ({})) as InvitationPayload<never>;
      const recordsPayload = await recordsResponse.json().catch(() => ({})) as InvitationPayload<never>;
      const benefitsPayload = await benefitsResponse.json().catch(() => ({})) as InvitationPayload<never>;
      if (!codesResponse.ok) throw new Error(codesPayload.error || "邀请码加载失败");
      if (!recordsResponse.ok) throw new Error(recordsPayload.error || "邀请记录加载失败");
      if (codesPayload.success) setCodes(Array.isArray(codesPayload.codes) ? codesPayload.codes : []);
      if (codesPayload.quota) setQuota(codesPayload.quota);
      if (recordsPayload.success) {
        setRecords(Array.isArray(recordsPayload.records) ? recordsPayload.records : []);
        setStats({
          totalInvited: Number(recordsPayload.stats?.totalInvited || 0),
          activatedCount: Number(recordsPayload.stats?.activatedCount || 0),
        });
      }
      if (benefitsResponse.ok && benefitsPayload.success) {
        setBenefits(Array.isArray(benefitsPayload.benefits) ? benefitsPayload.benefits : []);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "推荐计划加载失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (authenticated) void loadInvitationData();
  }, [authenticated, loadInvitationData]);

  const generateCode = async () => {
    if (!token || generating || openCode || !inviteOwnerEligible || quota.remainingThisMonth <= 0) return;
    setGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/invitation/generate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({})) as InvitationPayload<never>;
      if (!response.ok || !payload.success || !payload.code) {
        if (payload.quota) setQuota(payload.quota);
        throw new Error(payload.error || "生成邀请码失败");
      }
      if (payload.quota) setQuota(payload.quota);
      await loadInvitationData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成邀请码失败");
    } finally {
      setGenerating(false);
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(buildInvitationShareText({ code, origin: window.location.origin }));
      setCopied(code);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("复制失败，请手动选择邀请码");
    }
  };

  if (!checked) {
    return <div className={styles.page}><div className={styles.loadingState}><Loader2 className={styles.spin} size={20} /> 正在核验登录状态...</div></div>;
  }

  if (!authenticated) {
    return (
      <div className={styles.page} data-page="official-compat-referral-login">
        <header className={styles.pageHeader}>
          <span className={styles.headerIcon} aria-hidden="true"><Gift size={26} /></span>
          <div>
            <span className={styles.eyebrow}>推荐计划</span>
            <h1>登录后查看推荐计划</h1>
            <p>当前 `/referral` 地址会保留；登录成功后直接显示邀请码、邀请记录和福利，不会跳到无关页面。</p>
          </div>
        </header>
        <LoginPanel title="使用主站账号登录" description="密码、验证码和注册均沿用主站现有认证流程。" />
      </div>
    );
  }

  return (
    <div className={styles.page} data-page="official-compat-referral">
      <header className={styles.pageHeader}>
        <span className={styles.headerIcon} aria-hidden="true"><Gift size={26} /></span>
        <div>
          <span className={styles.eyebrow}>推荐计划</span>
          <h1>邀请好友，共同创作</h1>
          <p>一枚邀请码只供一位好友注册；本月最多 {quota.monthlyLimit} 枚，复制时自动带上官网链接与注册说明。</p>
        </div>
        <Link className={styles.secondaryLink} href="/profile?tab=invitation">在个人中心查看<ArrowRight size={15} /></Link>
      </header>

      {error && <div className={styles.errorState} role="alert">{error}</div>}
      {loading ? (
        <div className={styles.loadingState}><Loader2 className={styles.spin} size={20} /> 正在加载推荐计划...</div>
      ) : (
        <>
          <section className={styles.statsGrid} aria-label="邀请统计">
            <article><strong>{stats.totalInvited}</strong><span>累计邀请人数</span></article>
            <article><strong>{stats.activatedCount}</strong><span>已激活会员</span></article>
            <article><strong>{codes.filter((item) => !item.is_used).length}</strong><span>可用邀请码</span></article>
          </section>

          {benefits.length > 0 && (
            <section className={styles.sectionCard}>
              <div className={styles.sectionHeading}><Gift size={20} /><div><h2>邀请福利</h2><p>福利内容由主站邀请配置返回。</p></div></div>
              <div className={styles.benefitList}>
                {benefits.map((benefit) => (
                  <article key={benefit.id}><strong>{benefit.title || "邀请福利"}</strong><p>{benefit.content}</p><small>{formatDate(benefit.created_at)}</small></article>
                ))}
              </div>
            </section>
          )}

          <section className={styles.sectionCard}>
            <div className={styles.sectionHeadingRow}>
              <div className={styles.sectionHeading}><Sparkles size={20} /><div><h2>我的邀请码</h2><p>一次一人；当前码使用后才能生成下一枚。</p></div></div>
              <button type="button" onClick={generateCode} disabled={generating || Boolean(openCode) || !inviteOwnerEligible || quota.remainingThisMonth <= 0}>
                {generating ? <Loader2 className={styles.spin} size={16} /> : <UserPlus size={16} />}
                {generating ? "生成中..." : openCode ? "已有可用码" : !inviteOwnerEligible ? "正式会员可生成" : quota.remainingThisMonth <= 0 ? "本月额度已用完" : codes.length > 0 ? "生成下一枚" : "生成邀请码"}
              </button>
            </div>
            {codes.length === 0 ? (
              <div className={styles.emptyInline}>你还没有邀请码。</div>
            ) : (
              <div className={styles.codeList}>
                {codes.map((item) => (
                  <article key={item.id} data-used={item.is_used ? "true" : undefined}>
                    <div><code>{item.code}</code><span>{item.is_used ? "已使用" : "可用"}</span></div>
                    <small>{formatDate(item.created_at)}</small>
                    {!item.is_used && (
                      <button type="button" onClick={() => copyCode(item.code)}>
                        {copied === item.code ? <Check size={15} /> : <Copy size={15} />}
                        {copied === item.code ? "邀请说明已复制" : "复制邀请说明"}
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className={styles.sectionCard}>
            <div className={styles.sectionHeading}><Users size={20} /><div><h2>我邀请的人</h2><p>激活状态来自主站邀请记录。</p></div></div>
            {records.length === 0 ? (
              <div className={styles.emptyInline}>暂无邀请记录。</div>
            ) : (
              <div className={styles.recordList}>
                {records.map((record) => (
                  <article key={record.id}>
                    <span className={styles.recordAvatar}>{record.invitee.display_name?.slice(0, 1) || "?"}</span>
                    <div><strong>{record.invitee.display_name || "未命名用户"}</strong><small>{record.invitee.phone || "未绑定手机"}</small></div>
                    <div className={styles.recordStatus} data-active={record.invitee_activated ? "true" : undefined}>
                      <span>{record.invitee_activated ? "已激活" : "未激活"}</span>
                      <small>{formatDate(record.invited_at)}</small>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
