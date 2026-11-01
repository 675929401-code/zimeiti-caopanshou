"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useApp } from "@/contexts/app-context";
import { LpStarfield } from "@/components/landing/lp-starfield";
import { LpDemo, type LpDemoKind } from "@/components/landing/lp-demos";
import { LpReveal } from "@/components/landing/lp-reveal";
import { SoftWhiteLanding } from "@/components/landing/soft-white-landing";
import "@/components/landing/landing-fx.css";
import {
  Sparkles, Bot, Music, Palette, Film,
  ArrowRight, Zap, Globe, Rocket,
  ChevronDown, Star, Users, MessageCircle,
  Mail, MapPin, Clock, DollarSign, Volume2, Layers
} from "lucide-react";

const LoginForm = dynamic(() => import("@/components/login-form").then(mod => ({ default: mod.LoginForm })), {
  ssr: false,
  loading: () => (
    <div className="w-full py-16 text-center text-sm text-white/55">
      加载登录面板...
    </div>
  ),
});

/** 功能卡片演示动画类型（与功能网格顺序一一对应） */
const FEATURE_DEMOS: LpDemoKind[] = ["chat", "voice", "video"];

interface LandingPageProps {
  onEnterApp?: () => void;
}

/**
 * 平台介绍首页 — 入口页面（无论是否登录均优先展示）
 * 双模式配色（深色/浅色跟随主题）+ 滚轮自动翻页 + 紫青极光配色
 * 动画体系（2026-07-28）：星尘背景跟随鼠标 + 功能演示窗 + 滚动入场
 * 交互体系（2026-07-28）：右侧滑出登录抽屉 + 隐藏滚动条 + 3大核心能力 + 多模态视频专题
 * 入口守卫（2026-09-09）：通过 onEnterApp 回调通知父级「进入应用」
 */
