'use client'
import { useEffect, useState } from 'react'
import type { PromotionMaterial } from '@/api/materials/material.types'
import PublishDialog from '@/components/PublishDialog'
import { buildPublishParamsFromDraft } from '@/components/PublishDialog/PublishDialog.util'
import { usePublishDialog } from '@/components/PublishDialog/usePublishDialog'
import { usePublishDialogStorageStore } from '@/components/PublishDialog/usePublishDialogStorageStore'
import { Button } from '@/components/ui/button'
import { useAccountStore } from '@/store/account'
import http from '@/utils/request'
import { assertHostSession, getHostSessionRevision } from './host-session'
import type { NativeAiActionDto } from './native-ai-client'

/** Opens the existing user confirmation window. It never triggers publishing. */
export function NativeAiPublishHandoff({ action }: { action: NativeAiActionDto }) {
  const [draft, setDraft] = useState<PromotionMaterial | null>(null), [open, setOpen] = useState(false), [issue, setIssue] = useState(''), [loading, setLoading] = useState(false)
  const accounts = useAccountStore(state => state.accountList)
  const selected = usePublishDialog(state => state.pubListChoosed)
  const browser = Array.isArray(action.args.browserAccountIds) ? action.args.browserAccountIds as string[] : []
  const official = Array.isArray(action.args.officialBindingIds) ? action.args.officialBindingIds as string[] : []
  const enter = async () => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); setLoading(true); setIssue('')
    try {
      const response = await http.get<PromotionMaterial>(`material/info/${String(action.args.draftId)}`); assertHostSession(owner, epoch)
      if (response.data.id !== action.args.draftId || response.data.nativeRevision !== action.args.expectedRevision || response.data.nativeMetadataRevision !== action.args.expectedMetadataRevision) throw new Error('草稿或素材设置已有变化，请重新核对后准备发布确认')
      usePublishDialogStorageStore.getState().clearPubData(); setDraft(response.data); setOpen(true)
    } catch (error) { try { assertHostSession(owner, epoch); setIssue(error instanceof Error ? error.message : '待发布草稿暂不可读取') } catch {} }
    finally { try { assertHostSession(owner, epoch); setLoading(false) } catch {} }
  }
  useEffect(() => {
    if (!open || !draft || !selected.length) return
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); let active = true
    usePublishDialog.getState().setPrefillLoading(true)
    void buildPublishParamsFromDraft(draft).then(value => { assertHostSession(owner, epoch); if (active) usePublishDialog.getState().setAccountAllParams(value) }).catch(error => { if (active) setIssue(error instanceof Error ? error.message : '发布素材尚未就绪') }).finally(() => { if (active) { try { assertHostSession(owner, epoch); usePublishDialog.getState().setPrefillLoading(false) } catch {} } })
    return () => { active = false }
  }, [open, draft, selected.length])
  return <div className="space-y-2 text-xs"><p className="text-muted-foreground">内容已整理为待发布确认；当前尚未发布，也没有消耗发布额度。</p><Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => { void enter() }}>进入原发布窗口核对</Button>{issue && <p role="status" className="text-destructive">{issue}</p>}{draft && <PublishDialog open={open} onClose={() => setOpen(false)} accounts={accounts} defaultAccountIds={[...browser, ...official]} suppressAutoPublish autoPublishOnReady={false} materialGroupIdForPublish={draft.groupId || undefined} materialIdForPublish={draft.id} materialVersionForPublish={draft.nativeRevision} onPubSuccess={() => setOpen(false)} />}</div>
}
