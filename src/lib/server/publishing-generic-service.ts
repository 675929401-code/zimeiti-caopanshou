import 'server-only'
import { randomUUID } from 'node:crypto'
import type { AuthUser, getSupabase } from '../api-middleware'
import { PublishingDraftProfileSchema, PublishingGenericMutationSchema, PublishingGenericOperationSchema, PublishingGenericTargetSchema, PublishingStudioStoredDraftSchema, type PublishingGenericAction, type PublishingGenericQuery, type PublishingStudioStoredDraft, type PublishingTargetProfile } from '../publishing-generic-contract'
import { PublishingAuthorizationPlatformSchema } from '../publishing-authorization-contract'
import { readMemberPermissionSnapshot } from './member-permission-authority'
import { PublishingError, publishingRuntimeEnabled } from './publishing-service'
import { readPublishingProviderConfiguration, readPublishingProviderConfigurationForNamespace, OVERSEAS_PUBLISHING_PLATFORMS } from './publishing-provider-config'
import { PublishingProvider, PublishingProviderError, publishingProviderPayloadHash, projectProviderStatus, validatePublishingProviderOptions, type PublishingProviderFlowInput, type PublishingProviderGrant } from './publishing-provider'
import { readNativeMediaSource } from './native-main-media'
import { effectiveGenericPublishingContent, validateGenericPublishingContent, validateGenericPublishingPolicy, validateGenericReservedOptions } from '../publishing-generic-validation'
import { publishingCashContentProof, publishingCashFailure } from './publishing-cash-service'
import { publishingCashGenericContent } from '../publishing-cash-content'
import type { PublishingCashFunding } from '../publishing-cash-contract'

