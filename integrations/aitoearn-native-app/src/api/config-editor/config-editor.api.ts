import type { ConfigEditorConfigDto, ConfigEditorConfigVo } from './config-editor.types'
import { getAccountListApi } from '@/api/accounts/account.api'
const disconnected = () => Promise.reject(new Error('服务配置由主站管理员统一管理'))
import { ConfigEditorServiceTarget } from './config-editor.types'

function getConfigEditorRoute(target: ConfigEditorServiceTarget, path = '') {
  const baseRoute = target === ConfigEditorServiceTarget.Ai ? 'ai/config' : 'config'
  return path ? `${baseRoute}/${path}` : baseRoute
}

export function getConfigEditorConfigApi(target = ConfigEditorServiceTarget.Server, silent = true) {
  return disconnected() as Promise<{ code: number, data: ConfigEditorConfigVo, message: string }>
}

export function validateConfigEditorConfigApi(data: ConfigEditorConfigDto, target = ConfigEditorServiceTarget.Server, silent = true) {
  return disconnected()
}

export function saveConfigEditorConfigApi(data: ConfigEditorConfigDto, target = ConfigEditorServiceTarget.Server, silent = true) {
  return disconnected()
}

export function restartConfigEditorServiceApi(target = ConfigEditorServiceTarget.Server, silent = true) {
  return disconnected()
}

export async function checkConfigEditorConfigReadyApi(target = ConfigEditorServiceTarget.Server, timeoutMs = 2500) {
  const timeout = new Promise<false>(resolve => setTimeout(() => resolve(false), timeoutMs))

  if (target === ConfigEditorServiceTarget.Server) {
    return Promise.race([
      getAccountListApi(true)
        .then(response => !!response && response.code === 0)
        .catch(() => false),
      timeout,
    ])
  }

  const readiness = getConfigEditorConfigApi(target, true)
    .then(response => !!response && response.code === 0)
    .catch(() => false)

  return Promise.race([readiness, timeout])
}
