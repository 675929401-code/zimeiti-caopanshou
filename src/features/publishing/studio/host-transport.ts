import { assertHostSession, clearHostSession, getHostSessionRevision, NATIVE_API_PATH, trackHostRequest } from './host-session'

export function nativeBffUrl(resource: string) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(resource) || /(?:^|\/)\.\.(?:\/|$)|\\|[\r\n]/.test(resource) || /%2f|%5c|%2e/i.test(resource)) throw new Error('原生模块仅允许本站受控接口')
  const normalized = resource.replace(/^\//, '')
  if (/^(?:login(?:\/|$)|config(?:\/|$)|ai\/config(?:\/|$)|v2\/channels\/oauth(?:\/|$))/.test(normalized)) throw new Error('会员登录与服务配置由主站统一管理')
  if (!normalized || normalized.startsWith('api/')) throw new Error('原生接口路径无效')
  return `${NATIVE_API_PATH}/${normalized}`
}

export function nativeMutationHeaders(method: string, supplied?: HeadersInit) {
  const session = assertHostSession()
  const headers = new Headers()
  headers.set('X-Native-Actor-Id', session.user.id)
  const input = new Headers(supplied)
  for (const name of ['Content-Type', 'Accept', 'Accept-Language']) { const value = input.get(name); if (value) headers.set(name, value) }
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) headers.set('X-Native-CSRF', session.csrfToken)
  return headers
}

export async function nativeBffFetch(resource: string, options: RequestInit = {}) {
  const session = assertHostSession(); const owner = session.user.id; const version = getHostSessionRevision(); const method = (options.method || 'GET').toUpperCase(); const controller = new AbortController(); const release = trackHostRequest(controller)
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) controller.abort()
  let responseOwnsRequest = false
  const finish = () => { release(); options.signal?.removeEventListener('abort', abort) }
  try {
    const response = await fetch(nativeBffUrl(resource), { ...options, method, headers: nativeMutationHeaders(method, options.headers), credentials: 'same-origin', mode: 'same-origin', redirect: 'error', referrerPolicy: 'same-origin', signal: controller.signal })
    assertHostSession(owner, version)
    if (response.status === 401 || response.status === 403) { clearHostSession(); throw new Error('主站登录已过期或功能权限已变化，请回到主站核对') }
    if (response.status === 409) {
      const failure: unknown = await response.clone().json().catch(() => null)
      assertHostSession(owner, version)
      if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'NATIVE_ACTOR_CHANGED') { clearHostSession(); throw new Error('主站账号已切换，原会话已停止，请重新进入工作台') }
    }
    if (!response.body) { finish(); return response }
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          assertHostSession(owner, version)
          const chunk = await reader.read()
          assertHostSession(owner, version)
          if (chunk.done) { finish(); stream.close() } else stream.enqueue(chunk.value)
        } catch (reason) { finish(); void reader.cancel().catch(() => {}); stream.error(reason) }
      },
      async cancel(reason) { finish(); await reader.cancel(reason) },
    })
    responseOwnsRequest = true
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } finally { if (!responseOwnsRequest) finish() }
}
