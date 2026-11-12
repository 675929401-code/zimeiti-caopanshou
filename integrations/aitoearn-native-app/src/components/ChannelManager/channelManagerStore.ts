import { finishNativeOAuthSession, isNativeOAuthPlatform, readNativeOAuthBindings, safeNativeAuthorizationUrl } from '@/integration/native-oauth'
import { getAccountDetailApi } from '@/api/accounts/account.api'
import { assignNativeAccountGroup } from '@/integration/native-auth'
import { NATIVE_UNASSIGNED_GROUP } from '@/integration/account-groups'
import { assertHostSession, getHostSession, getHostSessionRevision, subscribeHostSession } from '@/integration/host-session'
/**
 * ChannelManager - 频道管理器状态管理
 * 管理三页面视图状态、授权状态、侧边栏状态等
 */

import type {
  AuthState,
  AuthUrlResponse,
  ChannelManagerMethods,
  ChannelManagerState,
  ChannelManagerView,
} from './types'
import type { SocialAccount } from '@/api/accounts/account.types'
import type { ChannelAccountAuthStatus } from '@/api/channels/channel.types'
import type { PlatType } from '@/app/config/platConfig'
import type { PluginPlatformType } from '@/store/plugin'
import lodash from 'lodash'
import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { getChannelAccountAuthStatusApi, startChannelAccountAuthApi } from '@/api/channels/channel.api'
import i18next from '@/app/i18n/client'
import { useAccountStore } from '@/store/account'
import { getPlatformInfoSync, isPlatformDisabledSync, isPlatformEnabledSync } from '@/store/platformMetadata'
import {
  isPluginPlatformAccountReady,
  PLUGIN_SUPPORTED_PLATFORMS,
  PluginStatus,
  usePluginStore,
} from '@/store/plugin'
import { toast } from '@/utils/ui/toast'
import { DEFAULT_AUTH_COUNTDOWN, POLLING_INTERVAL } from './types'

/**
 * 获取翻译文本
 */
function t(key: string, options?: Record<string, string>): string {
  return i18next.t(key, { ns: 'account', ...options })
}

function getPlatformName(platform: PlatType) {
  return getPlatformInfoSync(platform)?.name || platform
}

function notifyPlatformComingSoon(platform: PlatType) {
  toast.warning(t('channelManager.platformComingSoon', { platform: getPlatformName(platform) }))
}

/**
 * 检查平台是否为插件支持的平台
 */
function isPluginSupportedPlatform(platform: PlatType): platform is PluginPlatformType {
  return PLUGIN_SUPPORTED_PLATFORMS.includes(platform as PluginPlatformType)
}

/** 初始授权状态 */
const initialAuthState: AuthState = {
  platform: null,
  sessionId: null,
  authUrl: null,
  authMode: 'oauth',
  qrCodeDataUrl: null,
  qrCodePath: null,
  countdown: DEFAULT_AUTH_COUNTDOWN,
  isPolling: false,
  error: null,
  isTimeout: false,
}

/** 初始状态 */
const initialState: ChannelManagerState = {
  open: false,
  currentView: 'main',
  selectedPlatform: 'all',
  authState: { ...initialAuthState },
  targetSpaceId: null,
  onAuthSuccess: null,
  isNewUser: false,
}

function getInitialState(): ChannelManagerState {
  return lodash.cloneDeep(initialState)
}

/** 轮询定时器ID */
let authRunEpoch = 0
let pollingTimerId: ReturnType<typeof setTimeout> | null = null
/** 倒计时定时器ID */
let countdownIntervalId: ReturnType<typeof setInterval> | null = null

/**
 * 清理所有定时器
 */
function clearAllTimers() {
  if (pollingTimerId) {
    clearTimeout(pollingTimerId)
    pollingTimerId = null
  }
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId)
    countdownIntervalId = null
  }
}

/**
 * 根据平台类型获取授权URL
 */
async function getAuthUrl(platform: PlatType, spaceId?: string, restart = false): Promise<AuthUrlResponse> {
  const group = spaceId ? useAccountStore.getState().accountGroupList.find(item => item.id === spaceId && !item.nativeSynthetic) : undefined
  if (spaceId && (!group || !group.nativeRevision)) throw new Error('目标分组版本尚未加载，请刷新后再授权')
  const res = await startChannelAccountAuthApi(platform, { groupId: group?.id, expectedGroupRevision: group?.nativeRevision, nativeRestart: restart })
  if (res?.code !== 0 || !res.data?.sessionId) throw new Error('授权入口暂不可确认，请核对原请求')
  return res.data
}

