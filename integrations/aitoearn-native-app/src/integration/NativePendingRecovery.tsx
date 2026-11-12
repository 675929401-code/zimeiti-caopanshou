'use client'
import { useEffect, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { toast } from '@/utils/ui/toast'
import { readNativePending, recoverNativePublish, subscribeNativePending, type NativePendingPublish } from './native-publishing'
import { assertHostSession, getHostSessionRevision } from './host-session'
export function NativePendingRecovery() {
  const [pending, setPending] = useState<NativePendingPublish | null>(null); const [invalid, setInvalid] = useState(false); const [busy, setBusy] = useState(false)
  useEffect(() => { const update = () => { try { setPending(readNativePending()); setInvalid(false) } catch { setInvalid(true) } }; update(); return subscribeNativePending(update) }, [])
  if (!pending && !invalid) return null
  return <Alert className="fixed bottom-24 right-6 z-[60] w-[390px] border-warning/40 bg-card shadow-xl"><AlertCircle className="h-4 w-4 text-warning" /><AlertTitle>原{pending?.kind === 'prepare' ? '发布准备' : '提交'}需要核对</AlertTitle><AlertDescription className="space-y-3"><p>保留原请求与原任务，只读取状态或同步已保存报告，不会重新发布。</p>{invalid ? <p>标记格式待核对，请保留浏览器数据并联系管理员。</p> : <Button size="sm" variant="outline" disabled={busy} onClick={async () => { const owner = assertHostSession().user.id; const revision = getHostSessionRevision(); setBusy(true); try { await recoverNativePublish(); assertHostSession(owner, revision); toast.success('原记录已核对；未重新提交发布') } catch (reason) { if (revision === getHostSessionRevision()) toast.warning(reason instanceof Error ? reason.message : '原任务仍待核对') } finally { if (revision === getHostSessionRevision()) setBusy(false) } }}>{busy && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}只核对原任务</Button>}</AlertDescription></Alert>
}
