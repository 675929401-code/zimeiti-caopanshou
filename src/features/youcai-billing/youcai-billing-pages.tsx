"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { RechargeDialog } from "@/components/recharge-dialog";
import { useApp } from "@/contexts/app-context";
import { buildInvitationShareText } from "@/lib/invitation-share";
import {
  ArrowRight,
  BadgeCheck,
  Check,
  Coins,
  Copy,
  Gift,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  WalletCards,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./youcai-billing-pages.module.css";

type RechargeMode = "credits" | "cash";

interface InviteCode {
  id: string;
  code: string;
  is_used: boolean;
  used_at?: string | null;
  created_at?: string;
}

interface InviteRecord {
  id: string;
  invitee: {
    display_name: string;
    phone: string;
    member_status: string;
  };
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

interface InvitationStats {
  totalInvited?: number;
  activatedCount?: number;
}

interface InvitationQuota {
  monthlyLimit: number;
  issuedThisMonth: number;
  remainingThisMonth: number;
  resetsAt: string;
  canGenerate: boolean;
}

interface MyCodesPayload {
  codes?: InviteCode[];
  stats?: InvitationStats;
  quota?: InvitationQuota;
  error?: string;
}

interface RecordsPayload {
  success?: boolean;
  records?: InviteRecord[];
  stats?: InvitationStats;
  error?: string;
}

interface BenefitsPayload {
  success?: boolean;
  benefits?: InviteBenefit[];
  error?: string;
}

interface GeneratePayload {
  id?: string;
  code?: string | InviteCode;
  message?: string;
  quota?: InvitationQuota;
  error?: string;
}

function useCheckedAuth() {
  const { state, dispatch, checkAuth, fetchCredits } = useApp();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    const deadline = window.setTimeout(() => {
      if (active) setChecked(true);
    }, 8_000);
    void checkAuth()
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(deadline);
        if (active) setChecked(true);
      });
    return () => {
      active = false;
      window.clearTimeout(deadline);
    };
  }, [checkAuth]);

  const authenticated = state.auth.isAuthenticated
    && Boolean(state.auth.user && state.auth.token);

  return { state, dispatch, fetchCredits, checked, authenticated };
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite">
      <Loader2 className={styles.spin} size={20} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function LoginPrompt({
  title,
  description,
  redirect,
}: {
  title: string;
  description: string;
  redirect: "/recharge" | "/referral";
}) {
  return (
    <section className={styles.loginPrompt} aria-label="登录提示">
      <span className={styles.loginIcon} aria-hidden="true"><ShieldCheck size={30} /></span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <Link className={styles.primaryLink} href={`/login?redirect=${encodeURIComponent(redirect)}`}>
        立即登录 <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </section>
  );
}

function memberStatusLabel(status?: string) {
  if (status === "active") return "正式会员";
  if (status === "trial") return "体验会员";
  if (status === "expired") return "会员已到期";
  return "会员未激活";
}

