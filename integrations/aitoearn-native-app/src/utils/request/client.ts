import { assertHostSession, getHostSessionRevision } from '@/integration/host-session'
import { observeNativeRevisions } from '@/integration/native-revisions'
import type { RequestData, RequestParams, RequestQuery } from './types'
import { createElement } from 'react'
import { directTrans } from '@/app/i18n/client'
import { useUserStore } from '@/store/user'
import { notification } from '@/utils/ui/notification'
import FetchService from './FetchService'

interface ResponseType<T> {
  code: string | number
  data: T
  message: string
  url: string
}

interface ApiErrorIssue {
  message?: string
  path?: unknown
}

type RequestParamsWithSilent = RequestParams & {
  silent?: boolean // 是否静默处理错误，不显示提示
}

export type RequestOptions = Pick<RequestParamsWithSilent, 'cache'>

const fetchService = new FetchService({
  baseURL: '/api/native-operations/',
  requestInterceptor(requestParams) {
    const headers = new Headers(requestParams.headers)
    headers.delete('Authorization')
    headers.set('Accept-Language', useUserStore.getState().lang)
    return { ...requestParams, headers }
  },
  responseInterceptor(response) {
    return response
  },
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getIssuePath(path: unknown) {
  if (!Array.isArray(path))
    return ''

  return path
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .join('.')
}

function getIssueText(issue: ApiErrorIssue) {
  const message = typeof issue.message === 'string' ? issue.message.trim() : ''
  const path = getIssuePath(issue.path)

  if (path && message)
    return `${path}: ${message}`
  return message || path
}

function getApiErrorDetails(errorData: unknown) {
  if (!isRecord(errorData) || !Array.isArray(errorData.issues))
    return []

  const platform = typeof errorData.platform === 'string' ? errorData.platform : ''

  return errorData.issues
    .map((issue) => {
      if (!isRecord(issue))
        return ''

      const issueText = getIssueText({
        message: typeof issue.message === 'string' ? issue.message : undefined,
        path: issue.path,
      })
      if (!issueText)
        return ''

      return platform ? `${platform} / ${issueText}` : issueText
    })
    .filter((detail): detail is string => detail.length > 0)
}

function createApiErrorContent(message: string, details: string[] = []) {
  return createElement(
    'div',
    { className: 'flex flex-col gap-1' },
    createElement('span', null, message),
    details.length > 0
      ? createElement(
          'ul',
          { className: 'mt-1 space-y-0.5 font-normal text-muted-foreground' },
          details.slice(0, 4).map(detail => createElement('li', { key: detail }, detail)),
        )
      : null,
  )
}

function getApiErrorMessage(data: ResponseType<unknown>, fallback: string) {
  const message = data.message || fallback
  if (data.code !== 16183 || !isRecord(data.data) || typeof data.data.field !== 'string') {
    return message
  }

  return message
    .split(data.data.field)
    .join('')
    .replace(/：\s+/g, '：')
    .replace(/:\s{2,}/g, ': ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export async function request<T>(params: RequestParamsWithSilent) {
  try {
    const session = assertHostSession(); const sessionRevision = getHostSessionRevision()
    const res = await fetchService.request(params)
    const data: ResponseType<T> = await res.json()
    assertHostSession(session.user.id, sessionRevision)
    if (data.code === 0) observeNativeRevisions(data.data)
    const payload = data.data
    Object.defineProperty(data, 'data', { enumerable: true, get() { assertHostSession(session.user.id, sessionRevision); return payload } })

    // 使用项目的静态翻译方法（只使用国际化字段，不再使用硬编码回退）
    const networkBusy = directTrans('common', 'networkBusy')

    if (data.code === 401 || data.code === 12000 || data.code === 'SESSION_EXPIRED') {
      return data
    }

    if (data.code !== 0) {
      data.message = getApiErrorMessage(data, networkBusy)
      if (!params.silent && typeof window !== 'undefined') {
        const errorDetails = getApiErrorDetails(data.data)
        notification.warning({
          content: createApiErrorContent(data.message, errorDetails),
          key: 'apiErrorMessage',
          duration: errorDetails.length > 0 ? 6 : 3,
        })
      }
      throw new Error(data.message || networkBusy)
    }

    return data
  }
  catch (e) {
    if (
      (useUserStore.getState().isAuthenticated || params.url.includes('login/'))
      && !params.silent
      && typeof window !== 'undefined'
    ) {
      const errText = directTrans('common', 'networkError')
      notification.error({
        content: createApiErrorContent(errText),
        key: 'apiErrorMessage',
        duration: 3,
      })
    }
    throw e instanceof Error ? e : new Error('主站服务请求未完成，请核对原操作')
  }
}

const nativeHttp = {
  get<T>(url: string, data?: RequestQuery, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      params: data,
      method: 'GET',
      silent,
    })
  },
  post<T>(url: string, data?: RequestData, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      data,
      method: 'POST',
      silent,
    })
  },
  put<T>(url: string, data?: RequestData, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      data,
      method: 'PUT',
      silent,
    })
  },
  delete<T>(url: string, data?: RequestData, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      data,
      method: 'DELETE',
      silent,
    })
  },
  patch<T>(url: string, data?: RequestData, silent?: boolean, options?: RequestOptions) {
    return request<T>({
      ...options,
      url,
      data,
      method: 'PATCH',
      silent,
    })
  },
}

export default nativeHttp
