import { AppScopedLink as Link } from '@/components/app-scoped-link';

const links = [
  ['/voice-studio/workspace', '语音合成'],
  ['/voice-studio/imitate', '音色模仿'],
  ['/voice-studio/voices', '音色管理'],
] as const;

export default function Footer() {
  return (
    <footer className="vs-studio-footer">
      <div className="vs-studio-footer-inner">
        <div className="vs-studio-footer-brand">
          <span className="vs-studio-footer-mark" aria-hidden="true" />
          <div><strong>智音工坊</strong><span>内容创作语音工作台</span></div>
        </div>
        <nav aria-label="智音工坊快捷入口">
          {links.map(([href, label]) => <Link key={href} href={href} prefetch={false}>{label}</Link>)}
        </nav>
        <span className="vs-studio-footer-note">语音任务、资产与历史由服务端统一保存</span>
      </div>
    </footer>
  );
}