export function LandingPage({ onEnterApp }: LandingPageProps) {
  const { checkAuth, dispatch } = useApp();
  const [showLogin, setShowLogin] = useState(false);
  /* SSR 安全初始化：服务端默认 false（浅色），客户端 hydration 后立即同步真实主题 */
  const [isDark, setIsDark] = useState(false);
  const [themeId, setThemeId] = useState("");
  const [activeSection, setActiveSection] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<HTMLElement[]>([]);

  // 监听登录成功事件 — LoginForm 登录成功后 dispatch "auth-state-changed"
  // 此时调用 checkAuth() 更新全局 auth 状态，再通过 onEnterApp 进入应用
  useEffect(() => {
    const handleAuthChange = () => {
      // 重置 view 为应用广场，避免上次停留在 chat 状态
      dispatch({ type: "SET_VIEW", payload: "marketplace" });
      checkAuth();
      // 通知父级进入应用（设置 sessionStorage entered_app 标记）
      onEnterApp?.();
    };
    window.addEventListener("auth-state-changed", handleAuthChange);
    return () => window.removeEventListener("auth-state-changed", handleAuthChange);
  }, [checkAuth, dispatch, onEnterApp]);

  // 检测深色/浅色模式 — useLayoutEffect 在浏览器绘制前同步执行，彻底消除闪烁
  useLayoutEffect(() => {
    const updateMode = () => {
      const dm = document.documentElement.getAttribute("data-mode");
      setThemeId(document.documentElement.getAttribute("data-theme") || "lattice");
      setIsDark(dm !== "light");
    };
    updateMode();
    const observer = new MutationObserver(updateMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme"] });
    return () => observer.disconnect();
  }, []);

  // 滚动监听 — 追踪当前 section + header 背景
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      setScrolled(container.scrollTop > 50);
      const sections = sectionRefs.current.filter(Boolean);
      const center = container.scrollTop + container.clientHeight * 0.4;
      for (let i = 0; i < sections.length; i++) {
        const top = sections[i].offsetTop;
        const bottom = top + sections[i].offsetHeight;
        if (center >= top && center < bottom) {
          setActiveSection(i);
          break;
        }
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  const handleLoginClick = useCallback(() => {
    // 已登录时直接进入应用；未登录时保留首页右侧局部滑出抽屉。
    const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
    if (token) {
      dispatch({ type: "SET_VIEW", payload: "marketplace" });
      checkAuth();
      onEnterApp?.();
      return;
    }
    setShowLogin(true);
  }, [checkAuth, dispatch, onEnterApp]);

  /* ESC 关闭登录面板 */
  useEffect(() => {
    if (!showLogin) return;
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) setShowLogin(false); };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [showLogin]);

  const scrollToSection = useCallback((idx: number) => {
    const target = sectionRefs.current[idx];
    if (target && containerRef.current) {
      containerRef.current.scrollTo({ top: target.offsetTop, behavior: "smooth" });
    }
  }, []);

  // 四套标准主题共享同一套业务首页结构，仅由主题 token 改变视觉。
  // 首次服务端渲染时 themeId 为空，也直接输出统一首页，避免水合后换页闪烁。
  if (!themeId || themeId === "soft-white" || themeId === "lattice" || themeId === "crystal-aurora" || themeId === "stellar-blue") {
    return <SoftWhiteLanding showLogin={showLogin} onLoginClick={handleLoginClick} onCloseLogin={() => setShowLogin(false)} />;
  }

  // CSS 变量 — 深色：紫青极光 / 浅色：淡蓝渐变（更高级）
  const lpVars = isDark ? {
    "--lp-bg": "#070A14",
    "--lp-bg-grad": "linear-gradient(180deg, #0e0b1f 0%, #070A14 50%, #03050c 100%)",
    "--lp-surface": "rgba(124, 92, 255, 0.04)",
    "--lp-surface-hover": "rgba(124, 92, 255, 0.08)",
    "--lp-border": "rgba(124, 92, 255, 0.12)",
    "--lp-border-hover": "rgba(124, 92, 255, 0.25)",
    "--lp-text": "#f0eaff",
    "--lp-text-muted": "rgba(200, 190, 230, 0.55)",
    "--lp-text-dim": "rgba(200, 190, 230, 0.4)",
    "--lp-accent": "#7C5CFF",
    "--lp-accent-2": "#69E7FF",
    "--lp-accent-glow": "rgba(124, 92, 255, 0.15)",
    "--lp-grid": "rgba(124, 92, 255, 0.03)",
    "--lp-particle": "rgba(124, 92, 255, 0.4)",
    "--lp-header-bg": "rgba(7, 10, 20, 0.8)",
    "--lp-glow-1": "rgba(124, 92, 255, 0.25)",
    "--lp-glow-2": "rgba(105, 231, 255, 0.15)",
  } : {
    "--lp-bg": "#f0f7ff",
    "--lp-bg-grad": "linear-gradient(180deg, #e8f4ff 0%, #f0f7ff 30%, #f5f0ff 70%, #eaf0ff 100%)",
    "--lp-surface": "rgba(100, 150, 255, 0.04)",
    "--lp-surface-hover": "rgba(100, 150, 255, 0.08)",
    "--lp-border": "rgba(100, 150, 255, 0.12)",
    "--lp-border-hover": "rgba(100, 150, 255, 0.22)",
    "--lp-text": "#0a1a3a",
    "--lp-text-muted": "rgba(10, 26, 58, 0.55)",
    "--lp-text-dim": "rgba(10, 26, 58, 0.35)",
    "--lp-accent": "#2563eb",
    "--lp-accent-2": "#7C5CFF",
    "--lp-accent-glow": "rgba(37, 99, 235, 0.1)",
    "--lp-grid": "rgba(37, 99, 235, 0.025)",
    "--lp-particle": "rgba(37, 99, 235, 0.25)",
    "--lp-header-bg": "rgba(240, 247, 255, 0.85)",
    "--lp-glow-1": "rgba(37, 99, 235, 0.12)",
    "--lp-glow-2": "rgba(124, 92, 255, 0.08)",
  } as React.CSSProperties;

  const navItems = ["\u9996\u9875", "\u529f\u80fd", "\u4f18\u52bf", "\u8054\u7cfb"];

  return (
    <div
      ref={containerRef}
      className="landing-page h-screen overflow-y-auto snap-y snap-mandatory scroll-smooth"
      style={{ background: "var(--lp-bg-grad)", color: "var(--lp-text)", ...lpVars } as React.CSSProperties}
    >
      {/* === 动态背景 === */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        {/* 紫青极光光晕 */}
        <div
          className="absolute top-[-10%] left-[5%] w-[800px] h-[800px] rounded-full blur-[150px]"
          style={{ background: `radial-gradient(circle, var(--lp-glow-1) 0%, transparent 70%)` }}
        />
        <div
          className="absolute top-[30%] right-[5%] w-[600px] h-[600px] rounded-full blur-[120px]"
          style={{ background: `radial-gradient(circle, var(--lp-glow-2) 0%, transparent 70%)` }}
        />
        {/* 网格背景 */}
        <div
          className="absolute inset-0"
          style={{
            opacity: 0.5,
            backgroundImage: `
              linear-gradient(var(--lp-grid) 1px, transparent 1px),
              linear-gradient(90deg, var(--lp-grid) 1px, transparent 1px)
            `,
            backgroundSize: "50px 50px",
          }}
        />
        {/* 鼠标跟随星尘画布（视差滑动 + 邻近吸引 + 光标光晕 + 偶发流星） */}
        <LpStarfield dark={isDark} />
      </div>

      {/* === 顶部导航 === */}
      <nav
        className="fixed top-0 left-0 right-0 z-40 transition-all duration-300"
        style={{
          background: scrolled ? "var(--lp-header-bg)" : "transparent",
          backdropFilter: scrolled ? "blur(16px)" : "none",
          borderBottom: scrolled ? "1px solid var(--lp-border)" : "none",
        }}
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shadow-lg"
              style={{ background: "linear-gradient(135deg, var(--lp-accent), var(--lp-accent-2))", boxShadow: "0 4px 20px var(--lp-accent-glow)" }}
            >
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="text-lg font-bold tracking-tight">安哥智能体工作平台</span>
              <span className="hidden sm:inline ml-2 text-xs" style={{ color: "var(--lp-text-dim)" }}>AI Agent Hub</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {navItems.map((item, i) => (
              <button
                key={item}
                onClick={() => scrollToSection(i)}
                className="hidden md:block text-sm transition-colors"
                style={{ color: activeSection === i ? "var(--lp-accent)" : "var(--lp-text-muted)" }}
              >
                {item}
              </button>
            ))}
            <button
              onClick={handleLoginClick}
              className="px-5 py-2 rounded-full text-white text-sm font-medium transition-all hover:scale-105"
              style={{
                background: "linear-gradient(90deg, var(--lp-accent), var(--lp-accent-2))",
                boxShadow: "0 4px 20px var(--lp-accent-glow)",
              }}
            >
              登录 / 注册
            </button>
          </div>
        </div>
      </nav>

      {/* === Section 0: Hero === */}
      <section
        ref={(el) => { if (el) sectionRefs.current[0] = el; }}
        className="relative z-10 min-h-screen snap-start flex items-center justify-center px-6 pt-20"
      >
        <div className="max-w-5xl text-center">
          <div
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full backdrop-blur-sm mb-8 lp-fade-in"
            style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
          >
            <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--lp-accent)" }} />
            <span className="text-sm" style={{ color: "var(--lp-text-muted)" }}>AI 智能体一站式工作平台</span>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-tight lp-fade-in">
            <span style={{ background: "linear-gradient(90deg, var(--lp-text), var(--lp-text-muted))", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              还在手动写文案、剪视频？
            </span>
            <br />
            <span className="lp-shine" style={{ background: "linear-gradient(90deg, var(--lp-accent), var(--lp-accent-2), var(--lp-accent))", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              让 AI 替你全部搞定
            </span>
          </h1>

          <p className="text-lg md:text-xl max-w-3xl mx-auto mb-10 leading-relaxed lp-fade-in" style={{ color: "var(--lp-text-muted)" }}>
            一条链接，自动提取文案 · 一句话，AI 写出爆款 · 一个按钮，视频配音数字人全流程生成
            <br />
            <span className="text-base" style={{ color: "var(--lp-text-dim)" }}>集成海外顶级大模型，费用降低 80%，效率提升 10 倍 · 多账号矩阵批量生产，真正解放双手</span>
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 lp-fade-in">
            <button
              onClick={handleLoginClick}
              className="group px-8 py-3.5 rounded-full text-white font-medium transition-all hover:scale-105 flex items-center gap-2"
              style={{ background: "linear-gradient(90deg, var(--lp-accent), var(--lp-accent-2))", boxShadow: "0 4px 30px var(--lp-accent-glow)" }}
            >
              立即体验
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <button
              onClick={() => scrollToSection(1)}
              className="px-8 py-3.5 rounded-full font-medium transition-all flex items-center gap-2"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)", color: "var(--lp-text)" }}
            >
              <Star className="w-4 h-4" />
              探索功能
            </button>
          </div>

          {/* 向下滚动提示 */}
          <button
            onClick={() => scrollToSection(1)}
            className="mt-16 flex flex-col items-center gap-2 lp-fade-in mx-auto cursor-pointer group"
            style={{ color: "var(--lp-text-dim)" }}
          >
            <span className="text-xs tracking-widest group-hover:opacity-80 transition-opacity">向下探索</span>
            <ChevronDown className="w-4 h-4 animate-bounce" />
          </button>
        </div>
      </section>

      {/* === Section 1: 核心能力 === */}
      <section
        ref={(el) => { if (el) sectionRefs.current[1] = el; }}
        className="relative z-10 min-h-screen snap-start flex items-center justify-center py-20 px-6"
      >
        <div className="max-w-6xl mx-auto w-full">
          <LpReveal className="text-center mb-8">
            <span
              className="inline-block px-3 py-1 rounded-full text-xs tracking-wider mb-4"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)", color: "var(--lp-accent)" }}
            >
              CORE CAPABILITIES
            </span>
            <h2 className="text-4xl md:text-5xl font-bold mb-3">三大核心能力</h2>
            <p className="max-w-2xl mx-auto" style={{ color: "var(--lp-text-muted)" }}>从文案到成片，AI 全链路赋能创作</p>
          </LpReveal>

          {/* 三大核心能力 — 等高对齐 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-8 items-stretch">
            {[
              { icon: Bot, title: "AI 智能体对话", desc: "接入 Claude、GPT、GLM 等顶级大模型，帮你写文案、做引流，支持深度思考、联网搜索、多模态识别", tags: ["写文案", "做引流", "多模型"] },
              { icon: Music, title: "真人级配音", desc: "300+ 精选音色，真人级语音合成服务，支持声音克隆、情感合成、多语种 TTS，音色更自然", tags: ["真人配音", "声音克隆"] },
              { icon: Palette, title: "3D 动画全自动", desc: "3D 动画全自动工作流，从脚本到成片解放双手，批量生成高质量动画内容", tags: ["3D动画", "全自动"] },
            ].map((feature, i) => (
              <LpReveal key={i} delay={(i % 4) * 70} className="h-full">
              <div
                className="group relative h-full flex flex-col p-5 rounded-2xl backdrop-blur-sm transition-all duration-300 hover:-translate-y-1"
                style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--lp-border-hover)"; e.currentTarget.style.background = "var(--lp-surface-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--lp-border)"; e.currentTarget.style.background = "var(--lp-surface)"; }}
              >
                {/* 功能演示动画窗 — 每个功能一段循环演示 */}
                <div className="mb-4">
                  <LpDemo kind={FEATURE_DEMOS[i]} />
                </div>
                <div
                  className="relative w-11 h-11 rounded-xl flex items-center justify-center mb-3 group-hover:scale-110 transition-transform"
                  style={{ background: "linear-gradient(135deg, var(--lp-accent), var(--lp-accent-2))" }}
                >
                  <feature.icon className="w-5 h-5 text-white" />
                </div>
                <h3 className="relative text-base font-semibold mb-1.5">{feature.title}</h3>
                <p className="relative text-xs leading-relaxed mb-3 flex-1" style={{ color: "var(--lp-text-muted)" }}>{feature.desc}</p>
                <div className="relative flex flex-wrap gap-1">
                  {feature.tags.map((tag, j) => (
                    <span
                      key={j}
                      className="px-1.5 py-0.5 rounded text-[10px]"
                      style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)", color: "var(--lp-text-dim)" }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              </LpReveal>
            ))}
          </div>

          {/* === 多模态视频自动生成 — 专题区块 === */}
          <LpReveal delay={200} className="mt-10">
            <div
              className="relative p-8 md:p-10 rounded-3xl backdrop-blur-sm overflow-hidden"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
            >
              {/* 背景光晕 */}
              <div
                className="absolute top-0 right-0 w-[400px] h-[300px] rounded-full blur-[100px] pointer-events-none"
                style={{ background: "var(--lp-accent-glow)" }}
              />
              <div className="relative grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                {/* 左侧：视频演示动画 */}
                <div className="hidden md:block">
                  <LpDemo kind="video" />
                </div>
                {/* 右侧：文案描述 */}
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <Film className="w-5 h-5" style={{ color: "var(--lp-accent)" }} />
                    <span
                      className="inline-block px-3 py-1 rounded-full text-xs tracking-wider"
                      style={{ background: "var(--lp-surface-hover)", border: "1px solid var(--lp-border)", color: "var(--lp-accent)" }}
                    >
                      FLAGSHIP FEATURE
                    </span>
                  </div>
                  <h3 className="text-2xl md:text-3xl font-bold mb-4">多模态视频自动生成</h3>
                  <p className="text-sm md:text-base leading-relaxed mb-5" style={{ color: "var(--lp-text-muted)" }}>
                    集成海外大模型能力，从文案提取、智能分段到配音、镜头合成、封面生成，一条龙全自动完成。
                    真正解放双手，告别繁琐的重复操作，让一条视频的制作时间从数小时缩短到几分钟。
                  </p>
                  <div className="space-y-3 mb-5">
                    {[
                      { icon: Zap, title: "解放双手，真正高效", desc: "全流程自动化，无需人工干预，从脚本到成片一键生成" },
                      { icon: Users, title: "多账号矩阵友好", desc: "批量生成差异化内容，支持多账号分发，轻松打造内容矩阵" },
                      { icon: Globe, title: "海外大模型降本增效", desc: "集成海外顶级模型，费用更低，同样预算产出更多内容" },
                    ].map((item, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <div
                          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
                          style={{ background: "var(--lp-surface-hover)" }}
                        >
                          <item.icon className="w-4 h-4" style={{ color: "var(--lp-accent)" }} />
                        </div>
                        <div>
                          <div className="text-sm font-semibold mb-0.5">{item.title}</div>
                          <div className="text-xs leading-relaxed" style={{ color: "var(--lp-text-muted)" }}>{item.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={handleLoginClick}
                    className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full text-white text-sm font-medium transition-all hover:scale-105"
                    style={{ background: "linear-gradient(90deg, var(--lp-accent), var(--lp-accent-2))", boxShadow: "0 4px 20px var(--lp-accent-glow)" }}
                  >
                    立即体验
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </LpReveal>
        </div>
      </section>

      {/* === Section 2: 平台优势 === */}
      <section
        ref={(el) => { if (el) sectionRefs.current[2] = el; }}
        className="relative z-10 min-h-screen snap-start flex items-center justify-center py-20 px-6"
      >
        <div className="max-w-6xl mx-auto w-full">
          <LpReveal className="text-center mb-8">
            <span
              className="inline-block px-3 py-1 rounded-full text-xs tracking-wider mb-4"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)", color: "var(--lp-accent)" }}
            >
              WHY US
            </span>
            <h2 className="text-4xl md:text-5xl font-bold mb-3">为什么选择我们</h2>
            <p className="max-w-2xl mx-auto" style={{ color: "var(--lp-text-muted)" }}>专业、稳定、高效，为创作者保驾护航</p>
          </LpReveal>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mt-8">
            {[
              { icon: Globe, title: "多模型接入", desc: "集成海外大模型（Claude、GPT、GLM、DeepSeek 等），按需切换智能体，能力全覆盖" },
              { icon: Zap, title: "降本增效", desc: "视频集成海外大模型能力，费用更便宜，效率翻倍，同样预算做出更多内容" },
              { icon: Music, title: "真人级配音", desc: "300+ 精选音色真人级语音服务，声音克隆、情感合成，音色更自然更动听" },
              { icon: Rocket, title: "3D 动画全自动", desc: "3D 动画工作流从脚本到成片全自动完成，解放双手，批量生成高质量内容" },
              { icon: Users, title: "持续进化", desc: "每周更新新功能、新模型、新音色，紧跟 AI 前沿，让创作始终保持领先" },
            ].map((adv, i) => (
              <LpReveal key={i} delay={(i % 4) * 60} className="h-full">
              <div
                className="group h-full p-6 rounded-2xl transition-all duration-300 hover:-translate-y-1"
                style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--lp-border-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--lp-border)"; }}
              >
                <div
                  className="lp-adv-ic w-10 h-10 rounded-lg flex items-center justify-center mb-4"
                  style={{ background: "var(--lp-surface-hover)" }}
                >
                  <adv.icon className="w-5 h-5" style={{ color: "var(--lp-accent)" }} />
                </div>
                <h3 className="text-lg font-semibold mb-2">{adv.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: "var(--lp-text-muted)" }}>{adv.desc}</p>
              </div>
              </LpReveal>
            ))}
          </div>
        </div>
      </section>

      {/* === Section 3: 痛点 vs 解决方案 === */}
      <section
        ref={(el) => { if (el) sectionRefs.current[3] = el; }}
        className="relative z-10 min-h-screen snap-start flex items-center justify-center py-20 px-6"
      >
        <div className="max-w-6xl mx-auto w-full">
          <LpReveal className="text-center mb-10">
            <span
              className="inline-block px-3 py-1 rounded-full text-xs tracking-wider mb-4"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)", color: "var(--lp-accent)" }}
            >
              PAIN POINTS
            </span>
            <h2 className="text-4xl md:text-5xl font-bold mb-3">你的痛点，我们都解决了</h2>
            <p className="max-w-2xl mx-auto" style={{ color: "var(--lp-text-muted)" }}>从手动熬夜到一键搞定，每一步都为你省时省钱</p>
          </LpReveal>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {[
              {
                pain: "写文案太慢，每天憋到深夜",
                painIcon: Clock,
                solution: "AI 智能体 30 秒生成爆款文案",
                solutionIcon: Sparkles,
                desc: "输入关键词，AI 自动分析爆款框架，生成多版本文案，支持二次润色和风格切换",
              },
              {
                pain: "视频制作流程长，找人拍剪配音太贵",
                painIcon: DollarSign,
                solution: "一条龙全自动，成本降低 80%",
                solutionIcon: Rocket,
                desc: "文案提取 → 智能分段 → AI 配音 → 视频制作 → 封面生成，全流程一键完成",
              },
              {
                pain: "配音找真人，一条就要几百块",
                painIcon: Music,
                solution: "300+ 真人级音色，几分钱一条",
                solutionIcon: Volume2,
                desc: "支持声音克隆和情感合成，音色自然逼真，批量配音成本不到真人 1/100",
              },
              {
                pain: "多账号运营，内容不够用",
                painIcon: Users,
                solution: "矩阵批量生产，一天产出一个月内容",
                solutionIcon: Layers,
                desc: "批量生成差异化内容，支持多账号分发，一条链接提取整个博主主页文案",
              },
              {
                pain: "海外模型太贵，用不起",
                painIcon: Globe,
                solution: "集成顶级大模型，费用更低",
                solutionIcon: Zap,
                desc: "接入 Claude、GPT、GLM、DeepSeek 等海外大模型，按量付费，同样预算产出更多",
              },
            ].map((item, i) => (
              <LpReveal key={i} delay={(i % 3) * 60} className="h-full">
                <div
                  className="group h-full p-6 rounded-2xl transition-all duration-300 hover:-translate-y-1"
                  style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--lp-border-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--lp-border)"; }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "rgba(239,68,68,0.12)" }}>
                      <item.painIcon className="w-4 h-4 text-red-400" />
                    </div>
                    <span className="text-sm font-medium line-through" style={{ color: "var(--lp-text-dim)" }}>{item.pain}</span>
                  </div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "var(--lp-surface-hover)" }}>
                      <item.solutionIcon className="w-4 h-4" style={{ color: "var(--lp-accent)" }} />
                    </div>
                    <span className="text-base font-bold">{item.solution}</span>
                  </div>
                  <p className="text-sm leading-relaxed pl-12" style={{ color: "var(--lp-text-muted)" }}>{item.desc}</p>
                </div>
              </LpReveal>
            ))}
          </div>
        </div>
      </section>

      {/* === Section 4: 联系我们 + CTA + Footer === */}
      <section
        ref={(el) => { if (el) sectionRefs.current[4] = el; }}
        className="relative z-10 min-h-screen snap-start flex flex-col justify-center py-20 px-6"
      >
        <div className="max-w-4xl mx-auto w-full">
          <LpReveal className="text-center mb-8">
            <span
              className="inline-block px-3 py-1 rounded-full text-xs tracking-wider mb-4"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)", color: "var(--lp-accent)" }}
            >
              CONTACT
            </span>
            <h2 className="text-4xl md:text-5xl font-bold mb-3">联系我们</h2>
            <p className="max-w-xl mx-auto" style={{ color: "var(--lp-text-muted)" }}>有任何问题或建议，欢迎随时联系我们</p>
          </LpReveal>

          <LpReveal className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-12">
            <div
              className="p-6 rounded-2xl text-center transition-all hover:-translate-y-1"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4" style={{ background: "var(--lp-surface-hover)" }}>
                <MessageCircle className="w-6 h-6" style={{ color: "var(--lp-accent)" }} />
              </div>
              <h3 className="text-base font-semibold mb-2">微信联系</h3>
              <p className="text-sm" style={{ color: "var(--lp-text-muted)" }}>Yuange1991xx</p>
              <p className="text-xs mt-2" style={{ color: "var(--lp-text-dim)" }}>添加微信，获取专属支持</p>
            </div>
            <div
              className="p-6 rounded-2xl text-center transition-all hover:-translate-y-1"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4" style={{ background: "var(--lp-surface-hover)" }}>
                <Mail className="w-6 h-6" style={{ color: "var(--lp-accent)" }} />
              </div>
              <h3 className="text-base font-semibold mb-2">在线客服</h3>
              <p className="text-sm" style={{ color: "var(--lp-text-muted)" }}>登录后使用在线客服</p>
              <p className="text-xs mt-2" style={{ color: "var(--lp-text-dim)" }}>工作日即时响应</p>
            </div>
            <div
              className="p-6 rounded-2xl text-center transition-all hover:-translate-y-1"
              style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4" style={{ background: "var(--lp-surface-hover)" }}>
                <MapPin className="w-6 h-6" style={{ color: "var(--lp-accent)" }} />
              </div>
              <h3 className="text-base font-semibold mb-2">平台地址</h3>
              <p className="text-sm" style={{ color: "var(--lp-text-muted)" }}>安哥智能体工作平台</p>
              <p className="text-xs mt-2" style={{ color: "var(--lp-text-dim)" }}>持续更新中</p>
            </div>
          </LpReveal>

          {/* CTA */}
          <LpReveal
            className="relative p-10 md:p-14 rounded-3xl backdrop-blur-sm overflow-hidden text-center"
            style={{ background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}
          >
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[400px] rounded-full blur-[100px] pointer-events-none"
              style={{ background: "var(--lp-accent-glow)" }}
            />
            <h2 className="relative text-3xl md:text-4xl font-bold mb-4">准备好开始创作了吗？</h2>
            <p className="relative mb-8 max-w-lg mx-auto" style={{ color: "var(--lp-text-muted)" }}>立即登录，解锁全部 AI 创作能力，让效率翻倍</p>
            <button
              onClick={handleLoginClick}
              className="relative px-10 py-4 rounded-full text-white font-medium transition-all hover:scale-105 inline-flex items-center gap-2"
              style={{ background: "linear-gradient(90deg, var(--lp-accent), var(--lp-accent-2))", boxShadow: "0 4px 30px var(--lp-accent-glow)" }}
            >
              免费开始使用
              <ArrowRight className="w-5 h-5" />
            </button>
          </LpReveal>
        </div>

        {/* Footer */}
        <footer className="relative z-10 py-6 mt-12" style={{ borderTop: "1px solid var(--lp-border)" }}>
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 px-6">
            <div className="text-sm font-medium" style={{ color: "var(--lp-text-muted)" }}>
              © 2026 安哥智能体工作平台 · 让 AI 成为你的超级创作助手
            </div>
            <div className="flex items-center gap-2 text-sm px-4 py-2 rounded-full" style={{ color: "var(--lp-accent)", background: "var(--lp-surface)", border: "1px solid var(--lp-border)" }}>
              <MessageCircle className="w-4 h-4" />
              <span className="font-medium">微信：Yuange1991xx</span>
              <span style={{ color: "var(--lp-text-dim)" }}>·</span>
              <span style={{ color: "var(--lp-text-muted)" }}>联系客服获取帮助</span>
            </div>
          </div>
        </footer>
      </section>

      {/* === 右侧滑出登录抽屉 === */}
      {showLogin && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* 背景遮罩 */}
          <div
            className="absolute inset-0 lp-drawer-overlay"
            onClick={() => setShowLogin(false)}
          />
          {/* 登录面板 */}
          <div data-login-drawer="dark" className="lp-login-drawer relative lp-drawer-panel h-full w-full max-w-[460px] overflow-y-auto"
            style={{
              background: "linear-gradient(180deg, #1a1a2e 0%, #0f0f1a 100%)",
              borderLeft: "1px solid rgba(124, 92, 255, 0.25)",
              boxShadow: "-12px 0 50px rgba(0,0,0,0.6)",
            }}
          >
            {/* 关闭按钮 */}
            <button
              onClick={() => setShowLogin(false)}
              className="absolute top-4 right-4 z-10 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110"
              style={{
                background: isDark ? "rgba(255,255,255,0.08)" : "rgba(100,130,240,0.1)",
                border: isDark ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(100,130,240,0.2)",
                color: isDark ? "rgba(255,255,255,0.7)" : "rgba(80,90,140,0.8)",
              }}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
            <div className="min-h-full flex items-center justify-center p-6 pt-16">
              <LoginForm />
            </div>
          </div>
        </div>
      )}

      {/* 动画关键帧 + 隐藏滚动条 */}
      <style jsx>{`
        .lp-fade-in {
          animation: lp-fade-in-up 0.8s ease-out forwards;
          opacity: 0;
        }
        @keyframes lp-fade-in-up {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .lp-fade-in:nth-child(1) { animation-delay: 0s; }
        .lp-fade-in:nth-child(2) { animation-delay: 0.15s; }
        .lp-fade-in:nth-child(3) { animation-delay: 0.3s; }
        .lp-fade-in:nth-child(4) { animation-delay: 0.45s; }
        .lp-fade-in:nth-child(5) { animation-delay: 0.6s; }
        /* 隐藏主滚动条 — 鼠标滚轮仍可滑动 */
        .landing-page::-webkit-scrollbar { display: none; }
        .landing-page { -ms-overflow-style: none; scrollbar-width: none; }
        /* 登录抽屉动画 */
        .lp-drawer-overlay {
          background: rgba(0, 0, 0, 0.5);
          animation: lp-overlay-in 0.3s ease-out forwards;
        }
        @keyframes lp-overlay-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .lp-drawer-panel {
          animation: lp-drawer-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes lp-drawer-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