function getAuthCountdown(expiresAt?: string) {
  if (!expiresAt)
    return DEFAULT_AUTH_COUNTDOWN

  const expiresTime = new Date(expiresAt).getTime()
  if (Number.isNaN(expiresTime))
    return DEFAULT_AUTH_COUNTDOWN

  return Math.max(0, Math.ceil((expiresTime - Date.now()) / 1000))
}

interface AuthStatusResult {
  status: ChannelAccountAuthStatus['status']
  data?: ChannelAccountAuthStatus
  message?: string
}

async function checkAuthStatus(
  platform: PlatType,
  sessionId: string,
): Promise<AuthStatusResult | null> {
  try {
    const res = await getChannelAccountAuthStatusApi(platform, sessionId)

    if (res?.code === 0 && res.data) {
      return {
        status: res.data.status,
        data: res.data,
        message: res.data.status === 'failed' ? res.message : undefined,
      }
    }

    if (res?.message) {
      return { status: 'failed', message: res.message }
    }

    return null
  }
  catch (error) {
    console.error(`Failed to check auth status for ${platform}:`, error)
    return null
  }
}

function getAuthAccountIds(data?: ChannelAccountAuthStatus) {
  return [
    data?.accountId,
    ...(data?.accountIds ?? []),
    ...(data?.accounts?.map(account => account.accountId) ?? []),
  ].filter((accountId): accountId is string => Boolean(accountId))
}

function findAuthorizedAccount(
  accountList: SocialAccount[],
  platform: PlatType,
  data?: ChannelAccountAuthStatus,
) {
  const accountIds = getAuthAccountIds(data)

  if (accountIds.length > 0) {
    const accountIdSet = new Set(accountIds)
    const matchedAccount = accountList.find(account => accountIdSet.has(account.id))

    if (matchedAccount)
      return matchedAccount
  }

  return undefined
}