type DB = ReturnType<typeof getSupabase>
type Row = Record<string, unknown>
type Config = ReturnType<typeof readPublishingProviderConfiguration>
type Capability = Awaited<ReturnType<PublishingProvider['readCapabilities']>>[number]
type ProviderRecord = Awaited<ReturnType<PublishingProvider['readPublishRecord']>>
const row = (v: unknown): Row => !!v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {}
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : []
const str = (v: unknown) => typeof v === 'string' ? v : ''
const absent = new Set(['42P01', '42883', 'PGRST202', 'PGRST204', 'PGRST205'])
function fail(code: string, message: string, status = 409, unknown = false): never { throw new PublishingError(code, message, status, unknown) }
function dbError(error: unknown): never {
  if (error && typeof error === 'object' && 'message' in error && /PUBLISH_CASH_|VIDEO_BUDGET_CASH_RESERVED|WALLET_INSUFFICIENT/.test(String(error.message))) publishingCashFailure(error)
  const e = row(error)
  if (str(e.message).includes('PUBLISH_PROVIDER_BUSY')) fail('PUBLISH_PROVIDER_BUSY', '发布服务正忙，本次尚未领取额度或调用平台，请稍后继续原确认', 429)
  if (str(e.message).includes('PUBLISH_DISPATCH_EXPIRED')) fail('PUBLISH_DISPATCH_EXPIRED', '原发送许可已过期，请核对原记录，系统不会重新发送')
  if (str(e.message).includes('PUBLISH_OFFICIAL_IDENTITY_CONFLICT')) fail('PUBLISH_OFFICIAL_IDENTITY_CONFLICT', '该官方账号已归属其他会员，请管理员核对；系统不会转移历史归属')
  if (absent.has(str(e.code))) fail('NATIVE_OFFICIAL_SCHEMA_NOT_READY', '通用平台发布数据结构尚未部署；已接入的原发布通道仍可使用', 503)
  const codes: Record<string, string> = { PUBLISH_IDEMPOTENCY_CONFLICT: '此请求标识已经用于另一份内容，请读取原记录', PUBLISH_REVISION_CONFLICT: '内容或任务已有新版本，请刷新后重新确认', PUBLISH_NO_QUOTA: '所选平台的执行额度不足', NATIVE_QUOTA_ACCOUNTING_MISMATCH: '发布额度账目暂不可确认，请联系管理员核对', NATIVE_OFFICIAL_TASK_PENDING: '此任务已有待核对操作，请先读取原记录', NATIVE_OFFICIAL_BINDING_CHANGED: '账号连接或可用通道已变化，请重新检查', NATIVE_OFFICIAL_DRAFT_CHANGED: '稿件版本已变化，请重新检查', NATIVE_OFFICIAL_MEDIA_INVALID: '素材来源或上传确认与原文件不一致', NATIVE_OFFICIAL_TASK_STATE_INVALID: '此任务状态不支持所选操作', PUBLISH_EXECUTION_DISABLED: '管理员尚未开启所选平台的发布执行' }
  for (const [code, message] of Object.entries(codes)) if (str(e.message).includes(code)) fail(code, message)
  fail('NATIVE_OFFICIAL_RESULT_UNKNOWN', '操作结果尚未确认，请保留请求标识并读取原记录，勿重复提交', 503, true)
}
async function access(user: AuthUser) {
  const p = await readMemberPermissionSnapshot(user.id, { knownRole: user.role })
  if (p.authorityStatus !== 'ready' || !p.integrityValid || p.checksum === 'legacy-schema-absent') fail('PUBLISH_PERMISSION_UNAVAILABLE', '会员权限暂不可确认', 503)
  if (!p.featureNavigationKeys.includes('publish_center')) fail('PUBLISH_ACCESS_DENIED', '当前会员未开通发布中心', 403)
}
async function owned(db: DB, user: AuthUser, table: string, id: string) {
  const r = await db.from(table).select('*').eq('owner_id', user.id).eq('id', id).maybeSingle()
  if (r.error) dbError(r.error)
  if (!r.data) fail('NATIVE_OFFICIAL_RECORD_NOT_FOUND', '记录不存在或不属于当前会员', 404)
  return row(r.data)
}
async function rpc(db: DB, user: AuthUser, cfg: Config, input: Row) {
  const r = await db.rpc('mutate_native_official_atomic', { p_user_id: user.id, p_input: { ...input, namespace: cfg.namespace } } as never)
  if (r.error) dbError(r.error)
  return row(r.data)
}
async function request(db: DB, user: AuthUser, key: string, payload?: unknown) {
  const r = await db.from('pub5_requests').select('payload,result').eq('owner_id', user.id).eq('request_key', key).maybeSingle()
  if (r.error) dbError(r.error)
  if (r.data && payload !== undefined && publishingProviderPayloadHash(row(r.data).payload) !== publishingProviderPayloadHash(payload)) fail('PUBLISH_IDEMPOTENCY_CONFLICT', '请求标识已用于不同内容，请读取原记录')
  return r.data ? row(row(r.data).result) : null
}
async function configuration(db: DB) {
  const r = await db.from('pub_config_versions').select('version,execution_enabled,enabled_platforms').order('version', { ascending: false }).limit(1).maybeSingle()
  if (r.error) dbError(r.error)
  return row(r.data)
}
function configured(cfg: Config) { if (!cfg.configured || !cfg.apiKey) fail('PROVIDER_NOT_CONFIGURED', '官方发布服务尚未配置') }
async function execution(db: DB, cfg: Config, platforms: string[]) {
  configured(cfg)
  const c = await configuration(db)
  const allowed = cfg.environment === 'international' ? [...OVERSEAS_PUBLISHING_PLATFORMS] : Array.isArray(c.enabled_platforms) ? c.enabled_platforms as string[] : []
  if (!publishingRuntimeEnabled() || c.execution_enabled !== true || platforms.some(p => !allowed.includes(p))) fail('PUBLISH_EXECUTION_DISABLED', '管理员尚未开启所选平台的发布执行')
  return c
}
function provider(user: AuthUser, cfg: Config, op?: Row, consumeGrant?: (grant: PublishingProviderGrant) => Promise<boolean>) {
  configured(cfg)
  const snapshot = row(op?.snapshot), targets = rows(snapshot.targets), wire = row(snapshot.wireRequest)
  return new PublishingProvider({ environment: cfg.environment, apiKey: cfg.apiKey, scope: {
    ownerId: user.id, accountIds: new Set([...targets.map(t => str(t.providerAccountId)), str(snapshot.accountId)].filter(Boolean)),
    flowIds: new Set([str(wire.flowId)].filter(Boolean)), recordIds: new Set([str(snapshot.recordId)].filter(Boolean)),
    taskIds: new Set([str(snapshot.taskId)].filter(Boolean)), authSessionIds: new Set(),
  }, consumeGrant })
}
const configForNamespace = (namespace: string) => readPublishingProviderConfigurationForNamespace(namespace)
function capabilityHash(caps: Capability[], platforms: string[]) {
  const selected = [...new Set(platforms)].sort().map(platform => {
    const cap = caps.find(item => item.platform === platform)
    if (!cap || row(cap.capabilities.publish).supported !== true) fail('NATIVE_OFFICIAL_CAPABILITY_UNAVAILABLE', '当前官方能力未开放所选平台发布')
    return cap
  })
  return publishingProviderPayloadHash(selected)
}
function operationDto(o: Row, cfg: Config) {
  return PublishingGenericOperationSchema.parse({ id: o.id, kind: o.kind, requestKey: o.request_key, snapshotHash: o.snapshot_hash, revision: o.revision, state: o.state, grantUsed: o.grant_used, connectionCurrent: o.namespace === cfg.namespace, targetIds: o.target_ids, errorCode: o.error_code ?? null, createdAt: o.created_at, updatedAt: o.updated_at })
}
function targetDto(t: Row, op: Row, cfg: Config) {
  const current = op.namespace === cfg.namespace, editable = current && !!t.provider_task_id && t.state === 'queued'
  return PublishingGenericTargetSchema.parse({ id: t.id, operationId: t.operation_id, bindingId: t.binding_id, platform: t.platform, revision: t.revision, state: t.state, title: str(row(row(t.payload).profile).title), publishAt: t.publish_at, accountName: str(row(t.payload).accountName), connectionCurrent: current, workLink: t.work_link ?? null, errorCode: t.error_code ?? null, availableActions: [...(current ? ['refresh'] : []), ...(editable ? ['cancel', 'reschedule', 'publish_now'] : [])], createdAt: t.created_at, updatedAt: t.updated_at })
}
async function publicResult(db: DB, user: AuthUser, cfg: Config, result: Row) {
  const ids = Array.isArray(result.operationIds) ? result.operationIds.map(String) : []
  const operations = await Promise.all(ids.map(id => owned(db, user, 'pub5_operations', id)))
  const targets: ReturnType<typeof targetDto>[] = []
  const targetIds = [...new Set(operations.flatMap(o => Array.isArray(o.target_ids) ? o.target_ids.map(String) : []))]
  for (const id of targetIds) {
    const t = await owned(db, user, 'pub5_targets', id)
    const original = operations.find(o => o.id === t.operation_id) ?? await owned(db, user, 'pub5_operations', str(t.operation_id))
    targets.push(targetDto(t, original, cfg))
  }
  const snapshots = operations.filter(o => o.kind === 'publish').map(o => row(o.snapshot))
  const original = snapshots[0]
  const refs = original && snapshots.every(s => s.draftId === original.draftId && s.draftVersion === original.draftVersion && s.profileRevision === original.profileRevision)
    ? { draftId: original.draftId, draftVersion: original.draftVersion, profileRevision: original.profileRevision } : {}
  return PublishingGenericMutationSchema.parse({ ok: true, operations: operations.map(o => operationDto(o, cfg)), targets,
    ...refs, ...(result.draftId ? { draftId: result.draftId, draftVersion: result.draftVersion, profileRevision: result.profileRevision } : {}), alreadyFulfilled: result.alreadyFulfilled === true })
}
async function storedDraft(db: DB, user: AuthUser, draftId: string, version: number) {
  const d = await owned(db, user, 'pub5_studio_drafts', draftId)
  if (d.archived === true || d.revision !== version) fail('NATIVE_OFFICIAL_DRAFT_CHANGED', '稿件版本已变化，请重新读取')
  const r = await db.from('pub5_draft_profiles').select('*').eq('owner_id', user.id).eq('draft_id', draftId).eq('draft_version', version).maybeSingle()
  if (r.error) dbError(r.error)
  if (!r.data) fail('NATIVE_OFFICIAL_DRAFT_NOT_FOUND', '稿件版本不存在', 404)
  return { draft: PublishingStudioStoredDraftSchema.parse(row(r.data).payload), revision: Number(row(r.data).revision), record: d }
}
async function validateDraftSources(db: DB, user: AuthUser, cfg: Config, draft: PublishingStudioStoredDraft) {
  for (const entry of draft.sources) {
    const found = await readNativeMediaSource(db, user.id, entry.source, { configuration: () => cfg })
    const media = draft.media.find(m => m.id === entry.mediaId)!
    if (!found.connectionCurrent || found.mime !== media.type || found.size && found.size !== media.size || found.hash && found.hash !== media.hash) fail('NATIVE_OFFICIAL_MEDIA_INVALID', '素材归属或文件信息已变化')
  }
}
async function targetAssets(db: DB, user: AuthUser, cfg: Config, draft: PublishingStudioStoredDraft, target: PublishingTargetProfile) {
  const ids = [...new Set([...target.mediaIds, ...(target.coverMediaId ? [target.coverMediaId] : [])])]
  const result: Array<{ mediaId: string; asset: Row; source: unknown; bridgeId: string | null }> = []
  for (const mediaId of ids) {
    const media = draft.media.find(m => m.id === mediaId), source = draft.sources.find(m => m.mediaId === mediaId)?.source
    if (!media || !source) fail('NATIVE_OFFICIAL_MEDIA_INVALID', '目标引用了稿件之外的素材')
    let assetId: string, bridgeId: string | null = null
    if (source.kind === 'provider_asset') assetId = source.assetId
    else {
      await readNativeMediaSource(db, user.id, source, { configuration: () => cfg })
      const r = await db.from('pub_native_media_bridges').select('*').eq('owner_id', user.id).eq('namespace', cfg.namespace).eq('media_id', mediaId).eq('state', 'ready').maybeSingle()
      if (r.error) dbError(r.error)
      const b = row(r.data)
      if (!r.data || publishingProviderPayloadHash(b.reference) !== publishingProviderPayloadHash(source.reference) || row(row(b.snapshot).file).sha256 !== media.hash) fail('NATIVE_OFFICIAL_MEDIA_INVALID', '主站素材尚未完成原文件的官方上传映射')
      assetId = str(b.asset_id); bridgeId = str(b.id)
    }
    const asset = await owned(db, user, 'pub3_assets', assetId)
    if (asset.connection_id !== cfg.namespace || asset.state !== 'ready' || !asset.provider_asset_id || !asset.public_url || asset.sha256 !== media.hash || Number(asset.size) !== media.size || asset.mime !== media.type) fail('NATIVE_OFFICIAL_MEDIA_INVALID', '上传素材尚未确认或与原文件不一致')
    result.push({ mediaId, asset, source, bridgeId })
  }
  return result
}
async function prepare(db: DB, user: AuthUser, cfg: Config, action: Extract<PublishingGenericAction, { action: 'prepare' }>) {
  const prior = await request(db, user, action.requestKey, action)
  if (prior) return publicResult(db, user, cfg, prior)
  const { draft, revision } = await storedDraft(db, user, action.draftId, action.draftVersion)
  if (revision !== action.profileRevision || new Set(action.targetIds).size !== action.targetIds.length) fail('NATIVE_OFFICIAL_DRAFT_CHANGED', '稿件目标已变化')
  const selected = action.targetIds.map(id => draft.profile.targets.find(t => t.id === id))
  if (selected.some(t => !t || t.accountKind !== 'generic')) fail('NATIVE_OFFICIAL_INPUT_INVALID', '目标必须是当前稿件中已绑定的官方账号')
  const targets = selected as PublishingTargetProfile[]
  const current = await execution(db, cfg, targets.map(t => t.platform))
  const caps = await provider(user, cfg).readCapabilities(); capabilityHash(caps, targets.map(t => t.platform))
  const now = new Date().toISOString(), groups = new Map<string, PublishingTargetProfile[]>()
  for (const target of targets) {
    const at = target.publishAt ?? now
    if (target.publishAt && Date.parse(at) <= Date.now()) fail('NATIVE_OFFICIAL_SCHEDULE_EXPIRED', '目标排期已过，请重新设置')
    groups.set(at, [...(groups.get(at) ?? []), target])
  }
  const prepared: Row[] = []
  for (const [publishAt, grouped] of groups) {
    const operationId = randomUUID(), flowId = `native-official:${operationId}`
    const wire: PublishingProviderFlowInput = { flowId, publishAt, content: { media: [] }, items: [] }, snapshots: Row[] = []
    for (const target of grouped) {
      PublishingAuthorizationPlatformSchema.parse(target.platform)
      const binding = await owned(db, user, 'pub4_account_bindings', target.accountId)
      if (binding.connection_id !== cfg.namespace || binding.status !== 'active' || binding.revision !== target.accountRevision || binding.platform !== target.platform) fail('NATIVE_OFFICIAL_BINDING_CHANGED', '账号绑定或版本已变化')
      const cap = caps.find(c => c.platform === target.platform)!, assets = await targetAssets(db, user, cfg, draft, target)
      const metadata = assets.map(a => ({ ...draft.media.find(m => m.id === a.mediaId)!, ...row(a.asset.metadata) }))
      const effective = effectiveGenericPublishingContent(target.platform, target.title, target.body, target.topics, target.options)
      const errors = [...validateGenericPublishingContent(cap, draft.contentType, { ...target, ...effective }, metadata), ...validateGenericPublishingPolicy(target.platform, target.options)]
      if (draft.contentType === 'video' && ['KWAI', 'pinterest'].includes(target.platform) && !target.coverMediaId) errors.push('此平台视频发布必须有封面')
      const ownedUrls = new Set(assets.map(a => str(a.asset.public_url)))
      if (!validateGenericReservedOptions(target.options, str(binding.platform_uid), ownedUrls)) fail('NATIVE_OFFICIAL_OPTIONS_SCOPE_INVALID', '平台选项中的身份或素材地址不属于此次已确认目标')
      const url = (id: string) => ({ url: str(assets.find(a => a.mediaId === id)!.asset.public_url) })
      const options = { ...target.options, ...(target.platform === 'pinterest' && draft.contentType === 'video' && target.coverMediaId ? { coverImageUrl: url(target.coverMediaId).url } : {}), // 公众号只进草稿箱：无论界面选项如何，服务端强制草稿模式，群发由客户在公众号后台完成
        ...(target.platform === 'wxGzh' ? { draftOnly: true, massSend: false } : {}) }
      if (errors.length || !validatePublishingProviderOptions(cap.optionSchema, options)) fail('NATIVE_OFFICIAL_OPTIONS_INVALID', `${target.platform}：${errors.join('；') || '发布参数未通过当前平台规则校验'}`)
      const content = { ...(Number(row(cap.contentLimits).maxTitleLength) === 0 ? {} : { title: effective.title }), body: effective.body, media: target.mediaIds.map(url), ...(target.coverMediaId ? { cover: url(target.coverMediaId) } : {}) }
      if (!wire.items.length) wire.content = content
      wire.items.push({ platform: target.platform, accountId: str(binding.provider_account_id), option: options, overrides: content })
      snapshots.push({ id: randomUUID(), profileTargetId: target.id, bindingId: target.accountId, bindingRevision: target.accountRevision, platform: target.platform, providerAccountId: binding.provider_account_id, accountName: binding.display_name, profile: target, media: assets.map(a => ({ mediaId: a.mediaId, assetId: a.asset.id, source: a.source, bridgeId: a.bridgeId, mediaEntryId: draft.sources.find(m => m.mediaId === a.mediaId)?.mediaEntryId ?? null })) })
    }
    const snapshot = { version: 1, kind: 'publish', namespace: cfg.namespace, draftId: action.draftId, draftVersion: action.draftVersion, draftPayload: draft, profileRevision: revision, profilePayload: draft.profile, configVersion: current.version, capabilitiesHash: capabilityHash(caps, grouped.map(t => t.platform)), expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), targets: snapshots, wireRequest: wire }
    prepared.push({ id: operationId, requestKey: `${action.requestKey.slice(0, 85)}:${publishingProviderPayloadHash({ publishAt, targets: grouped.map(t => t.id) }).slice(0, 64)}`, snapshot, snapshotHash: publishingProviderPayloadHash(snapshot), providerRequestHash: publishingProviderPayloadHash(wire) })
  }
  return publicResult(db, user, cfg, await rpc(db, user, cfg, { action: 'prepare', requestKey: action.requestKey, request: action, groups: prepared }))
}
async function currentCapabilities(db: DB, user: AuthUser, cfg: Config, op: Row) {
  const wire = op.kind === 'publish' ? row(op.snapshot).wireRequest : { taskId: row(op.snapshot).taskId, action: row(op.snapshot).change, publishAt: row(op.snapshot).publishAt ?? null }
  if (publishingProviderPayloadHash(op.snapshot) !== op.snapshot_hash || publishingProviderPayloadHash(wire) !== op.provider_request_hash) fail('NATIVE_OFFICIAL_SNAPSHOT_INVALID', '原冻结内容或实际请求摘要不一致，已停止执行')
  const snapshot = row(op.snapshot), platforms = op.kind === 'publish' ? rows(snapshot.targets).map(t => str(t.platform)) : [str(snapshot.platform)]
  await execution(db, cfg, platforms)
  const caps = await provider(user, cfg).readCapabilities()
  if (capabilityHash(caps, platforms) !== snapshot.capabilitiesHash) fail('NATIVE_OFFICIAL_CAPABILITIES_CHANGED', '平台规则已变化，请保留原操作并重新核对')
  for (const target of rows(snapshot.targets)) { const profile = row(target.profile); if (validateGenericPublishingPolicy(str(target.platform), row(profile.options)).length) fail('NATIVE_OFFICIAL_OPTIONS_INVALID', '原计划包含当前无法兑现的隐私、身份或发布选项') }
}
async function targetRevisions(db: DB, user: AuthUser, op: Row) {
  return new Map(await Promise.all((op.target_ids as string[]).map(async id => [id, Number((await owned(db, user, 'pub5_targets', id)).revision)] as const)))
}
async function recordResult(db: DB, user: AuthUser, cfg: Config, op: Row, observed: ProviderRecord[], revisions: ReadonlyMap<string, number>) {
  const targets = await Promise.all((op.target_ids as string[]).map(id => owned(db, user, 'pub5_targets', id)))
  if (observed.length !== targets.length || new Set(observed.map(r => r.id)).size !== observed.length || new Set(observed.map(r => r.accountId)).size !== observed.length) fail('NATIVE_OFFICIAL_RESULT_INVALID', '官方回执与目标集合不一致', 409, true)
  const results = targets.map(target => {
    const found = observed.find(r => r.accountId === row(target.payload).providerAccountId && (r.platform ?? r.accountType) === target.platform)
    if (!found) fail('NATIVE_OFFICIAL_RESULT_INVALID', '官方回执账号与原目标不一致', 409, true)
    const projected = projectProviderStatus(found.status)
    let state = projected === 'published' ? 'published' : projected === 'failed' || projected === 'update_failed' ? 'failed_known' : projected === 'cancelled' ? 'cancelled' : ['waiting', 'queued', 'platform_scheduled'].includes(projected) ? 'queued' : ['publishing', 'updating'].includes(projected) ? 'publishing' : 'unknown'
    if (state === 'published' && (!found.platformWorkId || !found.workLink)) state = 'unknown'
    const date = found.publishTime && Number.isFinite(Date.parse(found.publishTime)) ? new Date(found.publishTime).toISOString() : str(target.publish_at)
    return { targetId: target.id, expectedRevision: revisions.get(str(target.id)), accountId: found.accountId, platform: target.platform, recordId: found.id, taskId: found.id, state, workId: found.platformWorkId ?? null, workLink: found.workLink ?? null, publishAt: date, errorCode: found.errorData?.code ?? null }
  })
  return rpc(db, user, cfg, { action: 'record-result', operationId: op.id, dispatchId: op.dispatch_id, expectedRevision: op.revision, results })
}
async function observe(user: AuthUser, cfg: Config, db: DB, op: Row): Promise<ProviderRecord[]> {
  const s = row(op.snapshot)
  if (op.kind === 'publish') return (await provider(user, cfg, op).readPublishFlow(str(row(s.wireRequest).flowId))).tasks
  const target = await owned(db, user, 'pub5_targets', str(s.targetId))
  if (target.provider_record_id !== s.recordId || row(target.payload).providerAccountId !== s.accountId) fail('NATIVE_OFFICIAL_TASK_STATE_INVALID', '原任务映射已变化')
  return [await provider(user, cfg, op).readPublishRecord(str(s.recordId))]
}
async function execute(db: DB, user: AuthUser, cfg: Config, op: Row, expectedRevision: number, snapshotHash: string, funding?: PublishingCashFunding) {
  if (op.namespace !== cfg.namespace) fail('NATIVE_OFFICIAL_CONNECTION_CHANGED', '此操作属于原服务连接，请核对原记录')
  await currentCapabilities(db, user, cfg, op)
  const cashContents: Record<string, string> = {}
  if (funding && op.kind === 'publish' && op.state === 'prepared') {
    const snapshot = row(op.snapshot), draft = PublishingStudioStoredDraftSchema.parse(snapshot.draftPayload)
    for (const target of rows(snapshot.targets)) {
      const profile = draft.profile.targets.find(t => t.id === target.profileTargetId)
      if (!profile) fail('PUBLISH_CASH_CONTENT_MISMATCH', '原发布目标与费用确认不一致')
      cashContents[str(target.id)] = await publishingCashContentProof(funding, profile.accountId, 'generic', publishingCashGenericContent(draft, profile))
    }
  }
  const claimed = await rpc(db, user, cfg, { action: 'claim', operationId: op.id, expectedRevision, snapshotHash, dispatchId: randomUUID(), ...(funding ? { funding, cashContents } : {}) })
  if (claimed.shouldDispatch !== true) return publicResult(db, user, cfg, claimed)
  op = await owned(db, user, 'pub5_operations', str(op.id))
  const operationId = str(op.id)
  const p = provider(user, cfg, op, async grant => {
    if (grant.ownerId !== user.id || grant.operationId !== op.id || grant.kind !== op.grant_kind || grant.subject !== op.grant_subject || grant.payloadHash !== op.provider_request_hash) return false
    await currentCapabilities(db, user, cfg, op)
    const result = await rpc(db, user, cfg, { action: 'consume-grant', operationId: op.id, dispatchId: op.dispatch_id, grantKind: grant.kind, grantSubject: grant.subject, providerRequestHash: grant.payloadHash })
    op = await owned(db, user, 'pub5_operations', operationId)
    return result.consumed === true
  })
  try {
    const revisions = await targetRevisions(db, user, op)
    if (op.kind === 'publish') {
      const result = await p.createPublishFlow(row(op.snapshot).wireRequest as PublishingProviderFlowInput, operationId)
      return publicResult(db, user, cfg, await recordResult(db, user, cfg, op, result.tasks, revisions))
    }
    const s = row(op.snapshot)
    await p.changeTask(str(s.taskId), s.change as 'cancel' | 'reschedule' | 'publish-now', operationId, typeof s.publishAt === 'string' ? s.publishAt : undefined)
    // A task-change ACK is not completion. Only the original owned record can settle it.
    return publicResult(db, user, cfg, await recordResult(db, user, cfg, op, await observe(user, cfg, db, op), revisions))
  } catch (error) {
    op = await owned(db, user, 'pub5_operations', operationId)
    const result = await rpc(db, user, cfg, { action: op.grant_used === true ? 'record-unknown' : 'block-unissued', operationId, dispatchId: op.dispatch_id, expectedRevision: op.revision, errorCode: error instanceof PublishingProviderError ? error.code : error instanceof PublishingError ? error.code : 'NATIVE_OFFICIAL_RESULT_UNKNOWN' })
    return publicResult(db, user, cfg, result)
  }
}

