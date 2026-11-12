import type { Metadata } from 'next'
import { getPageTitle } from './title'
import { NATIVE_PRODUCT_NAME } from '@/integration/host-branding-contract'

const PRODUCT_KEYWORDS = ['内容创作', '多平台发布', '内容管理']

/** 确保品牌关键词变体在 keywords 最前面，避免重复 */
function prependBrandKeyword(keywords: Metadata['keywords']): string {
  const raw = Array.isArray(keywords) ? keywords.join(', ') : (keywords || '')
  const filtered = raw
    .split(',')
    .map(keyword => keyword.trim())
    .filter(keyword => !/ai\s*to\s*earn/iu.test(keyword))

  return [...new Set([...PRODUCT_KEYWORDS, ...filtered])].join(', ')
}

/**
 * 生成页面 Metadata（符合 SEO 最佳实践）。
 * @param props 基础 Metadata 配置
 * @param lng 当前语言
 * @param path 页面路径（不含语言前缀），如 '/accounts'
 */
export async function getMetadata(props: Metadata, lng: string, path?: string): Promise<Metadata> {
  void path
  const replaceSourceBrand = (value: string) => value.replace(/ai\s*to\s*earn/giu, NATIVE_PRODUCT_NAME)
  const title = await getPageTitle(replaceSourceBrand(typeof props.title === 'string' ? props.title : ''), lng)
  const description = replaceSourceBrand(typeof props.description === 'string' ? props.description : '')
  // Private host workspace: do not inherit upstream origins or publish search/share URLs.
  return {
    title, description, keywords: prependBrandKeyword(props.keywords),
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
    openGraph: { title, description, siteName: NATIVE_PRODUCT_NAME, type: 'website' },
    twitter: { card: 'summary', title, description },
  }
}
