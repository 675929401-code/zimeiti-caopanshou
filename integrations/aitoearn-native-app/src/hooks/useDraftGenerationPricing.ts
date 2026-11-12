import { assertHostSession, getHostSession, getHostSessionRevision, subscribeHostSession } from '@/integration/host-session'
/**
 * useDraftGenerationPricing - AI 草稿生成定价数据 Hook
 * 复用 ai/draft-generation/pricing 接口，提供模块级缓存与防重复请求
 */

import type { DraftGenerationPricingVo } from '@/api/ai/ai.types'
import { useEffect, useState } from 'react'
import { apiGetDraftGenerationPricing } from '@/api/ai/ai.api'

interface DraftGenerationPricingCache {
  data: DraftGenerationPricingVo | null
  promise: Promise<DraftGenerationPricingVo | null> | null
}

let cachedOwner = ''
let cachedRevision = -1
let pricingCache: DraftGenerationPricingCache = { data: null, promise: null }
subscribeHostSession(() => {
  const owner = getHostSession()?.user.id || ''; const revision = getHostSessionRevision()
  if (owner !== cachedOwner || revision !== cachedRevision) { cachedOwner = owner; cachedRevision = revision; pricingCache = { data: null, promise: null } }
})

function normalizePricingData(data: DraftGenerationPricingVo): DraftGenerationPricingVo {
  return {
    ...data,
    imageModels: (data.imageModels ?? []).map(model => ({
      ...model,
      pricing: model.pricing ?? [],
      tags: model.tags ?? [],
    })),
    videoModels: (data.videoModels ?? []).map(model => ({
      ...model,
      modes: model.modes ?? [],
      resolutions: model.resolutions ?? [],
      durations: model.durations ?? [],
      aspectRatios: model.aspectRatios ?? [],
      tags: model.tags ?? [],
      defaults: model.defaults ?? {},
      pricing: model.pricing ?? [],
    })),
  }
}

function getPricingCache() {
  const owner = getHostSession()?.user.id || ''; const revision = getHostSessionRevision()
  if (owner !== cachedOwner || revision !== cachedRevision) { cachedOwner = owner; cachedRevision = revision; pricingCache = { data: null, promise: null } }
  return pricingCache
}

async function fetchPricing(): Promise<DraftGenerationPricingVo | null> {
  const owner = assertHostSession().user.id; const revision = getHostSessionRevision()
  const cache = getPricingCache()
  if (cache.data) {
    return cache.data
  }
  if (cache.promise) {
    return cache.promise
  }

  cache.promise = apiGetDraftGenerationPricing()
    .then((res) => {
      assertHostSession(owner, revision)
      if (res?.data) {
        cache.data = normalizePricingData(res.data)
        return cache.data
      }
      return null
    })
    .catch(() => {
      return null
    })
    .finally(() => {
      cache.promise = null
    })

  return cache.promise
}

export function useDraftGenerationPricing() {
  const [pricingData, setPricingData] = useState<DraftGenerationPricingVo | null>(() => getPricingCache().data)
  const [isLoading, setIsLoading] = useState(() => !getPricingCache().data)
  const [error, setError] = useState(false)

  useEffect(() => {
    const cache = getPricingCache()
    if (cache.data) {
      setPricingData(cache.data)
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)

    const owner = assertHostSession().user.id; const revision = getHostSessionRevision()
    fetchPricing().then((data) => {
      if (getHostSession()?.user.id !== owner || getHostSessionRevision() !== revision) return
      if (cancelled) {
        return
      }

      if (data) {
        setPricingData(data)
      }
      else {
        setError(true)
      }

      setIsLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return { pricingData, isLoading, error }
}