export const useChannelManagerStore = create(
  combine(getInitialState(), (set, get) => {
    const methods: ChannelManagerMethods = {
      /** 打开弹框（默认显示主页） */
      openModal() {
        const accountList = useAccountStore.getState().accountList
        const isNewUser = accountList.length === 0

        set({
          open: true,
          currentView: isNewUser ? 'connect-list' : 'main',
          isNewUser,
        })
      },

      /** 关闭弹框 */
      closeModal() {
        // 停止所有授权相关的定时器
        methods.stopAuth()
        set({
          open: false,
          currentView: 'main',
          selectedPlatform: 'all',
          authState: { ...initialAuthState },
          targetSpaceId: null,
        })
      },

      /** 直接打开并进入指定平台的授权流程 */
      openAndAuth(platform: PlatType, spaceId?: string) {
        if (getPlatformInfoSync(platform)?.nativeConnectionAllowed !== true) {
          toast.warning(getPlatformInfoSync(platform)?.nativeReason || '此平台尚未接入本站可执行连接通道')
          set({ currentView: 'connect-list', authState: { ...initialAuthState } }); return
        }
        if (isPlatformDisabledSync(platform)) {
          notifyPlatformComingSoon(platform)
          return
        }

        if (!isPlatformEnabledSync(platform)) {
          toast.warning('当前平台运行环境暂不可用，请核对主站连接配置')
          return
        }

        // 如果没有指定空间，使用默认空间
        const accountGroupList = useAccountStore.getState().accountGroupList
        const defaultSpace = accountGroupList.find(g => g.isDefault)
        const targetSpaceId = spaceId && spaceId !== NATIVE_UNASSIGNED_GROUP ? spaceId : defaultSpace?.id || null

        set({
          open: true,
          currentView: 'auth-loading',
          targetSpaceId,
        })

        // 开始授权流程
        methods.startAuth(platform, targetSpaceId || undefined)
      },

      /** 直接打开并进入连接新频道列表页 */
      openConnectList(spaceId?: string) {
        // 如果没有指定空间，使用默认空间
        const accountGroupList = useAccountStore.getState().accountGroupList
        const defaultSpace = accountGroupList.find(g => g.isDefault)
        const targetSpaceId = spaceId && spaceId !== NATIVE_UNASSIGNED_GROUP ? spaceId : defaultSpace?.id || null

        set({
          open: true,
          currentView: 'connect-list',
          targetSpaceId,
          isNewUser: false,
        })
      },

      /** 设置授权成功回调 */
      setOnAuthSuccess(callback) {
        set({ onAuthSuccess: callback })
      },

      /** 切换视图 */
      setCurrentView(view: ChannelManagerView) {
        set({ currentView: view })
      },

      /** 设置侧边栏选中的平台 */
      setSelectedPlatform(platform) {
        set({ selectedPlatform: platform })
      },

      /** 设置目标空间ID */
      setTargetSpaceId(spaceId) {
        set({ targetSpaceId: spaceId === NATIVE_UNASSIGNED_GROUP ? null : spaceId })
      },

      /** 开始授权流程 */
      async startAuth(platform: PlatType, spaceId?: string, restart = false) {
        const epoch = ++authRunEpoch
        const owner = assertHostSession().user.id; const generation = getHostSessionRevision()
        const current = () => getHostSession()?.user.id === owner && getHostSessionRevision() === generation && authRunEpoch === epoch
        if (getPlatformInfoSync(platform)?.nativeConnectionAllowed !== true) {
          toast.warning(getPlatformInfoSync(platform)?.nativeReason || '此平台尚未接入本站可执行连接通道')
          set({ currentView: 'connect-list', authState: { ...initialAuthState } }); return
        }
        if (isPlatformDisabledSync(platform)) {
          notifyPlatformComingSoon(platform)
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          return
        }

        if (!isPlatformEnabledSync(platform)) {
          toast.warning('当前平台运行环境暂不可用，请核对主站连接配置')
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          return
        }

        // 清理之前的定时器
        clearAllTimers()

        const platformInfo = getPlatformInfoSync(platform)
        const authMode: AuthState['authMode'] = platformInfo?.authType === 'qrcode'
          ? 'miniappQr'
          : 'oauth'
        const requestedSpace = spaceId || get().targetSpaceId
        const targetSpaceId = requestedSpace && requestedSpace !== NATIVE_UNASSIGNED_GROUP ? requestedSpace : undefined

        // 设置授权状态
        set({
          currentView: 'auth-loading',
          authState: {
            ...initialAuthState,
            platform,
            nativeEpoch: epoch,
            authMode,
            isPolling: true,
          },
          targetSpaceId: targetSpaceId || null,
        })

        // 检查是否为插件支持的平台
        if (authMode !== 'miniappQr' && isPluginSupportedPlatform(platform)) {
          await methods.handlePluginPlatformAuth(platform, targetSpaceId)
          return
        }

        // OAuth授权流程
        // 先同步打开空白窗口，避免 Safari 拦截弹窗
        const authWindow = authMode === 'oauth' ? window.open('about:blank') : null
        if (authWindow) authWindow.opener = null
        try {
          // 获取授权URL
          const authData = await getAuthUrl(platform, targetSpaceId, restart)
          if (!current()) { authWindow?.close(); return }

          if (!authData) {
            authWindow?.close()
            set({
              authState: {
                ...get().authState,
                error: t('channelManager.authFailedTip'),
                isPolling: false,
              },
            })
            return
          }

          // 更新状态并打开授权窗口/二维码
          set({
            authState: {
              ...get().authState,
              sessionId: authData.sessionId,
              nativeRevision: authData.nativeRevision,
              nativeAuthorization: authData.nativeAuthorization,
              requiresSelection: authData.nativeAuthorization?.state === 'requires_selection',
              authUrl: safeNativeAuthorizationUrl(authData.url) || null,
              countdown: getAuthCountdown(authData.expiresAt),
              qrCodeDataUrl: authMode === 'miniappQr' ? authData.url : null,
            },
          })

          // 设置授权窗口地址
          const safeUrl = safeNativeAuthorizationUrl(authData.url)
          if (authMode === 'oauth' && safeUrl) {
            if (authWindow) {
              authWindow.location.href = safeUrl
            }
            else {
              window.open(safeUrl, '_blank', 'noopener,noreferrer')
            }
          }

          if (!safeUrl) authWindow?.close()

          // 启动倒计时
          countdownIntervalId = setInterval(() => {
            if (!current()) return
            const currentState = get()
            const newCountdown = currentState.authState.countdown - 1

            if (isNativeOAuthPlatform(platform)) {
              set({ authState: { ...currentState.authState, countdown: Math.max(0, newCountdown) } })
            }
            else if (newCountdown <= 0) {
              // 超时
              methods.stopAuth()
              set({
                authState: {
                  ...currentState.authState,
                  isTimeout: true,
                  isPolling: false,
                  countdown: 0,
                },
              })
            }
            else {
              set({
                authState: {
                  ...currentState.authState,
                  countdown: newCountdown,
                },
              })
            }
          }, 1000)

          const pollAuthStatus = async () => {
            if (!current()) return
            const authState = get().authState

            if (
              authState.sessionId !== authData.sessionId
              || authState.platform !== platform
              || !authState.isPolling
            ) {
              return
            }

            const result = await checkAuthStatus(platform, authData.sessionId)
            if (!current()) return
            if (result?.data) set({ authState: { ...get().authState, nativeRevision: result.data.nativeRevision, requiresSelection: result.data.requiresSelection, selectableAccounts: result.data.selectableAccounts, nativeAuthorization: result.data.nativeAuthorization, ...(result.data.nativeAuthorization ? { authUrl: safeNativeAuthorizationUrl(result.data.nativeAuthorization.authUrl) || null } : {}) } })
            const latestAuthState = get().authState

            if (
              latestAuthState.sessionId !== authData.sessionId
              || latestAuthState.platform !== platform
              || !latestAuthState.isPolling
            ) {
              return
            }

            if (result?.status === 'completed') {
              // 授权成功
              clearAllTimers()

              // 刷新账户列表
              await useAccountStore.getState().getAccountList()
              if (!current()) return
              const completedAuthState = get().authState

              if (
                completedAuthState.sessionId !== authData.sessionId
                || completedAuthState.platform !== platform
                || !completedAuthState.isPolling
              ) {
                return
              }

              // 获取新添加的账户
              const accountList = useAccountStore.getState().accountList
              if (result.data?.nativeAuthorization) {
                const session = result.data.nativeAuthorization
                await readNativeOAuthBindings(session)
                if (!current()) return
                const accounts = await Promise.all(session.bindingIds.map(async id => accountList.find(account => account.id === id && account.type === platform && account.nativeAccountKind === 'generic') || (await getAccountDetailApi(id)).data))
                if (!current()) return
                if (accounts.some(account => !account || !session.bindingIds.includes(account.id) || account.type !== platform || account.nativeAccountKind !== 'generic' || account.nativeConnectionCurrent !== true || account.nativeBindingStatus !== 'active')) throw new Error('本次授权绑定尚未完整读取，请核对原会话')
                const callback = get().onAuthSuccess
                finishNativeOAuthSession(session)
                await methods.handleAuthSuccess(accounts[0])
                for (const account of accounts.slice(1)) { if (current()) callback?.(account, platform) }
                if (!current()) return
                toast.success(`已连接本次授权的 ${accounts.length} 个账号；发布能力仍以平台准入为准`)
                return
              }
              const newAccount = findAuthorizedAccount(accountList, platform, result.data)

              if (newAccount) {
                await methods.handleAuthSuccess(newAccount)
              }
              else {
                set({ authState: { ...get().authState, error: '官方会话完成但本站绑定尚未读取，请核对原会话与账号列表', isPolling: false } })
              }
            }
            else if (result?.status === 'failed' || result?.message) {
              clearAllTimers()
              set({
                authState: {
                  ...latestAuthState,
                  error: result.data?.nativeAuthorization?.state === 'expired' ? '原授权已过期，可核对历史或明确重新授权' : result.message || '官方已明确返回授权失败，可核对原会话后重新授权',
                  isPolling: false,
                },
              })
            }
            else {
              pollingTimerId = setTimeout(() => {
                void pollAuthStatus().catch(reason => { if (current()) { clearAllTimers(); set({ authState: { ...get().authState, error: reason instanceof Error ? reason.message : '原授权结果待核对', isPolling: false } }) } })
              }, POLLING_INTERVAL)
            }
          }

          // 启动轮询：每次请求完成后再安排下一轮，避免接口重叠请求
          pollingTimerId = setTimeout(() => {
            void pollAuthStatus().catch(reason => { if (current()) { clearAllTimers(); set({ authState: { ...get().authState, error: reason instanceof Error ? reason.message : '原授权结果待核对', isPolling: false } }) } })
          }, 0)
        }
        catch (error) {
          authWindow?.close()
          if (!current()) return
          set({
            authState: {
              ...get().authState,
              error: error instanceof Error ? error.message : t('channelManager.authFailedTip'),
              isPolling: false,
            },
          })
        }
      },

      /**
       * 处理插件平台的授权（小红书、抖音等）
       * 这些平台通过浏览器插件同步账号，而非OAuth
       */
      async handlePluginPlatformAuth(platform: PluginPlatformType, spaceId?: string) {
        const pluginStore = usePluginStore.getState()
        const platformName = getPlatformInfoSync(platform)?.name || platform

        // 检查插件是否就绪
        if (pluginStore.status !== PluginStatus.READY) {
          // 插件未就绪，重置状态并打开插件弹框
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          toast.warning(t('channelManager.pluginNotReady', { platform: platformName }))
          // 打开插件弹框引导用户安装/授权
          pluginStore.openPluginModal()
          return
        }

        // 检查是否有账号
        const account = pluginStore.platformAccounts[platform]
        if (!account || !isPluginPlatformAccountReady(account)) {
          // 平台未登录，重置状态并打开插件弹框
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          toast.warning(t('channelManager.platformNotLoggedIn', { platform: platformName }))
          // 打开插件弹框引导用户登录
          pluginStore.openPluginModal()
          return
        }

        // 同步账号到数据库
        try {
          const result = await pluginStore.syncAccountToDatabase(platform, spaceId)

          if (result) {
            // 同步成功
            toast.success(t('channelManager.syncSuccess'))

            // 刷新账户列表
            await useAccountStore.getState().getAccountList()

            // 处理授权成功
            await methods.handleAuthSuccess(result)
          }
          else {
            set({
              currentView: 'connect-list',
              authState: { ...initialAuthState },
            })
            toast.error(t('channelManager.syncFailed'))
          }
        }
        catch (error) {
          console.error('Plugin auth error:', error)
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          toast.error(t('channelManager.syncFailed'))
        }
      },

      /** 停止授权（取消/超时） */
      stopAuth() {
        authRunEpoch++
        clearAllTimers()
        set({
          authState: {
            ...get().authState,
            isPolling: false,
          },
        })
      },

      /** 重新打开授权页面 */
      reopenAuthWindow() {
        const { authState } = get()
        if (authState.authMode === 'miniappQr' && authState.platform) {
          methods.startAuth(authState.platform, get().targetSpaceId || undefined)
          return
        }
        const safeUrl = safeNativeAuthorizationUrl(authState.authUrl || undefined)
        if (safeUrl) {
          window.open(safeUrl, '_blank', 'noopener,noreferrer')
        }
      },

      /** 授权成功处理 */
      async handleAuthSuccess(account: SocialAccount) {
        const { authState, onAuthSuccess, selectedPlatform } = get()
        const platform = authState.platform
        const epoch = authRunEpoch
        const owner = assertHostSession().user.id; const generation = getHostSessionRevision()
        if (account.nativeAccountKind !== 'generic' && get().targetSpaceId && get().targetSpaceId !== NATIVE_UNASSIGNED_GROUP && account.groupId !== get().targetSpaceId) {
          try { await assignNativeAccountGroup(account, get().targetSpaceId!); assertHostSession(owner, generation); await useAccountStore.getState().getAccountList() } catch { if (getHostSession()?.user.id !== owner || getHostSessionRevision() !== generation) return; toast.warning('账号已登记，但目标分组尚未保存，请刷新后明确移动分组') }
        }
        assertHostSession(owner, generation)
        if (authRunEpoch !== epoch) return

        // 移动端保持原筛选状态，PC 端切换到授权平台
        const isMobile
          = typeof window !== 'undefined'
            && window.matchMedia('(max-width: 767px)').matches

        // 重置状态，跳转到主页
        set({
          currentView: 'main',
          selectedPlatform: isMobile
            ? selectedPlatform
            : (platform || 'all'),
          authState: { ...initialAuthState },
          isNewUser: false,
        })
        // A callback may open a different flow; do not overwrite it after invocation.
        if (onAuthSuccess && platform) onAuthSuccess(account, platform)
      },

      /** 重置状态 */
      reset() {
        authRunEpoch++
        clearAllTimers()
        set(getInitialState())
      },

      /** 检查是否为新用户 */
      checkIsNewUser() {
        const accountList = useAccountStore.getState().accountList
        set({ isNewUser: accountList.length === 0 })
      },
    }

    return methods
  }),
)

subscribeHostSession(() => { if (!getHostSession()) useChannelManagerStore.getState().reset() })