export function YoucaiRechargePage() {
  const { state, dispatch, fetchCredits, checked, authenticated } = useCheckedAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<RechargeMode>("credits");

  useEffect(() => {
    if (checked && authenticated) void fetchCredits();
  }, [authenticated, checked, fetchCredits]);

  const credits = Number(state.credits.remaining ?? state.auth.user?.credits ?? 0);
  const cashBalance = Number(state.cashBalance || 0);
  const displayName = state.auth.user?.displayName || state.auth.user?.username || "创作者";

  const openRecharge = (mode: RechargeMode) => {
    setDialogMode(mode);
    setDialogOpen(true);
  };

  return (
    <div className={styles.page} data-page="youcai-recharge">
      <header className={styles.titleBlock}>
        <span className={styles.titleIcon} aria-hidden="true"><Zap size={28} /></span>
        <h1>积分充值</h1>
        <p>查看账户余额、会员状态与充值入口</p>
      </header>

      {!checked ? (
        <LoadingState label="正在读取账户信息..." />
      ) : (
        <>
          <section className={styles.infoBanner}>
            <div>
              <span className={styles.bannerIcon} aria-hidden="true"><WalletCards size={22} /></span>
              <div>
                <h2>账户充值</h2>
                <p>充值金额、兑换比例和可用支付方式以充值窗口显示为准，支付结果由订单状态确认。</p>
              </div>
            </div>
            <span className={styles.bannerBadge}>{authenticated ? "账户已登录" : "登录后查看余额"}</span>
          </section>

          {authenticated ? (
            <>
              <section className={styles.balanceGrid} aria-label="账户概况">
                <article>
                  <span className={styles.metricIcon} data-tone="amber"><Coins size={22} /></span>
                  <div><small>可用积分</small><strong>{credits.toLocaleString("zh-CN")}</strong></div>
                </article>
                <article>
                  <span className={styles.metricIcon} data-tone="blue"><WalletCards size={22} /></span>
                  <div><small>现金余额</small><strong>¥{cashBalance.toFixed(2)}</strong></div>
                </article>
                <article>
                  <span className={styles.metricIcon} data-tone="violet"><BadgeCheck size={22} /></span>
                  <div><small>{displayName}</small><strong>{memberStatusLabel(state.auth.user?.memberStatus)}</strong></div>
                </article>
              </section>

              <section className={styles.sectionHeading}>
                <div><span>充值服务</span><h2>选择充值账户</h2></div>
                <button className={styles.textButton} type="button" onClick={() => void fetchCredits()}>
                  <RefreshCw size={15} aria-hidden="true" /> 刷新余额
                </button>
              </section>

              <section className={styles.productGrid}>
                <article className={styles.productCard} data-tone="gold">
                  <div className={styles.productArt}><Coins size={38} aria-hidden="true" /></div>
                  <div className={styles.productBody}>
                    <span className={styles.productTag}>创作积分</span>
                    <h3>积分账户充值</h3>
                    <p>用于文本、图片、音频和视频创作；每项能力按页面展示的计费规则结算。</p>
                    <strong>{credits.toLocaleString("zh-CN")} <small>当前积分</small></strong>
                    <button type="button" onClick={() => openRecharge("credits")}>进入积分充值 <ArrowRight size={16} /></button>
                  </div>
                </article>

                <article className={styles.productCard} data-tone="blue">
                  <div className={styles.productArt}><WalletCards size={38} aria-hidden="true" /></div>
                  <div className={styles.productBody}>
                    <span className={styles.productTag}>账户余额</span>
                    <h3>现金账户充值</h3>
                    <p>支付金额和通道由充值窗口读取，到账后余额会同步更新。</p>
                    <strong>¥{cashBalance.toFixed(2)} <small>当前余额</small></strong>
                    <button type="button" onClick={() => openRecharge("cash")}>进入余额充值 <ArrowRight size={16} /></button>
                  </div>
                </article>

                <article className={styles.productCard} data-tone="violet">
                  <div className={styles.productArt}><Gift size={38} aria-hidden="true" /></div>
                  <div className={styles.productBody}>
                    <span className={styles.productTag}>会员权益</span>
                    <h3>卡密与会员</h3>
                    <p>会员状态与账户信息会随登录账号同步显示。</p>
                    <strong>{memberStatusLabel(state.auth.user?.memberStatus)}</strong>
                    <span className={styles.cardStatus}><BadgeCheck size={16} /> 会员状态已同步</span>
                  </div>
                </article>
              </section>
            </>
          ) : (
            <>
              <LoginPrompt
                title="登录后查看积分余额"
                description="登录账号后可查看积分、现金余额、会员状态和充值记录，并进入统一充值窗口。匿名状态下不展示虚拟余额，也不会把支付配置写死在前端；兑换比例、赠送规则和支付通道以后台配置与订单状态为准。"
                redirect="/recharge"
              />
              <section className={styles.previewGrid} aria-label="充值服务介绍">
                <article><Coins size={24} /><h3>积分账户</h3><p>用于文本、图片、音频、视频和漫剧工作流创作；扣费以后端实际任务和账单记录为准。</p></article>
                <article><WalletCards size={24} /><h3>现金余额</h3><p>支付、到账、退款与订单状态统一由充值窗口确认，前端只展示安全的账户视图。</p></article>
                <article><BadgeCheck size={24} /><h3>会员权益</h3><p>会员身份、体验额度和可用功能随登录账号同步，不和演示素材或测试数据混用。</p></article>
              </section>
            </>
          )}
        </>
      )}

      <RechargeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        credits={credits}
        cashBalance={cashBalance}
        mode={dialogMode}
        onCreditsUpdated={(nextCredits) => {
          dispatch({
            type: "SET_CREDITS",
            payload: { total: nextCredits, used: 0, remaining: nextCredits, costPerMessage: state.credits.costPerMessage },
          });
          void fetchCredits();
        }}
        onCashUpdated={(nextCash) => {
          dispatch({ type: "SET_CASH_BALANCE", payload: nextCash });
          void fetchCredits();
        }}
      />
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function maskPhone(phone?: string) {
  if (!phone) return "未填写手机号";
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export function YoucaiReferralPage() {
  const { state, checked, authenticated } = useCheckedAuth();
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [records, setRecords] = useState<InviteRecord[]>([]);
  const [benefits, setBenefits] = useState<InviteBenefit[]>([]);
  const [stats, setStats] = useState({ totalInvited: 0, activatedCount: 0 });
  const [quota, setQuota] = useState<InvitationQuota>({ monthlyLimit: 6, issuedThisMonth: 0, remainingThisMonth: 0, resetsAt: "", canGenerate: false });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoadedInvitation, setHasLoadedInvitation] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");
  const hasLoadedInvitationRef = useRef(false);
  const loadedInvitationTokenRef = useRef<string | null>(null);
  const token = state.auth.token;
  const inviteOwnerEligible = state.auth.user?.role === "admin" || state.auth.user?.memberStatus === "active";

  const loadInvitationData = useCallback(async () => {
    if (!token) return;
    const tokenChanged = loadedInvitationTokenRef.current !== null && loadedInvitationTokenRef.current !== token;
    loadedInvitationTokenRef.current = token;
    if (tokenChanged) {
      hasLoadedInvitationRef.current = false;
      setHasLoadedInvitation(false);
      setCodes([]);
      setRecords([]);
      setBenefits([]);
      setStats({ totalInvited: 0, activatedCount: 0 });
    }
    const preservingSnapshot = hasLoadedInvitationRef.current;
    if (preservingSnapshot) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [codesResponse, recordsResponse, benefitsResponse] = await Promise.all([
        fetch("/api/invitation/my-codes", { headers, cache: "no-store" }),
        fetch("/api/invitation/records", { headers, cache: "no-store" }),
        fetch("/api/invitation/benefits", { cache: "no-store" }),
      ]);

      const codesPayload = await codesResponse.json().catch(() => ({})) as MyCodesPayload;
      const recordsPayload = await recordsResponse.json().catch(() => ({})) as RecordsPayload;
      const benefitsPayload = await benefitsResponse.json().catch(() => ({})) as BenefitsPayload;

      if (!codesResponse.ok) throw new Error(codesPayload.error || "邀请码加载失败");
      if (!recordsResponse.ok) throw new Error(recordsPayload.error || "邀请记录加载失败");

      setCodes(Array.isArray(codesPayload.codes) ? codesPayload.codes : []);
      setRecords(Array.isArray(recordsPayload.records) ? recordsPayload.records : []);
      setStats({
        totalInvited: Number(codesPayload.stats?.totalInvited ?? recordsPayload.stats?.totalInvited ?? 0),
        activatedCount: Number(codesPayload.stats?.activatedCount ?? recordsPayload.stats?.activatedCount ?? 0),
      });
      if (codesPayload.quota) setQuota(codesPayload.quota);

      if (benefitsResponse.ok && benefitsPayload.success !== false) {
        setBenefits(Array.isArray(benefitsPayload.benefits) ? benefitsPayload.benefits : []);
      } else {
        setBenefits([]);
      }
      hasLoadedInvitationRef.current = true;
      setHasLoadedInvitation(true);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "推荐计划加载失败";
      setError(preservingSnapshot ? `${message}；已保留上次成功加载的推荐数据` : message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    if (authenticated) void loadInvitationData();
  }, [authenticated, loadInvitationData]);

  useEffect(() => {
    if (authenticated) return;
    hasLoadedInvitationRef.current = false;
    loadedInvitationTokenRef.current = null;
    setHasLoadedInvitation(false);
    setCodes([]);
    setRecords([]);
    setBenefits([]);
    setStats({ totalInvited: 0, activatedCount: 0 });
    setError("");
  }, [authenticated]);

  const availableCodes = useMemo(
    () => codes.filter((item) => !item.is_used),
    [codes],
  );

  const generateCode = async () => {
    if (!token || generating || !inviteOwnerEligible || quota.remainingThisMonth <= 0) return;
    setGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/invitation/generate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({})) as GeneratePayload;
      const generatedCode = typeof payload.code === "string" ? payload.code : payload.code?.code;
      if (!response.ok || !generatedCode) {
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

  return (
    <div className={styles.page} data-page="youcai-referral">
      <header className={`${styles.titleBlock} ${styles.referralTitle}`}>
        <span className={styles.titleIcon} aria-hidden="true"><Gift size={28} /></span>
        <h1>推荐计划</h1>
        <p>分享邀请码，和好友一起开启创作</p>
      </header>

      {!checked ? (
        <LoadingState label="正在核验登录状态..." />
      ) : !authenticated ? (
        <>
          <section className={styles.referralHero}>
            <div className={styles.referralHeroIcon} aria-hidden="true"><Sparkles size={34} /></div>
            <div><span>邀请好友</span><h2>你的创作伙伴，值得一同加入</h2><p>登录后查看专属邀请码、邀请记录和福利内容。</p></div>
          </section>
          <LoginPrompt
            title="登录后查看推荐计划"
            description="登录账号后即可管理专属邀请码、查看好友激活状态、邀请记录和活动福利。推荐计划属于账户数据，不会在匿名状态下暴露手机号、邀请关系或伪造统计；所有记录以后台返回为准。"
            redirect="/referral"
          />
          <section className={styles.previewGrid} aria-label="推荐计划说明">
            <article><UserPlus size={24} /><h3>邀请码管理</h3><p>一枚邀请码只供一位好友注册；使用后才能生成下一枚。</p></article>
            <article><Users size={24} /><h3>邀请记录</h3><p>好友加入与激活进度从账户接口读取，刷新失败时会保留上次成功数据，不用空白误导。</p></article>
            <article><Gift size={24} /><h3>活动福利</h3><p>福利说明由活动配置提供，后续上线新规则时不需要改页面硬编码。</p></article>
          </section>
        </>
      ) : (
        <>
          <section className={styles.referralHero}>
            <div className={styles.referralHeroIcon} aria-hidden="true"><Sparkles size={34} /></div>
            <div><span>推荐计划</span><h2>邀请好友，共享创作灵感</h2><p>复制完整邀请说明发给一位好友；一人一码，每月最多 {quota.monthlyLimit} 枚。</p></div>
            {availableCodes[0] ? (
              <button className={styles.heroCode} type="button" onClick={() => void copyCode(availableCodes[0].code)}>
                <small>我的邀请码</small><strong>{availableCodes[0].code}</strong>
                <span>{copied === availableCodes[0].code ? <Check size={14} /> : <Copy size={14} />}{copied === availableCodes[0].code ? "已复制" : "点击复制"}</span>
              </button>
            ) : (
              <button className={styles.heroAction} type="button" disabled={generating || !inviteOwnerEligible || quota.remainingThisMonth <= 0} onClick={() => void generateCode()}>
                {generating ? <Loader2 className={styles.spin} size={16} /> : <UserPlus size={16} />}
                {generating ? "生成中..." : !inviteOwnerEligible ? "正式会员可生成" : quota.remainingThisMonth <= 0 ? "本月额度已用完" : "生成邀请码"}
              </button>
            )}
          </section>

          {error && <div className={styles.errorState} role="alert">{error}</div>}
          {refreshing && <div className={styles.infoBanner} role="status"><div><RefreshCw className={styles.spin} size={18} /><div><h2>正在刷新推荐数据</h2><p>当前继续显示上次成功加载的邀请信息。</p></div></div></div>}

          {loading && !hasLoadedInvitation ? (
            <LoadingState label="正在加载推荐计划..." />
          ) : (
            <>
              <section className={styles.statsGrid} aria-label="邀请统计">
                <article><span data-tone="blue"><Users size={21} /></span><div><strong>{stats.totalInvited}</strong><small>累计邀请</small></div></article>
                <article><span data-tone="green"><BadgeCheck size={21} /></span><div><strong>{stats.activatedCount}</strong><small>已激活</small></div></article>
                <article><span data-tone="violet"><Gift size={21} /></span><div><strong>{availableCodes.length}</strong><small>可用邀请码</small></div></article>
              </section>

              <section className={styles.referralGrid}>
                <article className={styles.panel}>
                  <div className={styles.panelHeading}>
                    <div><span className={styles.panelIcon}><Sparkles size={19} /></span><div><h2>我的邀请码</h2><p>一次一人；礼包确认后直接到账，无需领取</p></div></div>
                    {availableCodes.length === 0 && (
                      <button type="button" disabled={generating || !inviteOwnerEligible || quota.remainingThisMonth <= 0} onClick={() => void generateCode()}>
                        {generating ? <Loader2 className={styles.spin} size={15} /> : <UserPlus size={15} />}
                        {generating ? "生成中..." : !inviteOwnerEligible ? "正式会员可生成" : quota.remainingThisMonth <= 0 ? "本月额度已用完" : codes.length > 0 ? "生成下一枚" : "生成邀请码"}
                      </button>
                    )}
                  </div>
                  {codes.length === 0 ? (
                    <div className={styles.emptyState}><Gift size={25} /><strong>还没有邀请码</strong><span>点击上方按钮生成你的专属邀请码</span></div>
                  ) : (
                    <div className={styles.codeList}>
                      {codes.map((item) => (
                        <article key={item.id || item.code} data-used={item.is_used ? "true" : undefined}>
                          <div><code>{item.code}</code><span>{item.is_used ? "已使用" : "可供 1 人注册"}</span></div>
                          <small>{formatDate(item.created_at) || "账户邀请码"}</small>
                          {!item.is_used && (
                            <button type="button" onClick={() => void copyCode(item.code)}>
                              {copied === item.code ? <Check size={14} /> : <Copy size={14} />}
                              {copied === item.code ? "邀请说明已复制" : "复制邀请说明"}
                            </button>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </article>

                <article className={styles.panel}>
                  <div className={styles.panelHeading}>
                    <div><span className={styles.panelIcon}><Gift size={19} /></span><div><h2>邀请福利</h2><p>福利内容来自活动配置</p></div></div>
                  </div>
                  {benefits.length === 0 ? (
                    <div className={styles.emptyState}><Gift size={25} /><strong>暂无福利内容</strong><span>活动更新后会显示在这里</span></div>
                  ) : (
                    <div className={styles.benefitList}>
                      {benefits.map((benefit) => (
                        <article key={benefit.id}>
                          <span><Gift size={17} /></span>
                          <div><strong>{benefit.title || "邀请福利"}</strong><p>{benefit.content}</p><small>{formatDate(benefit.created_at)}</small></div>
                        </article>
                      ))}
                    </div>
                  )}
                </article>
              </section>

              <section className={styles.panel}>
                <div className={styles.panelHeading}>
                  <div><span className={styles.panelIcon}><History size={19} /></span><div><h2>邀请记录</h2><p>查看好友加入与激活状态</p></div></div>
                  <button type="button" disabled={refreshing} onClick={() => void loadInvitationData()}><RefreshCw className={refreshing ? styles.spin : undefined} size={15} />{refreshing ? "刷新中" : "刷新"}</button>
                </div>
                {records.length === 0 ? (
                  <div className={styles.emptyState}><Users size={25} /><strong>暂无邀请记录</strong><span>把邀请码分享给好友后，记录会显示在这里</span></div>
                ) : (
                  <div className={styles.recordTable}>
                    <div className={styles.recordHeader}><span>好友</span><span>加入时间</span><span>会员状态</span><span>激活结果</span></div>
                    {records.map((record, index) => (
                      <article key={`${String(record.id)}-${index}`}>
                        <div className={styles.personCell}>
                          <span>{record.invitee.display_name?.slice(0, 1) || "友"}</span>
                          <div><strong>{record.invitee.display_name || "未命名用户"}</strong><small>{maskPhone(record.invitee.phone)}</small></div>
                        </div>
                        <span>{formatDate(record.invited_at)}</span>
                        <span>{memberStatusLabel(record.invitee.member_status)}</span>
                        <strong className={record.invitee_activated ? styles.activeStatus : styles.pendingStatus}>
                          {record.invitee_activated ? "已激活" : "待激活"}
                        </strong>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
