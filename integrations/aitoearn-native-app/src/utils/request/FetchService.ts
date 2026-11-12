import type { IFetchServiceConfig, RequestParams } from './types'
import { nativeBffFetch } from '@/integration/host-transport'
/** Same-origin, closed BFF transport. Absolute remote URLs and bearer injection are forbidden. */
class FetchService<T = Response> {
  baseURL: string
  requestInterceptor?: (requestParams: RequestParams) => RequestParams | void | null
  responseInterceptor?: (response: Response) => T
  constructor({ baseURL, requestInterceptor, responseInterceptor }: IFetchServiceConfig<T>) { this.baseURL = baseURL; this.requestInterceptor = requestInterceptor; this.responseInterceptor = responseInterceptor }
  async request(input: RequestParams): Promise<T> {
    const params = this.requestInterceptor ? this.requestInterceptor(input) : input
    if (!params) throw new Error('请求已停止')
    const { url, data, params: query, ...options } = params
    const headers = new Headers(options.headers)
    let body = options.body
    if (!body && data !== undefined) { if (typeof FormData !== 'undefined' && data instanceof FormData) body = data; else { body = JSON.stringify(data); headers.set('Content-Type', 'application/json') } }
    const search = new URLSearchParams()
    if (query) for (const [key, value] of Object.entries(query)) { if (value === undefined || value === null) continue; if (Array.isArray(value)) value.forEach(item => search.append(key, String(item))); else search.set(key, String(value)) }
    const suffix = search.toString()
    const response = await nativeBffFetch(`${url}${suffix ? `${url.includes('?') ? '&' : '?'}${suffix}` : ''}`, { ...options, body, headers })
    return this.responseInterceptor ? this.responseInterceptor(response) : response as T
  }
}
export default FetchService
