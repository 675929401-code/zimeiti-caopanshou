import type { FlatNamespace, KeyPrefix, Namespace } from 'i18next'
import type { FallbackNs } from 'react-i18next'
import { createInstance } from 'i18next'
import resourcesToBackend from 'i18next-resources-to-backend'
import { initReactI18next } from 'react-i18next/initReactI18next'
import { getOptions } from './settings'

async function initI18next(lng: string, ns: string | string[]) {
  // on server side we create a new instance for each render, because during compilation everything seems to be executed in parallel
  const i18nInstance = createInstance()
  await i18nInstance
    .use(initReactI18next)
    .use(
      resourcesToBackend(
        (language: string, namespace: string) => import(`./locales/${language}/${namespace}.json`),
      ),
    )
    .init(getOptions(lng, ns))
  return i18nInstance
}

type $Tuple<T> = readonly [T?, ...T[]]
type $FirstNamespace<Ns extends Namespace> = Ns extends readonly any[] ? Ns[0] : Ns

export async function useTranslation<
  Ns extends FlatNamespace | $Tuple<FlatNamespace>,
  KPrefix extends KeyPrefix<
    FallbackNs<Ns extends FlatNamespace ? FlatNamespace : $FirstNamespace<FlatNamespace>>
  > = undefined,
>(lng: string, ns?: Ns, options: { keyPrefix?: KPrefix } = {}) {
  const namespace = ns || 'translation'
  const i18nextInstance = await initI18next(
    lng,
    Array.isArray(namespace) ? (namespace as string[]) : (namespace as string),
  )
  return {
    t: Array.isArray(namespace)
      ? i18nextInstance.getFixedT(lng, namespace[0], options.keyPrefix)
      : i18nextInstance.getFixedT(lng, namespace as FlatNamespace, options.keyPrefix),
    i18n: i18nextInstance,
  }
}
