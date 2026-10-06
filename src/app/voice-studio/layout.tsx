import './voice-studio.css';
import './voice-studio-global.css';
import VoiceStudioHeader from '@/components/vs/Header';
import VoiceStudioFooter from '@/components/vs/Footer';
// 顶部面包屑/页面级 header 已移除（用户反馈重复无意义）
// 顶部导航由 VoiceStudioHeader 统一管理（含 logo + tabs + 返回主页）

export default function VoiceStudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="voice-studio-root vs-studio-shell">
      <VoiceStudioHeader />
      <main className="vs-studio-main">{children}</main>
      <VoiceStudioFooter />
    </div>
  );
}
