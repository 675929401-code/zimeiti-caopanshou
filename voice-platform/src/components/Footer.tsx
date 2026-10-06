import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="bg-vp-card text-vp-muted-foreground mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 bg-vp-primary rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </div>
              <span className="text-lg font-bold text-vp-foreground">智音工坊</span>
            </div>
            <p className="text-sm leading-relaxed">
              专业级AI语音合成、声音复刻和声音设计平台。为内容创作者提供高质量的语音生成服务。
            </p>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="text-vp-foreground font-medium mb-3">快速链接</h4>
            <div className="space-y-2 text-sm">
              <Link href="/workspace" className="block hover:text-vp-foreground transition-colors">语音合成</Link>
              <Link href="/clone" className="block hover:text-vp-foreground transition-colors">声音复刻</Link>
              <Link href="/design" className="block hover:text-vp-foreground transition-colors">声音设计</Link>
              <Link href="/voices" className="block hover:text-vp-foreground transition-colors">音色库</Link>
            </div>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-vp-foreground font-medium mb-3">关于</h4>
            <div className="space-y-2 text-sm">
              <p>智音工坊 V3.0</p>
              <a href="https://gitee.com/zhujunguo/voice-platform-20250719" target="_blank" rel="noopener noreferrer" className="block hover:text-vp-foreground transition-colors">
                项目地址
              </a>
            </div>
          </div>
        </div>

        <div className="border-t border-vp-border mt-8 pt-8 text-center text-sm">
          <p>&copy; {new Date().getFullYear()} 智音工坊. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
