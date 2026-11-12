import { nativePluginApi } from '@/integration/plugin-api'
import { assertHostSession, getHostSession, getHostSessionRevision, subscribeHostSession } from '@/integration/host-session'
import { projectPluginAccount } from '@/integration/plugin-account'
/**
 * 浏览器插件状态管理 Store
 */

import type {
  PlatAccountInfo,
  PlatformPublishTask,
  PluginPlatformType,
  ProgressCallback,
  ProgressEvent,
  PublishParams,
  PublishResult,
  PublishTask,
  PublishTaskListConfig,
} from './types/baseTypes'
import type { CreateChannelAccountParams, SocialAccount } from '@/api/accounts/account.types'
import type { IPubParams } from '@/components/PublishDialog/publishDialog.type'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import lodash from 'lodash'
import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { createChannelAccountApi } from '@/api/accounts/account.api'
import { PlatType } from '@/app/config/platConfig'
import { directTrans } from '@/app/i18n/client'
import { PluginVersionLast } from '@/constant'
import { useAccountStore } from '@/store/account'
import { isPlatformEnabledSync } from '@/store/platformMetadata'
import { toast } from '@/utils/ui/toast'
import { isPluginPlatformAccountReady, mergePluginAccountStatus } from './account.utils'
import { DEFAULT_POLLING_INTERVAL } from './constants'
import {
  calculateOverallStatus,
  createInitialPlatformAccounts,
  generateId,
} from './plugin.utils'
import {
  PLUGIN_SUPPORTED_PLATFORMS,
  PluginStatus as Status,
} from './types/baseTypes'

// 启用 dayjs utc 插件
dayjs.extend(utc)

/**
 * 插件发布项接口
 * 描述单个平台的发布内容
 */
export interface PluginPublishItem {
  /** 账号信息 */
  account: SocialAccount
  /** 发布参数 */
  params: IPubParams
}

/**
 * 单个平台发布进度事件（扩展 ProgressEvent，附带账号信息）
 */
export interface PlatformProgressEvent extends ProgressEvent {
  /** 账号ID */
  accountId: string
  /** 平台类型 */
  platform: PluginPlatformType
  /** 请求ID */
  requestId: string
}

/**
 * 发布进度回调类型
 */
export type ExecuteProgressCallback = (event: PlatformProgressEvent) => void

/**
 * 执行插件发布的参数
 */
export interface ExecutePluginPublishParams {
  /** 需要发布的项目列表 */
  items: PluginPublishItem[]
  /** 账号ID 到 requestId 的映射（用于进度匹配） */
  platformTaskIdMap: Map<string, string>
  /** 发布时间（ISO 格式字符串，可选，不传则立即发布） */
  publishTime?: string
  /** 发布进度回调（可选，每个平台发布时都会触发） */
  onProgress?: ExecuteProgressCallback
  /** 发布完成后的回调（可选，传入发布记录ID） */
  onComplete?: (publishRecordId?: string) => void
  /** 关联的用户任务ID（如果是从任务流程发布） */
  userTaskId?: string
  /** 关联的素材组 ID（如果是从任务流程发布） */
  materialGroupId?: string
  /** 关联的草稿素材 ID（如果是从任务流程发布且存在推荐草稿） */
  materialId?: string
  /** 是否跳过添加发布任务到 store（用于 PluginPublishCard 内联发布，避免触发弹框） */
  skipAddTask?: boolean
}

/** 平台账号信息映射 */
export type PlatformAccountsMap = Record<PluginPlatformType, PlatAccountInfo | null>

interface RefreshPlatformAccountsOptions {
  syncAccountStore?: boolean
}

interface AccountStatusSnapshotOptions {
  waitForPluginApi?: boolean
}

/** 错误消息 */
const ERROR_MESSAGES = {
  PLUGIN_NOT_INSTALLED: '请先安装 Aitoearn 浏览器插件',
  PLUGIN_NOT_READY: '插件未就绪，请先授权插件权限',
  PUBLISHING_IN_PROGRESS: '当前正在发布中，请稍后再试',
  PLATFORM_REGION_RESTRICTED: '该平台在当前区域不可用',
} as const

