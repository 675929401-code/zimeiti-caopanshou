import {
  createPublishingPluginRunner, inspectPublishingPlugin, PublishingPluginError,
  type NativePublishingPermit, type PublishingPluginAccount, type PublishingPluginParams,
  type PublishingPluginProgress, type PublishingPluginReceipt,
} from './publishing-plugin'

// Current public WebAPI contract, separate from the fixed 47e5a6 official flow:
// https://docs.aitoearn.ai/zh/use/plugin-publish (reviewed 2026-11-10).
// No invented minimum version, server grant, URL download or permanent UID claim.
const allowedKeys = new Set(['platform', 'type', 'title', 'desc', 'topics', 'cover', 'visibility', 'requestId', 'platformConfig', 'scheduledTime', 'video', 'images'])
const invalid = (): never => { throw new PublishingPluginError('media_invalid') }
const validImage = (value: unknown): value is File => typeof File !== 'undefined' && value instanceof File
  && value.size > 0 && value.size <= 20 * 1024 ** 2
  && (value.type === 'image/png' && /\.png$/i.test(value.name) || value.type === 'image/jpeg' && /\.jpe?g$/i.test(value.name))
const safeText = (value: unknown): value is string => typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)

function freezeParams(input: PublishingPluginParams, attemptId: string): PublishingPluginParams {
  if (!input || Object.keys(input).some(key => !allowedKeys.has(key)) || input.platform !== 'douyin'
    || !safeText(input.title) || Array.from(input.title).length > 30
    || !safeText(input.desc) || Array.from(input.desc).length > 1000
    || !Array.isArray(input.topics) || input.topics.length > 5
    || input.topics.some(topic => !safeText(topic) || !topic.trim() || topic !== topic.trim() || topic.includes('#') || topic.length > 1000)) invalid()
  // The public contract explicitly does not support Douyin privacy/mentions.
  // Public is the common editor default; private must never silently become public.
  if (input.visibility !== undefined && input.visibility !== 'public') invalid()
  if (input.platformConfig !== undefined && (!input.platformConfig || typeof input.platformConfig !== 'object'
    || Array.isArray(input.platformConfig) || Object.keys(input.platformConfig).length)) invalid()
  const requestId = `native:${attemptId}`
  if (!/^[A-Za-z0-9_.:-]{1,240}$/u.test(requestId) || input.requestId !== undefined && input.requestId !== requestId) invalid()
  if (input.scheduledTime !== undefined && (!Number.isSafeInteger(input.scheduledTime)
    || input.scheduledTime <= Date.now() || input.scheduledTime >= 8640000000000000)) invalid()
  const common = { platform: 'douyin' as const, title: input.title, desc: input.desc, topics: [...input.topics],
    requestId,
    ...(input.scheduledTime === undefined ? {} : { scheduledTime: input.scheduledTime }) }
  // File and size limits are this host's reviewed media boundary, not a claim
  // that the supplier guarantees all files within these limits will publish.
  if (input.type === 'image') {
    if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 35
      || input.images.some(file => !validImage(file)) || input.video !== undefined || input.cover !== undefined) invalid()
    return { ...common, type: 'image', images: [...input.images] }
  }
  if (input.type !== 'video' || typeof File === 'undefined' || !(input.video instanceof File)
    || input.video.size < 1 || input.video.size > 1024 ** 3 || input.video.type !== 'video/mp4'
    || !/\.mp4$/i.test(input.video.name) || input.images !== undefined
    || input.cover !== undefined && !validImage(input.cover)) invalid()
  return { ...common, type: 'video', video: input.video, ...(input.cover ? { cover: input.cover } : {}) }
}

export function createDouyinPublishingPluginRunner(source?: unknown) {
  const runner = createPublishingPluginRunner(source), started = new Set<string>()
  return {
    async executeNative(permit: NativePublishingPermit, expected: PublishingPluginAccount, params: PublishingPluginParams,
      onProgress?: (event: PublishingPluginProgress) => void, shouldContinue: () => boolean = () => true): Promise<PublishingPluginReceipt> {
      if (permit.shouldExecute !== true || !permit.attemptId) throw new PublishingPluginError('permit_required')
      if (started.has(permit.attemptId)) throw new PublishingPluginError('already_started')
      started.add(permit.attemptId) // Any failure after claim, including busy, cannot replay this permit.
      const current = () => { try { if (shouldContinue()) return } catch { /* Closed session error below. */ } throw new PublishingPluginError('session_changed') }
      current()
      if (permit.platform !== 'douyin' || expected.platform !== 'douyin' || !expected.uid
        || expected.uid !== expected.uid.trim() || expected.uid.length > 160 || /[\u0000-\u001f\u007f]/u.test(expected.uid)) throw new PublishingPluginError('account_changed')
      const frozen = freezeParams(params, permit.attemptId), account = { ...expected }, execution = { ...permit }
      if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new PublishingPluginError('transport_unavailable')
      // Lock scope intentionally omits owner: two member tabs using one browser
      // login must not drive the same platform account at the same time.
      return navigator.locks.request(`publishing:browser:douyin:${encodeURIComponent(account.uid)}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new PublishingPluginError('account_busy')
        current()
        const inspected = await inspectPublishingPlugin('douyin', source)
        current()
        if (inspected.account.uid !== account.uid) throw new PublishingPluginError('account_changed')
        // Existing dispatch verifies permission and login again immediately before
        // publish, consumes once, and projects errors/progress/receipt safely.
        return runner.executeBrowserPermit(execution, account, frozen, progress => {
          // Stale progress must not reach a changed editor or a different owner.
          try { current() } catch { return }
          onProgress?.(progress)
        }, () => { current(); return true })
        // A dispatched request cannot be cancelled here. Preserve its safe
        // receipt for the caller's original-owner pending marker; that caller
        // checks owner/session before persistence and form revision afterward.
      })
    },
  }
}
