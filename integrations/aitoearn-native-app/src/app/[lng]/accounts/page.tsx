import type { PageParams } from '@/app/globals'
import AccountPageCore from '@/app/[lng]/accounts/accountCore'
import { useTranslation as getServerTranslation } from '@/app/i18n'
import { getMetadata } from '@/utils/metadata'

export async function generateMetadata({ params }: PageParams) {
  const { lng } = await params
  const { t } = await getServerTranslation(lng, 'account')

  return await getMetadata(
    {
      title: t('seo.title'),
      description: t('seo.description'),
      keywords: t('seo.keywords'),
    },
    lng,
    '/accounts',
  )
}

interface AccountsPageProps {
  searchParams: Promise<{
    platform?: string
    spaceId?: string
  }>
}

export default async function Page({ searchParams }: AccountsPageProps) {
  const query = await searchParams
  return <AccountPageCore searchParams={query} />
}