export async function mutatePublishingGeneric(user: AuthUser, db: DB, action: PublishingGenericAction) {
  await access(user)
  let cfg = readPublishingProviderConfiguration()
  if (action.action === 'save-draft') {
    const prior = await request(db, user, action.requestKey, action)
    if (prior) return publicResult(db, user, cfg, prior)
    await validateDraftSources(db, user, cfg, action.draft)
    PublishingDraftProfileSchema.parse(action.draft.profile)
    return publicResult(db, user, cfg, await rpc(db, user, cfg, { action: 'save-draft', requestKey: action.requestKey, request: action, draftId: action.id ?? randomUUID(), expectedRevision: action.expectedRevision, draft: action.draft }))
  }
  if (action.action === 'prepare') {
    const saved = await storedDraft(db, user, action.draftId, action.draftVersion)
    const bindings = await Promise.all(action.targetIds.map(id => {
      const target = saved.draft.profile.targets.find(item => item.id === id)
      return target ? owned(db, user, 'pub4_account_bindings', target.accountId) : null
    }))
    const namespaces = new Set(bindings.filter(Boolean).map(binding => str(binding!.connection_id)))
    if (namespaces.size > 1) fail('NATIVE_OFFICIAL_BINDING_CHANGED', '一次发布不能混用国内与国际账号，请分开提交')
    const namespace = [...namespaces][0]
    if (namespace) cfg = configForNamespace(namespace)
    return prepare(db, user, cfg, action)
  }
  if (action.action === 'execute') {
    const op = await owned(db, user, 'pub5_operations', action.operationId)
    cfg = configForNamespace(str(op.namespace))
    if (op.request_key !== action.requestKey) fail('PUBLISH_IDEMPOTENCY_CONFLICT', '执行请求标识与原操作不一致')
    return execute(db, user, cfg, op, action.expectedRevision, action.snapshotHash, action.funding)
  }
  if (action.action === 'reconcile') {
    const op = await owned(db, user, 'pub5_operations', action.operationId)
    cfg = configForNamespace(str(op.namespace))
    if (op.revision !== action.expectedRevision) fail('NATIVE_OFFICIAL_OPERATION_CHANGED', '操作版本或服务连接已变化')
    if (op.grant_used !== true) return publicResult(db, user, cfg, await rpc(db, user, cfg, { action: 'block-unissued', operationId: op.id, dispatchId: op.dispatch_id, expectedRevision: op.revision, errorCode: 'NATIVE_OFFICIAL_RECOVERED_UNISSUED' }))
    const revisions = await targetRevisions(db, user, op)
    return publicResult(db, user, cfg, await recordResult(db, user, cfg, op, await observe(user, cfg, db, op), revisions))
  }
  const prior = await request(db, user, action.requestKey, action)
  if (prior) {
    const id = Array.isArray(prior.operationIds) ? str(prior.operationIds[0]) : ''
    const op = await owned(db, user, 'pub5_operations', id)
    cfg = configForNamespace(str(op.namespace))
    return op.state === 'prepared' ? execute(db, user, cfg, op, Number(op.revision), str(op.snapshot_hash)) : publicResult(db, user, cfg, prior)
  }
  const target = await owned(db, user, 'pub5_targets', action.targetId), parent = await owned(db, user, 'pub5_operations', str(target.operation_id))
  cfg = configForNamespace(str(parent.namespace))
  if (target.revision !== action.expectedRevision || target.state !== 'queued' || !target.provider_task_id || !target.provider_record_id) fail('NATIVE_OFFICIAL_TASK_STATE_INVALID', '原任务版本或状态不支持此操作')
  await execution(db, cfg, [str(target.platform)])
  const caps = await provider(user, cfg).readCapabilities(), hash = capabilityHash(caps, [str(target.platform)])
  const change = action.change === 'publish_now' ? 'publish-now' : action.change
  const snapshot = { targetId: target.id, targetRevision: target.revision, taskId: target.provider_task_id, recordId: target.provider_record_id, accountId: row(target.payload).providerAccountId, platform: target.platform, change, publishAt: action.publishAt ?? null, capabilitiesHash: hash }
  const prepared = await rpc(db, user, cfg, { action: 'prepare-change', requestKey: action.requestKey, request: action, operationId: randomUUID(), targetId: target.id, expectedRevision: target.revision, snapshot, snapshotHash: publishingProviderPayloadHash(snapshot), providerRequestHash: publishingProviderPayloadHash({ taskId: snapshot.taskId, action: change, publishAt: action.publishAt ?? null }) })
  const op = await owned(db, user, 'pub5_operations', String((prepared.operationIds as string[])[0]))
  return execute(db, user, cfg, op, Number(op.revision), str(op.snapshot_hash))
}

