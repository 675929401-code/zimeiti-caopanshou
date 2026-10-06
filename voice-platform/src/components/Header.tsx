'use client';

import React, { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { href: '/workspace', label: '语音合成', icon: 'speech' },
  { href: '/imitate', label: '音色模仿', icon: 'imitate' },
  { href: '/clone', label: '声音复刻', icon: 'clone' },
  { href: '/design', label: '声音设计', icon: 'design' },
  { href: '/voices', label: '音色库', icon: 'library' },
];

/* 导航图标 — 5级尺寸，灰度层次 */
const NavIcon = ({ type, active }: { type: string; active: boolean }) => {
  const base = 'w-5 h-5 transition-all duration-200';
  const color = active ? 'text-vp-primary' : 'text-vp-muted-foreground group-hover:text-vp-muted-foreground';
  const cls = `${base} ${color}`;

  switch (type) {
    case 'speech': /* 语音合成 — 声波动画感 */
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 10v4" opacity="0.4" />
          <path d="M6 7v10" opacity="0.5" />
          <path d="M10 4v16" />
          <path d="M14 7v10" opacity="0.5" />
          <path d="M18 10v4" opacity="0.4" />
        </svg>
      );
    case 'clone': /* 声音复刻 — 麦克风+克隆波纹 */
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="1" width="6" height="12" rx="3" />
          <path d="M4 11a8 8 0 0016 0" />
          <path d="M12 19v4M8 23h8" />
        </svg>
      );
    case 'design': /* 声音设计 — 调音台/滑块 */
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="21" x2="4" y2="14" strokeWidth="2.5" />
          <line x1="4" y1="10" x2="4" y2="3" strokeWidth="2.5" />
          <line x1="12" y1="21" x2="12" y2="12" strokeWidth="2.5" />
          <line x1="12" y1="8" x2="12" y2="3" strokeWidth="2.5" />
          <line x1="20" y1="21" x2="20" y2="16" strokeWidth="2.5" />
          <line x1="20" y1="12" x2="20" y2="3" strokeWidth="2.5" />
          <circle cx="4" cy="12" r="2" />
          <circle cx="12" cy="10" r="2" />
          <circle cx="20" cy="14" r="2" />
        </svg>
      );
    case 'library': /* 音色库 — 网格/卡片库 */
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" opacity="0.4" />
        </svg>
      );
    case 'imitate': /* 音色模仿 — 魔法棒+音波 */
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 4.5V2m0 2.5a3 3 0 110 6m0-6a3 3 0 000 6m-5 3a7 7 0 0114 0" opacity="0.6"/>
          <path d="M8 14l-4 4m0 0l1 1m-1-1l-1 1" strokeWidth="2"/>
          <circle cx="5" cy="13" r="1.5" />
          <circle cx="17" cy="6" r="1.5" />
        </svg>
      );
    case 'admin': /* 后台管理 — 齿轮/设置 */
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
};

export default function Header() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0, visible: false });

  useEffect(() => {
    if (!navRef.current) return;
    const el = navRef.current.querySelector('[data-active="true"]') as HTMLElement;
    if (el) {
      const nav = navRef.current.getBoundingClientRect();
      const btn = el.getBoundingClientRect();
      setIndicator({ left: btn.left - nav.left, width: btn.width, visible: true });
    } else {
      setIndicator(p => ({ ...p, visible: false }));
    }
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 bg-vp-background/90 backdrop-blur-xl border-b border-vp-border">
      <div className="h-16 flex items-center gap-6 px-6 lg:px-10 max-w-screen-2xl mx-auto">
        
        {/* ====== Logo ====== */}
        <Link href="/" className="flex items-center gap-2.5 group shrink-0">
          <div className="relative w-9 h-9">
            <div className="absolute inset-0 bg-vp-primary rounded-xl blur-[6px] opacity-40 group-hover:opacity-70 transition-opacity" />
            <div className="relative w-9 h-9 bg-gradient-to-br from-vp-primary to-cyan-400 rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-lg font-bold text-vp-foreground tracking-tight">智音工坊</span>
            <span className="text-[10px] text-vp-muted-foreground tracking-[0.16em] uppercase">Voice Studio</span>
          </div>
        </Link>

        {/* ====== 返回主页 ====== */}
        <a
          href="/"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-vp-muted-foreground hover:text-vp-primary hover:bg-vp-primary/10 transition-all duration-200 text-sm font-medium shrink-0"
          title="返回主页"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 19l-7-7 7-7" />
          </svg>
          <span>主页</span>
        </a>

        {/* ====== 导航栏（偏左） ====== */}
        <div className="flex-1 flex">
          <div ref={navRef} className="relative flex items-center bg-vp-card rounded-2xl border border-vp-border p-1">
            {indicator.visible && (
              <div
                className="absolute top-1 bottom-1 bg-vp-primary/10 rounded-xl border border-vp-primary/20 shadow-[0_0_18px_var(--theme-glow)] transition-all duration-300 ease-out"
                style={{ left: indicator.left, width: indicator.width }}
              />
            )}
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  prefetch={false}
                  data-active={isActive || undefined}
                  className={`relative z-10 group flex items-center gap-2 px-5 py-2 rounded-xl text-[15px] font-semibold transition-all duration-200 ${
                    isActive
                      ? 'text-vp-foreground'
                      : 'text-vp-muted-foreground hover:text-vp-foreground'
                  }`}
                >
                  <NavIcon type={link.icon} active={isActive} />
                  <span className="hidden sm:inline">{link.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* ====== 状态灯 ====== */}
        <div className="shrink-0">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-400/10 bg-emerald-400/[0.03]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
            </span>
            <span className="text-[11px] text-vp-muted-foreground font-medium hidden lg:inline">已接入主站</span>
          </div>
        </div>

        {/* Mobile */}
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="md:hidden p-2.5 -mr-2 rounded-xl text-vp-muted-foreground hover:text-vp-foreground hover:bg-vp-card transition-colors shrink-0"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {mobileOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden border-t border-vp-border px-6 py-3 space-y-1">
          {NAV_LINKS.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-[15px] font-semibold transition-colors ${
                  isActive
                    ? 'bg-vp-primary/10 text-vp-foreground border border-vp-primary/20'
                    : 'text-vp-muted-foreground hover:text-vp-foreground'
                }`}
              >
                <NavIcon type={link.icon} active={isActive} />
                {link.label}
              </Link>
            );
          })}
        </div>
      )}
    </header>
  );
}
