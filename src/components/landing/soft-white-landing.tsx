"use client";

import dynamic from "next/dynamic";
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleGauge,
  Clapperboard,
  Database,
  Film,
  Images,
  Layers3,
  MessageSquareText,
  Mic2,
  PenLine,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Store,
  Target,
  Users,
  Video,
  WandSparkles,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import { UserThemeSwitcher } from "@/components/user-theme-switcher";
import { DEFAULT_PLATFORM_LOGO_URL, platformBrandLogoUrl, usePlatformBranding } from "@/hooks/use-platform-branding";
import { PointerNetwork } from "./pointer-network";
import "./soft-white-landing.css";
import "./operating-home-v2.css";
import "./pointer-network.css";
import "./landing-login-themes.css";

const LoginForm = dynamic(() => import("@/components/login-form").then(module => ({ default: module.LoginForm })), {
  ssr: false,
  loading: () => <div className="swh-login-loading" role="status">正在加载登录面板…</div>,
});

type SoftWhiteLandingProps = {
  showLogin: boolean;
  onLoginClick: () => void;
  onCloseLogin: () => void;
};

function readableTextOn(hex: string): "#071412" | "#FFFFFF" {
  const value = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return "#FFFFFF";
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return (red * 299 + green * 587 + blue * 114) / 1000 > 160 ? "#071412" : "#FFFFFF";
}

