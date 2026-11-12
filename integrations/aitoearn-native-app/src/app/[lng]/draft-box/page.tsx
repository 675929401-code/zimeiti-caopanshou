/**
 * 草稿箱页面
 * 独立页面展示 AI 批量生成 + 草稿列表 + 相关弹窗
 */

import NativeDraftBoxBoundary from '@/integration/NativeDraftBoxBoundary'
import { useTranslation as getServerTranslation } from '@/app/i18n'
import { fallbackLng, languages } from '@/app/i18n/languageConfig'
import { getMetadata } from '@/utils/metadata'

interface PageParams {
  params: Promise<{ lng: string }>
}

export async function generateMetadata({ params }: PageParams) {
  let { lng } = await params
  if (!languages.includes(lng))
    lng = fallbackLng
  const { t } = await getServerTranslation(lng, 'common')

  return getMetadata(
    {
      title: t('header.draftBoxSeoTitle'),
      description: t('header.draftBoxSeoDescription'),
      keywords: t('header.draftBoxSeoKeywords'),
    },
    lng,
    '/draft-box',
  )
}


export default function DraftBoxPage() {
  return <NativeDraftBoxBoundary />
}
