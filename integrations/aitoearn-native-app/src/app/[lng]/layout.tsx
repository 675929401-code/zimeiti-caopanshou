import { dir } from 'i18next'
import { NATIVE_PRODUCT_DESCRIPTION, NATIVE_PRODUCT_NAME } from '@/integration/host-branding-contract'
import LayoutSidebar from '@/app/layout/LayoutSidebar'
import { MainContent } from '@/app/layout/MainContent'
import MobileNav from '@/app/layout/MobileNav'
import { ChannelManager } from '@/components/ChannelManager'
import { Providers } from '../layout/Providers'
import '../globals.css'

export const dynamic = 'force-dynamic'

export function generateMetadata() {
  return {
    title: NATIVE_PRODUCT_NAME,
    description: NATIVE_PRODUCT_DESCRIPTION,
    keywords: 'AI, 内容创作, 多平台发布, 内容管理',
    robots: { index: false, follow: false },
  }
}

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode
  params: Promise<{ lng: string }>
}>) {
  const { lng } = await params

  return (
    <html lang={lng} dir={dir(lng)} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers lng={lng}>
          {/* 全局频道管理弹框 */}
          <ChannelManager />
          {/* 移动端顶部导航 - fixed 定位，独立于 flex 布局 */}
          <MobileNav />
          <div className="flex h-screen w-full">
            {/* 桌面端侧边栏 */}
            <LayoutSidebar />
            {/* 主内容区域 - 根据页面类型动态控制 pt-14 */}
            <MainContent>{children}</MainContent>
          </div>
        </Providers>
      </body>
    </html>
  )
}