function darkenHex(hex: string): string {
  if (!/^#[0-9A-F]{6}$/iu.test(hex)) return "#104C43";
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.max(0, Math.round(((value >> shift) & 255) * 0.72));
  return `#${[channel(16), channel(8), channel(0)].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

const projectExampleSteps = [
  {
    number: "01",
    phase: "输入",
    title: "把“上新”变成选题",
    detail: "商品卖点、到店场景与对标样本先统一到项目里。",
    outcome: "得到 3 个可拍选题",
  },
  {
    number: "02",
    phase: "制作",
    title: "从选题推进到镜头",
    detail: "口播脚本、封面方向和分镜在同一条线上衔接。",
    outcome: "形成一份可制作的素材包",
  },
  {
    number: "03",
    phase: "交付",
    title: "让成片能继续使用",
    detail: "配音、视频任务和下载结果回到作品历史。",
    outcome: "下次从已有资产继续",
  },
] as const;

const valueRows = [
  { icon: Target, problem: "每天从零想选题", solution: "把账号定位、对标样本和用户问题收进同一套策划流程", result: "选题持续有来源" },
  { icon: PenLine, problem: "文案反复改，仍然不够抓人", solution: "用拆解后的内容结构组织钩子、叙事和表达", result: "更快得到可拍脚本" },
  { icon: Film, problem: "想做内容，却受限于出镜和制作", solution: "按内容目标选择真人表达、动画叙事或 AI 原生视频", result: "出片方式更自由" },
  { icon: Layers3, problem: "工具越多，项目越散", solution: "把文案、封面、分镜、配音和视频串进同一个项目", result: "少切换，不丢上下文" },
  { icon: MessageSquareText, problem: "有播放，却接不住后续咨询", solution: "在脚本阶段组织可信信息与清晰的下一步入口", result: "补齐内容承接" },
  { icon: Store, problem: "人手有限，内容还要持续更新", solution: "用可复用的步骤、素材和历史结果维持生产", result: "小团队也能有序推进" },
] as const;

const productionModes = [
  {
    number: "01",
    icon: Users,
    title: "真人表达",
    audience: "个人 IP、知识讲解与实体商家",
    delivery: "账号策略、口播脚本、镜头提示与产品演示",
    flow: ["确定表达", "完成脚本", "辅助拍摄"],
  },
  {
    number: "02",
    icon: Clapperboard,
    title: "动画叙事",
    audience: "宠物科普、知识故事、育儿与剧情账号",
    delivery: "角色设定、故事节拍、分镜提示与配音方案",
    flow: ["设定角色", "拆解分镜", "生成镜头"],
  },
  {
    number: "03",
    icon: Sparkles,
    title: "AI 原生视频",
    audience: "商品展示、创意广告与批量内容",
    delivery: "素材绑定、提示词、生图视频、配音与任务记录",
    flow: ["绑定素材", "选择模型", "生成视频"],
  },
] as const;

const platformModules = [
  ["对标洞察", ScanSearch],
  ["智能体协作", Bot],
  ["选题脚本", PenLine],
  ["封面生图", Images],
  ["分镜视频", Video],
  ["声音制作", Mic2],
  ["作品历史", Database],
] as const;

const availableCapabilities = [
  ["策略与脚本", "定位、对标、选题、口播与脚本", BrainCircuit],
  ["视觉资产", "封面、生图、分镜与视频任务", Images],
  ["声音制作", "配音、音色、音频处理与下载", Mic2],
  ["项目记忆", "素材、任务、状态与作品结果", CircleGauge],
] as const;

const plannedCapabilities = [
  "多账号协同运营",
  "批量素材编排",
  "发布日历与复盘看板",
  "行业专属生产线",
] as const;

const navItems = [
  ["为什么选择", "swh-value"],
  ["生产路线", "swh-production"],
  ["能力全景", "swh-capabilities"],
  ["适合谁", "swh-business"],
] as const;

export function SoftWhiteLanding({ showLogin, onLoginClick, onCloseLogin }: SoftWhiteLandingProps) {
  const platformBranding = usePlatformBranding();
  const platformName = platformBranding.brand.name || "自媒体操盘手";
  const platformSlogan = platformBranding.brand.slogan || "AI 内容经营系统";
  const platformLogoUrl = platformBrandLogoUrl(platformBranding, "square");
  const primary = /^#[0-9A-F]{6}$/iu.test(platformBranding.brand.colors.primary)
    ? platformBranding.brand.colors.primary
    : "#17675A";
  const accent = /^#[0-9A-F]{6}$/iu.test(platformBranding.brand.colors.accent)
    ? platformBranding.brand.colors.accent
    : "#2F80FF";
  const brandStyle = {
    "--swh-jade": primary,
    "--swh-jade-dark": darkenHex(primary),
    "--swh-proof-bg": darkenHex(primary),
    "--swh-on-jade": readableTextOn(primary),
    "--swh-title-start": primary,
    "--swh-title-end": accent,
  } as CSSProperties;
  const homeRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!showLogin) return;
    const home = homeRef.current;
    const dialog = dialogRef.current;
    if (!home || !dialog) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflowY = home.style.overflowY;
    home.style.overflowY = "hidden";
    const backgroundRegions = Array.from(home.querySelectorAll<HTMLElement>(".swh-header, main, .swh-footer"));
    backgroundRegions.forEach((region) => {
      region.setAttribute("inert", "");
      region.setAttribute("aria-hidden", "true");
    });

    const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.tabIndex >= 0 && getComputedStyle(element).visibility !== "hidden");

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseLogin();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const focusFrame = window.requestAnimationFrame(() => (getFocusable()[0] || dialog).focus());
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      backgroundRegions.forEach((region) => {
        region.removeAttribute("inert");
        region.removeAttribute("aria-hidden");
      });
      home.style.overflowY = previousOverflowY;
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [onCloseLogin, showLogin]);

  useEffect(() => {
    const home = homeRef.current;
    if (!home) return;

    const targets = Array.from(home.querySelectorAll<HTMLElement>("[data-swh-reveal]"));
    home.classList.add("swh-motion-ready");

    if (!("IntersectionObserver" in window)) {
      targets.forEach((target) => target.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { root: home, rootMargin: "0px 0px -9%", threshold: 0.1 });

    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const home = homeRef.current;
    if (!home) return;

    const finePointer = window.matchMedia("(pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;
    let nextX = window.innerWidth * 0.5;
    let nextY = window.innerHeight * 0.34;
    let pointerActive = false;

    const commitPointerPosition = () => {
      animationFrame = 0;
      const width = Math.max(window.innerWidth, 1);
      const height = Math.max(window.innerHeight, 1);
      const horizontal = Math.min(1, Math.max(0, nextX / width));
      const vertical = Math.min(1, Math.max(0, nextY / height));

      home.style.setProperty("--swh-pointer-x", `${nextX.toFixed(1)}px`);
      home.style.setProperty("--swh-pointer-y", `${nextY.toFixed(1)}px`);
      home.style.setProperty("--swh-tilt-x", `${((0.5 - vertical) * 5).toFixed(2)}deg`);
      home.style.setProperty("--swh-tilt-y", `${((horizontal - 0.5) * 7).toFixed(2)}deg`);
      home.dataset.pointerMotion = "active";
    };

    const schedulePointerPosition = (clientX: number, clientY: number) => {
      nextX = clientX;
      nextY = clientY;
      if (!animationFrame) animationFrame = window.requestAnimationFrame(commitPointerPosition);
    };

    const handlePointerMove = (event: PointerEvent) => schedulePointerPosition(event.clientX, event.clientY);
    const resetPointerPosition = () => schedulePointerPosition(window.innerWidth * 0.5, window.innerHeight * 0.34);

    const disablePointerMotion = () => {
      if (pointerActive) {
        home.removeEventListener("pointermove", handlePointerMove);
        home.removeEventListener("pointerleave", resetPointerPosition);
      }
      pointerActive = false;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      delete home.dataset.pointerMotion;
      home.style.removeProperty("--swh-tilt-x");
      home.style.removeProperty("--swh-tilt-y");
    };

    const syncPointerMotion = () => {
      disablePointerMotion();
      if (!finePointer.matches || reducedMotion.matches) return;
      pointerActive = true;
      home.addEventListener("pointermove", handlePointerMove, { passive: true });
      home.addEventListener("pointerleave", resetPointerPosition);
      resetPointerPosition();
    };

    finePointer.addEventListener("change", syncPointerMotion);
    reducedMotion.addEventListener("change", syncPointerMotion);
    syncPointerMotion();

    return () => {
      finePointer.removeEventListener("change", syncPointerMotion);
      reducedMotion.removeEventListener("change", syncPointerMotion);
      disablePointerMotion();
    };
  }, []);

  const scrollTo = (id: string) => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  };

  return (
    <div ref={homeRef} className="soft-white-home" style={brandStyle} data-testid="soft-white-premium-home" data-theme-synced-home="true" data-landing-version="v2">
      <div className="swh-atmosphere" data-testid="swh-theme-atmosphere" aria-hidden="true">
        <span className="swh-aura swh-aura-one" />
        <span className="swh-aura swh-aura-two" />
        <span className="swh-aura swh-aura-three" />
        <span className="swh-motion-grid" />
        <span className="swh-data-stream" />
        <span className="swh-particle-field" />
        <span className="swh-light-sweep" />
        <span className="swh-pointer-glow" />
        <span className="swh-grain" />
        <PointerNetwork />
      </div>
      <header className="swh-header">
        <a className="swh-brand" href="#swh-top" aria-label={`${platformName}首页`}>
          <span className="swh-brand-mark"><img src={platformLogoUrl} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = DEFAULT_PLATFORM_LOGO_URL; }} /></span>
          <span><strong>{platformName}</strong><small>{platformSlogan}</small></span>
        </a>
        <nav className="swh-nav" aria-label="首页导航">
          {navItems.map(([label, id]) => <button key={id} onClick={() => scrollTo(id)}>{label}</button>)}
        </nav>
        <div className="swh-header-actions">
          <UserThemeSwitcher />
          <button className="swh-login-button" onClick={onLoginClick}>登录平台 <ArrowRight size={15} /></button>
        </div>
      </header>

      <main>
        <section className="swh-hero" id="swh-top" data-swh-reveal>
          <div className="swh-hero-copy">
            <p className="swh-kicker"><span /> AI CONTENT OPERATING SYSTEM</p>
            <h1>
              <span className="swh-title-line">把一个内容想法</span>
              <span className="swh-title-line">推进到完整成片</span>
              <span className="swh-title-line swh-title-accent">沉淀为可用资产</span>
            </h1>
            <p className="swh-lead">围绕账号目标，把对标研究、内容策划与视听制作组织在同一个项目里。人负责判断，智能体接力执行，让每次创作都留下可复用的结果。</p>
            <div className="swh-hero-status" aria-label="平台工作方式">
              <span><i /> 从策略到成片，同一项目推进</span>
              <span><i /> 素材、任务与结果有迹可循</span>
            </div>
            <div className="swh-hero-actions">
              <button className="swh-primary-action" onClick={onLoginClick}>启动内容项目 <ArrowRight size={17} /></button>
              <button className="swh-secondary-action" onClick={() => scrollTo("swh-capabilities")}>查看生产系统 <ChevronDown size={17} /></button>
            </div>
            <dl className="swh-facts" aria-label="平台结构">
              <div><dt>1</dt><dd>套项目上下文</dd></div>
              <div><dt>3</dt><dd>种生产路线</dd></div>
              <div><dt>7</dt><dd>个生产环节</dd></div>
            </dl>
          </div>

          <div className="swh-loop" aria-label="内容项目推进示例">
            <div className="swh-loop-heading">
              <div className="swh-loop-kicker"><span /><strong>PROJECT EXAMPLE</strong><small>3 STEPS</small></div>
              <strong>一条上新内容，怎么走到交付</strong>
              <p>以门店新品短视频为例：从卖点、脚本、镜头走到可下载的成片。</p>
              <div className="swh-factory" data-testid="swh-content-factory" aria-hidden="true">
                <span className="swh-factory-platform" />
                <span className="swh-factory-ring swh-factory-ring-one" />
                <span className="swh-factory-ring swh-factory-ring-two" />
                <span className="swh-factory-core"><Layers3 size={17} /></span>
                <span className="swh-factory-node swh-factory-node-in" />
                <span className="swh-factory-node swh-factory-node-out" />
                <span className="swh-factory-beam" />
              </div>
            </div>
            <ol className="swh-project-example">
              {projectExampleSteps.map(({ number, phase, title, detail, outcome }) => <li key={number}>
                <header className="swh-example-step-head"><span>{number}</span><small>{phase}</small></header>
                <strong>{title}</strong>
                <p>{detail}</p>
                <em className="swh-example-outcome"><Check size={13} />{outcome}</em>
              </li>)}
            </ol>
            <div className="swh-console-stats" aria-label="链路结构">
              <span><small>WORKFLOW</small><strong>输入一路推进</strong></span>
              <span><small>CONTEXT</small><strong>素材不丢上下文</strong></span>
              <span><small>ARCHIVE</small><strong>交付回到作品历史</strong></span>
            </div>
          </div>
        </section>

        <section className="swh-module-rail" id="swh-modules" aria-label="已接入的内容生产模块" data-swh-reveal>
          <div className="swh-module-rail-label"><Workflow size={16} /><span>一套系统，串起七类生产能力</span></div>
          <div className="swh-module-rail-items">
            {platformModules.map(([label, Icon]) => <span key={label}><Icon size={15} />{label}</span>)}
          </div>
        </section>

        <section className="swh-section swh-value" id="swh-value" data-swh-reveal>
          <div className="swh-section-heading">
            <p>WHY ONE SYSTEM · 为什么需要一套系统</p>
            <h2>少一点重复开工，多一点持续产出</h2>
            <span>方向、脚本、素材与任务相互承接，创作不再反复归零，团队也能清楚掌握每一步进度。</span>
          </div>
          <div className="swh-value-grid">
            {valueRows.map(({ icon: Icon, problem, solution, result }, index) => <article key={problem}>
              <span className="swh-card-index">0{index + 1}</span>
              <Icon size={20} />
              <div><h3>{problem}</h3><p>{solution}</p></div>
              <strong><WandSparkles size={13} />{result}</strong>
            </article>)}
          </div>
        </section>

        <section className="swh-section swh-production" id="swh-production" data-swh-reveal>
          <div className="swh-section-heading swh-heading-row">
            <div><p>THREE PRODUCTION ROUTES · 三条生产路线</p><h2>选对呈现方式，再把每一步做到位</h2></div>
            <span>真人适合建立信任，动画擅长承载叙事，AI 原生视频便于快速试验和批量表达。路线各有侧重，素材与任务仍在同一项目里推进。</span>
          </div>
          <div className="swh-production-grid">
            {productionModes.map(({ number, icon: Icon, title, audience, delivery, flow }) => <article key={title}>
              <div className="swh-card-beam" aria-hidden="true" />
              <div className="swh-production-number">{number}</div>
              <span className="swh-production-icon"><Icon size={24} /></span>
              <h3>{title}</h3>
              <dl><div><dt>适用对象</dt><dd>{audience}</dd></div><div><dt>交付内容</dt><dd>{delivery}</dd></div></dl>
              <div className="swh-production-flow" aria-label={`${title}流程`}>
                {flow.map((step, index) => <span key={step}>{step}{index < flow.length - 1 && <i />}</span>)}
              </div>
            </article>)}
          </div>
        </section>

        <section className="swh-section swh-capabilities" id="swh-capabilities" data-swh-reveal>
          <div className="swh-section-heading">
            <p>CAPABILITY SYSTEM · 内容生产能力</p>
            <h2>真正有用的 AI，不只回答，还要接住下一步</h2>
            <span>研究、脚本、视觉、声音与作品记录共享项目上下文；关键环节保留输入、任务状态和可继续使用的结果。</span>
          </div>
          <div className="swh-capability-layout">
            <div className="swh-available" aria-label="当前可用能力">
              <div className="swh-capability-title"><span>当前可用</span><strong>从内容输入，到成片与作品历史</strong></div>
              <div className="swh-available-grid">
                {availableCapabilities.map(([title, desc, Icon]) => <article key={title}>
                  <Icon size={21} /><div><h3>{title}</h3><p>{desc}</p></div><Check size={16} />
                </article>)}
              </div>
            </div>
            <aside className="swh-planned" aria-label="规划开放能力">
              <div className="swh-capability-title"><span>继续扩展</span><strong>围绕真实生产场景逐步接入</strong></div>
              <ul>{plannedCapabilities.map(item => <li key={item}><span />{item}</li>)}</ul>
               <p>新能力只在达到可用、可追踪、可交付后开放。</p>
            </aside>
          </div>
        </section>

        <section className="swh-section swh-business" id="swh-business" data-swh-reveal>
          <div className="swh-section-heading swh-heading-row">
            <div><p>WHO IT SERVES · 为谁而建</p><h2>从持续表达，到用内容经营生意</h2></div>
            <span>创作者关心稳定产出与作品质量，商家关心获客、信任与成交。两类目标，共用一套可持续的内容生产底座。</span>
          </div>
          <div className="swh-business-grid">
            <article>
              <span className="swh-route-index">ROUTE 01</span><Bot size={25} />
              <h3>创作者与内容团队</h3>
              <p>先建立清晰的账号表达，再串联选题、脚本、封面、分镜、声音和视频，把持续更新变成可执行的流程。</p>
              <ul><li>选题持续有来源</li><li>多种内容形态</li><li>项目与作品留痕</li></ul>
            </article>
            <article>
              <span className="swh-route-index">ROUTE 02</span><Store size={25} />
              <h3>实体商家与内容电商</h3>
              <p>围绕产品价值与客户问题持续生产内容，让素材、案例、任务和结果在同一项目里反复复用。</p>
              <ul><li>产品与客户洞察</li><li>获客内容持续生产</li><li>素材与案例复用</li></ul>
            </article>
          </div>
          <div className="swh-proof-bar">
            <ShieldCheck size={22} />
            <div><strong>让每一次创作，都给下一次留下可用资产</strong><span>选题、脚本、素材、任务状态与作品结果留在项目里，下一次从已有积累继续。</span></div>
            <button onClick={onLoginClick}>启动项目 <ArrowRight size={15} /></button>
          </div>
        </section>
      </main>

      <footer className="swh-footer" id="swh-footer" data-swh-reveal>
        <div><strong>{platformName}</strong><span>{platformBranding.brand.description || "把策略、创作、生产与归档，变成一套持续运转的内容系统。"}</span></div>
        <p>微信：Yuange1991xx</p>
      </footer>

      {showLogin && <>
        <button className="swh-login-backdrop" aria-label="关闭登录面板" onClick={onCloseLogin} />
        <aside ref={dialogRef} className="swh-login-drawer" role="dialog" aria-modal="true" aria-labelledby="swh-login-title" tabIndex={-1}>
          <button className="swh-login-close" aria-label="关闭登录面板" onClick={onCloseLogin}><X size={19} /></button>
          <div className="swh-login-intro"><span>WELCOME BACK</span><h2 id="swh-login-title">回到{platformBranding.brand.shortName || platformName}</h2><p>{platformBranding.brand.welcomeMessage || "继续你的项目、任务与作品记录。"}</p></div>
          <LoginForm />
        </aside>
      </>}
    </div>
  );
}
