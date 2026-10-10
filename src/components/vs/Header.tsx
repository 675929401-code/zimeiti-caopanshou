'use client';

import { usePathname } from 'next/navigation';
import { AppScopedLink as Link } from '@/components/app-scoped-link';
import { UserThemeSwitcher } from '@/components/user-theme-switcher';
import { useApp } from '@/contexts/app-context';
import { useAppScopedRouter } from '@/hooks/use-app-scoped-router';

const NAV_LINKS = [
  { href: '/voice-studio/workspace', label: '语音合成', icon: 'speech' },
  { href: '/voice-studio/imitate', label: '音色模仿', icon: 'imitate' },
  { href: '/voice-studio/voices', label: '音色管理', icon: 'library' },
] as const;

function NavIcon({ type }: { type: (typeof NAV_LINKS)[number]['icon'] }) {
  if (type === 'speech') {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></svg>;
  }
  if (type === 'imitate') {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 15l-5 5M5 17l2 2M15.5 3.5v3M14 5h3M18.5 9.5v2M17.5 10.5h2" /><path d="M7 17l8-8 2 2-8 8z" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
}

export default function Header() {
  const pathname = usePathname();
  const router = useAppScopedRouter();
  const { dispatch } = useApp();

  return (
    <header className="vs-studio-header sticky top-0 z-40">
      <div className="vs-studio-header-inner">
        <Link href="/voice-studio/workspace" className="vs-studio-logo" aria-label="进入智音工坊语音合成">
          <span className="vs-studio-logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0014 0M12 18v3M8.5 21h7" />
            </svg>
          </span>
          <span className="vs-studio-brand-copy">
            <strong>智音工坊</strong>
            <small>VOICE STUDIO</small>
          </span>
        </Link>

        <button
          type="button"
          className="vs-studio-home"
          onClick={() => {
            dispatch({ type: 'SET_ACTIVE_VIEW', payload: 'marketplace' });
            router.push('/');
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 11.5L12 3l9 8.5" /><path d="M5.5 10v10h13V10M9.5 20v-6h5v6" />
          </svg>
          返回主页
        </button>

        <nav className="vs-studio-nav" aria-label="智音工坊功能导航">
          {NAV_LINKS.map((link) => {
            const active = pathname === router.scopeHref(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className="vs-studio-nav-link"
                data-active={active || undefined}
                aria-current={active ? 'page' : undefined}
              >
                <NavIcon type={link.icon} />
                <span>{link.label}</span>
              </Link>
            );
          })}
        </nav>
        <UserThemeSwitcher />
      </div>
    </header>
  );
}