const PLUGIN_API_INJECTION_WAIT_TIMEOUT_MS = 1500
const PLUGIN_API_INJECTION_WAIT_INTERVAL_MS = 50

function hasPluginApi() {
  return typeof window !== 'undefined' && !!nativePluginApi()
}

function wait(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function waitForPluginApiInjection() {
  if (hasPluginApi() || typeof window === 'undefined')
    return

  const startedAt = Date.now()
  while (Date.now() - startedAt < PLUGIN_API_INJECTION_WAIT_TIMEOUT_MS) {
    const remainingMs = PLUGIN_API_INJECTION_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
    await wait(Math.min(PLUGIN_API_INJECTION_WAIT_INTERVAL_MS, remainingMs))

    if (hasPluginApi())
      return
  }
}

/**
 * 生成发布标识key（用于区分不同账号的发布）
 * @param platform 平台类型
 * @param accountId 账号ID（可选）
 */
function getPublishKey(platform: PluginPlatformType, accountId?: string): string {
  return accountId ? `${platform}-${accountId}` : platform
}

/** 平台发布进度映射，key 为 platform 或 platform-accountId */
export type PlatformProgressMap = Map<string, ProgressEvent>
export type PluginVersionLoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable'
const FALLBACK_PLUGIN_VERSION = '3.0.0'

function comparePluginVersions(currentVersion: string, latestVersion: string) {
  const currentParts = currentVersion.split('.').map(part => Number.parseInt(part, 10) || 0)
  const latestParts = latestVersion.split('.').map(part => Number.parseInt(part, 10) || 0)
  const maxLength = Math.max(currentParts.length, latestParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const current = currentParts[index] ?? 0
    const latest = latestParts[index] ?? 0

    if (current > latest)
      return 1
    if (current < latest)
      return -1
  }

  return 0
}

/** 插件 Store 状态接口（只定义属性） */
export interface IPluginStore {
  status: Status
  /** 插件是否已授予站点访问权限 */
  hostAccessGranted: boolean | null
  pollingTimer: NodeJS.Timeout | null
  /** 插件是否正在初始化（检测插件、权限、账号登录状态） */
  isInitializing: boolean
  /** 是否正在发布（任意平台） */
  isPublishing: boolean
  /** 正在发布的集合，key 为 platform 或 platform-accountId，支持同一平台多账号同时发布 */
  publishingPlatforms: Set<string>
  /** 当前发布进度（最新一个） */
  publishProgress: ProgressEvent | null
  /** 各平台发布进度，key 为 platform 或 platform-accountId */
  platformProgress: PlatformProgressMap
  publishTasks: PublishTask[]
  taskListConfig: PublishTaskListConfig
  platformAccounts: PlatformAccountsMap
  /** 插件弹框是否可见 */
  pluginModalVisible: boolean
  /** 当前打开中的发布详情弹框数量，用于全局悬浮入口避让 */
  publishDetailModalOpenCount: number
  /** 是否正在创建发布记录 */
  isCreatingRecord: boolean
  /** 当前插件版本 */
  pluginVersion: string | null
  /** 插件版本获取状态 */
  pluginVersionStatus: PluginVersionLoadStatus
  /** 插件是否可更新 */
  pluginNeedsUpdate: boolean
}

const store: IPluginStore = {
  status: Status.UNKNOWN,
  hostAccessGranted: null,
  pollingTimer: null,
  isInitializing: true, // 初始状态为正在初始化
  isPublishing: false,
  publishingPlatforms: new Set(),
  publishProgress: null,
  platformProgress: new Map(),
  publishTasks: [],
  taskListConfig: {
    maxTasks: 100,
    autoCleanCompleted: false,
    cleanAfter: 24 * 60 * 60 * 1000,
  },
  platformAccounts: createInitialPlatformAccounts(),
  pluginModalVisible: false,
  publishDetailModalOpenCount: 0,
  isCreatingRecord: false,
  pluginVersion: null,
  pluginVersionStatus: 'idle',
  pluginNeedsUpdate: false,
}

function getStore() {
  return lodash.cloneDeep(store)
}

/** 创建插件管理 Store */
export const usePluginStore = create(
  combine({ ...getStore() }, (set, get) => {
    const methods = {
      clear() {
        set({ ...getStore() })
      },

      /** 打开插件弹框 */
      openPluginModal() {
        set({ pluginModalVisible: true })
      },

      /** 关闭插件弹框 */
      closePluginModal() {
        set({ pluginModalVisible: false })
      },

      /** 标记发布详情弹框已打开 */
      registerPublishDetailModalOpen() {
        set(state => ({
          publishDetailModalOpenCount: state.publishDetailModalOpenCount + 1,
        }))
      },

      /** 标记发布详情弹框已关闭 */
      unregisterPublishDetailModalOpen() {
        set(state => ({
          publishDetailModalOpenCount: Math.max(0, state.publishDetailModalOpenCount - 1),
        }))
      },

      /** 清空插件版本信息 */
      clearPluginVersion() {
        set({
          pluginVersion: null,
          pluginVersionStatus: 'idle',
          pluginNeedsUpdate: false,
        })
      },

      /** 获取插件版本信息 */
      async fetchPluginVersion(force = false) {
        const plugin = typeof window !== 'undefined' ? nativePluginApi() : undefined
        const isInstalled = !!plugin
        const { pluginVersion, pluginVersionStatus, status } = get()

        if (!isInstalled || status !== Status.READY) {
          methods.clearPluginVersion()
          return null
        }

        if (!force && pluginVersionStatus === 'loading')
          return pluginVersion

        if (!force && pluginVersionStatus === 'ready' && pluginVersion)
          return pluginVersion

        set({ pluginVersionStatus: 'loading' })

        try {
          const version = (await plugin?.getVersion?.())?.version?.trim() || FALLBACK_PLUGIN_VERSION

          set({
            pluginVersion: version,
            pluginVersionStatus: 'ready',
            pluginNeedsUpdate: comparePluginVersions(version, PluginVersionLast) < 0,
          })

          return version
        }
        catch (error) {
          console.error('获取插件版本失败:', error)
          set({
            pluginVersion: FALLBACK_PLUGIN_VERSION,
            pluginVersionStatus: 'ready',
            pluginNeedsUpdate: comparePluginVersions(FALLBACK_PLUGIN_VERSION, PluginVersionLast) < 0,
          })
          return FALLBACK_PLUGIN_VERSION
        }
      },

      /** 检查插件是否安装 */
      checkPlugin() {
        const isAvailable = typeof window !== 'undefined' && !!nativePluginApi()

        if (!isAvailable) {
          methods.clearPluginVersion()
          set({ status: Status.NOT_INSTALLED, hostAccessGranted: null })
          return false
        }
        const currentStatus = get().status
        if (currentStatus === Status.UNKNOWN || currentStatus === Status.NOT_INSTALLED) {
          set({ status: Status.CHECKING, hostAccessGranted: null })
        }
        return true
      },

      /** 检查插件权限 */
      async checkPermission() {
        const isInstalled = typeof window !== 'undefined' && !!nativePluginApi()
        if (!isInstalled) {
          methods.clearPluginVersion()
          set({ status: Status.NOT_INSTALLED, hostAccessGranted: null })
          return false
        }
        try {
          const result = await nativePluginApi()!.checkPermission()
          const hostAccessGranted = typeof result.hostAccess === 'boolean' ? result.hostAccess : null
          if (result.granted && result.hostAccess !== false) {
            set({ status: Status.READY, hostAccessGranted: true })
            void methods.fetchPluginVersion(true)
            return true
          }
          else {
            methods.clearPluginVersion()
            set({ status: Status.INSTALLED_NO_PERMISSION, hostAccessGranted })
            return false
          }
        }
        catch (error) {
          console.error('权限检查失败:', error)
          methods.clearPluginVersion()
          set({ status: Status.INSTALLED_NO_PERMISSION, hostAccessGranted: null })
          return false
        }
      },

      /** 开始轮询插件状态 */
      startPolling(interval = DEFAULT_POLLING_INTERVAL) {
        const { pollingTimer } = get()
        if (pollingTimer)
          methods.stopPolling()

        set({ status: Status.CHECKING })

        const poll = async () => {
          const isInstalled = methods.checkPlugin()
          if (!isInstalled)
            return

          const hasPermission = await methods.checkPermission()
          // 已安装且已授权，停止轮询并刷新账号信息
          if (hasPermission) {
            methods.stopPolling()
            await methods.refreshAllPlatformAccounts()
          }
        }

        poll()
        const timer = setInterval(poll, interval)
        set({ pollingTimer: timer })
      },

      /** 停止轮询插件状态 */
      stopPolling() {
        const { pollingTimer } = get()
        if (pollingTimer) {
          clearInterval(pollingTimer)
          set({ pollingTimer: null })
        }
      },

      /**
       * 初始化方法
       * 1. 先将所有抖音和小红书账号设为离线
       * 2. 检查插件状态，未安装或未授权则轮询，已就绪则刷新账号
       */
      async init() {
        // 设置初始化状态
        set({ isInitializing: true })

        // 先将所有插件支持的平台账号设为离线
        methods.setAllPluginAccountsOffline()

        const isInstalled = methods.checkPlugin()
        if (!isInstalled) {
          // 未安装，开始轮询，初始化完成
          set({ isInitializing: false })
          methods.startPolling()
          return
        }

        const hasPermission = await methods.checkPermission()
        if (!hasPermission) {
          // 未授权，开始轮询，初始化完成
          set({ isInitializing: false })
          methods.startPolling()
          return
        }

        // 已就绪，刷新账号信息
        await methods.refreshAllPlatformAccounts()
        // 初始化完成
        set({ isInitializing: false })
      },

      /** 将所有插件支持的平台账号设为离线 */
      setAllPluginAccountsOffline() {
        const { accountList } = useAccountStore.getState()
        const mergedAccountState = mergePluginAccountStatus(accountList, createInitialPlatformAccounts())
        const hasChange = mergedAccountState.accountList.some((account, index) => account !== accountList[index])

        if (hasChange)
          useAccountStore.setState(mergedAccountState)
      },

      /**
       * 同步账号状态（仅当插件已就绪时执行）
       * 用于刷新账号列表后，不重新授权，只同步在线/离线状态
       */
      async syncAccountStatus() {
        methods.setAllPluginAccountsOffline()
        const { status } = get()
        if (status === Status.READY) {
          await methods.refreshAllPlatformAccounts()
        }
      },

      /** 获取插件平台账号状态快照，不直接回写 accountList */
      async getAccountStatusSnapshot(isBackground = false, options?: AccountStatusSnapshotOptions) {
        if (isBackground) {
          set({ isInitializing: true })
        }

        const finish = (accounts: PlatformAccountsMap) => {
          if (isBackground) {
            set({ isInitializing: false })
          }
          return accounts
        }

        const offlineAccounts = createInitialPlatformAccounts()
        if (options?.waitForPluginApi) {
          await waitForPluginApiInjection()
        }

        const isInstalled = methods.checkPlugin()
        if (!isInstalled) {
          if (isBackground) {
            methods.startPolling()
          }
          return finish(offlineAccounts)
        }

        const hasPermission = await methods.checkPermission()
        if (!hasPermission) {
          if (isBackground) {
            methods.startPolling()
          }
          return finish(offlineAccounts)
        }

        const accounts = await methods.refreshAllPlatformAccounts({ syncAccountStore: false })
        return finish(accounts)
      },

      /** 刷新所有平台账号信息，并同步更新 accountList 中的在线/离线状态 */
      async refreshAllPlatformAccounts(options?: RefreshPlatformAccountsOptions) {
        const syncAccountStore = options?.syncAccountStore ?? true
        const { status } = get()
        if (status !== Status.READY)
          return createInitialPlatformAccounts()

        const accounts: PlatformAccountsMap = createInitialPlatformAccounts()
        const session = assertHostSession(); const sessionRevision = getHostSessionRevision()

        await Promise.all(
          PLUGIN_SUPPORTED_PLATFORMS.map(async (platform) => {
            try {
              const raw = await nativePluginApi()!.login(platform)
              assertHostSession(session.user.id, sessionRevision)
              accounts[platform] = projectPluginAccount(platform, raw)
            }
            catch {
              accounts[platform] = null
            }
          }),
        )

        assertHostSession(session.user.id, sessionRevision)
        set({ platformAccounts: accounts as PlatformAccountsMap })

        if (syncAccountStore) {
          const { accountList } = useAccountStore.getState()
          const mergedAccountState = mergePluginAccountStatus(accountList, accounts)
          const hasChange = mergedAccountState.accountList.some((account, index) => account !== accountList[index])

          if (hasChange) {
            useAccountStore.setState(mergedAccountState)
          }
        }

        return accounts
      },

      /** 同步插件账号到数据库 */
      async syncAccountToDatabase(platform: PluginPlatformType, groupId?: string) {
        if (!isPlatformEnabledSync(platform)) {
          console.warn('同步账号失败：该平台在当前区域不可用', platform)
          return null
        }

        const { platformAccounts } = get()
        const account = platformAccounts[platform]

        if (!account || !isPluginPlatformAccountReady(account)) {
          console.warn('同步账号失败：该平台未完成登录', platform)
          return null
        }

        try {
          const accountData: CreateChannelAccountParams = {
            type: platform,
            uid: account.uid,
            nickname: account.nickname,
          }

          if (account.avatar)
            accountData.avatar = account.avatar

          if (groupId)
            accountData.groupId = groupId

          const existing = useAccountStore.getState().accountList.find(item => item.type === platform && item.uid === account.uid && item.nickname === account.nickname && (item.avatar || '') === (account.avatar || ''))
          if (existing) return existing
          const result = await createChannelAccountApi(accountData)

          if (result?.code === 0) {
            await useAccountStore.getState().getAccountList()
            return result.data ? useAccountStore.getState().accountMap.get(result.data.id) || result.data : null
          }
          else {
            console.error('同步账号失败:', result?.message)
            return null
          }
        }
        catch (error) {
          console.error('同步账号到数据库失败:', error)
          return null
        }
      },

      /** 登录到指定平台 */
      async login(platform: PluginPlatformType) {
        const { status, platformAccounts } = get()

        if (status === Status.NOT_INSTALLED)
          throw new Error(ERROR_MESSAGES.PLUGIN_NOT_INSTALLED)

        if (status !== Status.READY)
          throw new Error(ERROR_MESSAGES.PLUGIN_NOT_READY)

        try {
          const session = assertHostSession(); const sessionRevision = getHostSessionRevision()
          const raw = await nativePluginApi()!.login(platform)
          assertHostSession(session.user.id, sessionRevision)
          const result = projectPluginAccount(platform, raw)
          if (!result) throw new Error("插件未返回可用的账号摘要")
          set({
            platformAccounts: { ...platformAccounts, [platform]: result },
          })
          await methods.syncAccountToDatabase(platform)
          return result
        }
        catch (error) {
          console.error('登录失败:', error)
          throw error
        }
      },

      /** 发布内容到指定平台 */
      async publish(_params: PublishParams, _onProgress?: ProgressCallback): Promise<PublishResult> {
        void _params; void _onProgress
        throw new Error('发布必须先取得主站原子执行许可，请使用原生编辑器的确认提交入口')
      },

      /** 重置发布状态 */
      resetPublishState() {
        set({
          isPublishing: false,
          publishingPlatforms: new Set(),
          publishProgress: null,
          platformProgress: new Map(),
        })
      },

      /** 获取指定平台/账号的发布进度 */
      getPlatformProgress(platform: PluginPlatformType, accountId?: string) {
        const publishKey = getPublishKey(platform, accountId)
        return get().platformProgress.get(publishKey) || null
      },

      /** 清除指定平台/账号的发布进度 */
      clearPlatformProgress(platform: PluginPlatformType, accountId?: string) {
        const publishKey = getPublishKey(platform, accountId)
        const updatedProgress = new Map(get().platformProgress)
        updatedProgress.delete(publishKey)
        set({ platformProgress: updatedProgress })
      },

      /** 添加发布任务 */
      addPublishTask(task: Omit<PublishTask, 'id' | 'createdAt' | 'updatedAt' | 'overallStatus'>) {
        const id = generateId()
        const now = Date.now()

        const newTask: PublishTask = {
          ...task,
          id,
          createdAt: now,
          updatedAt: now,
          overallStatus: calculateOverallStatus(task.platformTasks),
        }

        set((state) => {
          const tasks = [newTask, ...state.publishTasks]
          if (state.taskListConfig.maxTasks && tasks.length > state.taskListConfig.maxTasks) {
            tasks.splice(state.taskListConfig.maxTasks)
          }
          return { publishTasks: tasks }
        })

        return id
      },

      /**
       * 更新平台任务（使用平台任务ID精确匹配）
       * @param taskId 发布任务ID
       * @param platformTaskId 平台任务ID（精确匹配）
       * @param updates 更新内容
       */
      updatePlatformTask(
        taskId: string,
        platformTaskId: string,
        updates: Partial<PlatformPublishTask>,
      ) {
        set((state) => {
          const tasks = state.publishTasks.map((task) => {
            if (task.id !== taskId)
              return task

            const platformTasks = task.platformTasks.map((pt: PlatformPublishTask) => {
              // 使用平台任务ID精确匹配
              if (pt.id !== platformTaskId)
                return pt
              return { ...pt, ...updates }
            })

            return {
              ...task,
              platformTasks,
              updatedAt: Date.now(),
              overallStatus: calculateOverallStatus(platformTasks),
            }
          })
          return { publishTasks: tasks }
        })
      },

      /**
       * 通过 requestId 更新平台任务进度（插件回调使用）
       * @param requestId 插件返回的请求ID
       * @param updates 更新内容
       */
      updatePlatformTaskByRequestId(requestId: string, updates: Partial<PlatformPublishTask>) {
        set((state) => {
          const tasks = state.publishTasks.map((task) => {
            // 在该任务的所有平台任务中查找匹配的 requestId
            const hasMatch = task.platformTasks.some(pt => pt.requestId === requestId)

            if (!hasMatch)
              return task

            const platformTasks = task.platformTasks.map((pt: PlatformPublishTask) => {
              // 使用 requestId 精确匹配
              if (pt.requestId !== requestId)
                return pt
              return { ...pt, ...updates }
            })

            return {
              ...task,
              platformTasks,
              updatedAt: Date.now(),
              overallStatus: calculateOverallStatus(platformTasks),
            }
          })
          return { publishTasks: tasks }
        })
      },

      /** 删除发布任务 */
      deletePublishTask(taskId: string) {
        set(state => ({
          publishTasks: state.publishTasks.filter(task => task.id !== taskId),
        }))
      },

      /** 清空所有任务 */
      clearPublishTasks() {
        set({ publishTasks: [] })
      },

      /** 获取任务详情 */
      getPublishTask(taskId: string) {
        return get().publishTasks.find(task => task.id === taskId)
      },

      /** 更新任务列表配置 */
      updateTaskListConfig(config: Partial<PublishTaskListConfig>) {
        set(state => ({
          taskListConfig: { ...state.taskListConfig, ...config },
        }))
      },

      /**
       * 执行插件发布（封装完整的发布流程）
       * 支持并行发布多个平台，支持定时发布
       * @param params 发布参数
       * @returns Promise<void>
       */
      async executePluginPublish(_params: ExecutePluginPublishParams): Promise<void> {
        void _params
        throw new Error('原裸插件发布入口已关闭；请通过主站版本快照与原子许可执行')
      },
    }

    return methods
  }),
)

subscribeHostSession(() => { if (!getHostSession()) { usePluginStore.getState().clear(); usePluginStore.setState({ platformAccounts: createInitialPlatformAccounts(), publishTasks: [], publishingPlatforms: new Set(), platformProgress: new Map(), publishProgress: null, isPublishing: false, isCreatingRecord: false }) } })