export async function readPublishingGenericStatus(db: DB) {
  const r = await db.from('pub5_operations').select('id').limit(0)
  if (r.error && !absent.has(str(row(r.error).code))) dbError(r.error)
  return { schemaReady: !r.error, issue: r.error ? 'NATIVE_OFFICIAL_SCHEMA_NOT_READY' : null }
}
export async function readPublishingGeneric(user: AuthUser, db: DB, query: PublishingGenericQuery) {
  await access(user)
  let cfg = readPublishingProviderConfiguration()
  if (query.resource === 'status') return { ...await readPublishingGenericStatus(db), configured: cfg.configured, executionEnabled: publishingRuntimeEnabled() }
  if (query.resource === 'operation') {
    if (query.requestKey) {
      const result = await request(db, user, query.requestKey)
      if (!result) return null
      const id = Array.isArray(result.operationIds) ? str(result.operationIds[0]) : ''
      const op = await owned(db, user, 'pub5_operations', id)
      cfg = configForNamespace(str(op.namespace))
      return publicResult(db, user, cfg, result)
    }
    const id = query.id
    if (!id) fail('NATIVE_OFFICIAL_INPUT_INVALID', '缺少发布操作标识')
    const op = await owned(db, user, 'pub5_operations', id)
    cfg = configForNamespace(str(op.namespace))
    return publicResult(db, user, cfg, { operationIds: [id], alreadyFulfilled: true })
  }
  if (query.resource === 'profile') {
    const result = await storedDraft(db, user, query.draftId, query.draftVersion)
    return { id: query.draftId, revision: query.draftVersion, profileRevision: result.revision, payload: result.draft, createdAt: result.record.created_at, updatedAt: result.record.updated_at }
  }
  if (query.resource === 'drafts') {
    const r = await db.from('pub5_studio_drafts').select('*', { count: 'exact' }).eq('owner_id', user.id).eq('archived', false).order('updated_at', { ascending: false }).range((query.page - 1) * query.pageSize, query.page * query.pageSize - 1)
    if (r.error) dbError(r.error)
    const items = await Promise.all(rows(r.data).map(async d => { const found = await storedDraft(db, user, str(d.id), Number(d.revision)); return { id: d.id, revision: d.revision, title: found.draft.title, contentType: found.draft.contentType, updatedAt: d.updated_at } }))
    return { items, total: r.count ?? 0, page: query.page, pageSize: query.pageSize }
  }
  if (query.resource === 'record') {
    const target = await owned(db, user, 'pub5_targets', query.id), op = await owned(db, user, 'pub5_operations', str(target.operation_id))
    cfg = configForNamespace(str(op.namespace))
    // GET returns durable state. Persisting a provider observation is explicit reconcile POST.
    return targetDto(target, op, cfg)
  }
  if (query.resource === 'options') {
    const binding = await owned(db, user, 'pub4_account_bindings', query.bindingId)
    cfg = configForNamespace(str(binding.connection_id))
    if (binding.status !== 'active') fail('NATIVE_OFFICIAL_BINDING_CHANGED', '账号连接已变化')
    const p = provider(user, cfg, { snapshot: { accountId: binding.provider_account_id } })
    return query.option ? p.readPublishOptionValues(str(binding.provider_account_id), query.option, query.query ? { query: query.query } : {}) : p.readPublishOptions(str(binding.platform))
  }
  let q = db.from('pub5_targets').select('*', { count: 'exact' }).eq('owner_id', user.id)
  if (query.platform) q = q.eq('platform', query.platform)
  if (query.from) q = q.gte('publish_at', query.from)
  if (query.to) q = q.lt('publish_at', query.to)
  const r = await q.order('publish_at', { ascending: false }).order('id', { ascending: false }).range((query.page - 1) * query.pageSize, query.page * query.pageSize - 1)
  if (r.error) dbError(r.error)
  const items = await Promise.all(rows(r.data).map(async t => { const op = await owned(db, user, 'pub5_operations', str(t.operation_id)); return targetDto(t, op, configForNamespace(str(op.namespace))) }))
  return { items, total: r.count ?? 0, page: query.page, pageSize: query.pageSize }
}
