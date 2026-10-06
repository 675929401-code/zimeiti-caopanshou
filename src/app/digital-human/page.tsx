'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
const RechargeDialog = dynamic(() => import('@/components/recharge-dialog').then(module => module.RechargeDialog), { ssr: false });
import { SubPageHeader } from '@/components/sub-page-header';
import { useApp } from '@/contexts/app-context';
import { resolveWorkbenchIdentity } from '@/lib/workbench-user-storage';
import { humanJobPending, humanQuote, humanUnitPrice, humanBillingSeconds, readHumanJobs, saveHumanJob, type HumanAsset, type HumanJob, type HumanMode } from '@/features/digital-human/client-state';
import { humanDurationRange, planHumanDuration, shouldSegmentHumanVideo, type HumanDurationChoice } from '@/features/digital-human/duration-policy';
import styles from './workspace.module.css';
import { ImitationComposer } from '@/features/digital-human/ImitationComposer';
import { SpeechComposer } from '@/features/digital-human/SpeechComposer';
import { CommerceAudioAssetPicker } from '@/features/digital-human/CommerceAudioAssetPicker';
import { ImagePlus, AudioLines, Clapperboard, WalletCards, History, Sparkles } from 'lucide-react';

type Model = { id: string; displayName: string; publicPrice: number; capabilities: Record<string, unknown> & { available?: boolean; availabilityMessage?: string; generationReady?: boolean; readinessMessage?: string; requiresSourceVideo?: boolean } };
type Draft = { mode: HumanMode; modelId: string; resolution: string; personId: string; audioId: string; audioSource: 'upload' | 'speech' | 'imitation' };
type UploadSlot = 'person' | 'audio';
type ActiveUpload = { controller: AbortController; xhr: XMLHttpRequest | null; requestId: string; ticketId?: string };
type UploadProgress = { slot: UploadSlot; percent: number; message: string };
type UploadTicketResponse = {
  error?: unknown;
  mode?: 'direct' | 'proxy' | 'completed';
  asset?: HumanAsset;
  uploadUrl?: string;
  ticketId?: string;
  upload?: { url?: string; headers?: Record<string, string> };
  completeUrl?: string;
};
type UploadCompletionResponse = { error?: unknown; code?: string; asset?: HumanAsset };
const defaultDraft: Draft = { mode: 'video', modelId: '', resolution: '', personId: '', audioId: '', audioSource: 'speech' };
const labels: Record<string, string> = { submitting: '正在提交', pending: '排队中', queued: '排队中', processing: '生成中', generating: '生成中', confirming: '正在确认原任务', merging: '正在合并完整视频', billing_pending: '正在完成结算', finalizing: '正在保存成品', unknown: '等待确认原任务', completed: '已完成', failed: '生成未完成', cancelled: '已取消' };
const isLongJob = (job: HumanJob) => job.requestId.startsWith('digital-long-') || job.taskId.startsWith('dhl_') || job.businessId.startsWith('dhl_');
const INITIAL_HISTORY_ITEMS = 6;
const sortHumanJobs = (items: HumanJob[]) => [...items].sort((left, right) =>
  (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0)
  || (right.businessId || right.taskId || right.requestId).localeCompare(left.businessId || left.taskId || left.requestId));

function customerHumanMessage(value: unknown, fallback = '数字人服务暂时无法完成本次请求，请稍后重试') {
  const detail = typeof value === 'string' ? value.trim() : '';
  if (/余额不足|积分不足|现金余额不足/u.test(detail)) return '当前余额不足，请充值后重试。';
  if (/文件|素材|图片|视频|音频/u.test(detail) && /大小|格式|无效|读取|上传|缺少/u.test(detail)) return detail || '素材未通过检查，请重新选择后重试。';
  if (/API|HTTP|provider|供应商|上游|渠道|密钥|后台|数据库|迁移|作业键|预占|终态|落库/iu.test(detail)) return fallback;
  return detail || fallback;
}

function HistoryVideo({ url, label }: { url: string; label: string }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return <button type="button" className={styles.videoPlaceholder} onClick={() => setRevealed(true)} aria-label={`加载并播放${label}`}>
      <span>▶</span><strong>播放视频预览</strong><small>点击后才加载视频，节省首屏流量</small>
    </button>;
  }
  return <video src={url} aria-label={label} controls autoPlay preload="metadata" />;
}

function waitFor(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Upload aborted', 'AbortError')); return; }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { window.clearTimeout(timer); reject(new DOMException('Upload aborted', 'AbortError')); }, { once: true });
  });
}

async function filePrefixBase64(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function xhrUpload(input: {
  url: string;
  method: 'PUT' | 'POST';
  body: File | FormData;
  headers: Record<string, string>;
  active: ActiveUpload;
  onProgress: (percent: number) => void;
}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    input.active.xhr = xhr;
    xhr.open(input.method, input.url, true);
    Object.entries(input.headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) input.onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
    };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      if (xhr.responseText) { try { body = JSON.parse(xhr.responseText) as Record<string, unknown>; } catch {} }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error('上传连接中断，请检查网络后重试'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    xhr.ontimeout = () => reject(new Error('上传等待超时，请重试'));
    xhr.timeout = 15 * 60_000;
    xhr.send(input.body);
  });
}

export default function DigitalHumanPage() {
  const { state } = useApp();
  const pathname = usePathname();
  const backHref = pathname.startsWith('/commerce/') ? '/commerce' : '/';
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <main className={styles.page}><SubPageHeader title="AI 数字人" subtitle="让视频说出新台词，让照片开口说话" backHref={backHref} /><div className={styles.scrollArea} tabIndex={0} aria-label="数字人工作区"><div className={styles.layout}><p>请登录后开始创作。</p><Link href={backHref}>{backHref==='/commerce'?'返回带货 Agent':'返回主页登录'}</Link></div></div></main>;
  return <Workspace key={identity.userId} userId={identity.userId} token={state.auth.token!} backHref={backHref} />;
}

function Workspace({ userId, token, backHref }: { userId: string; token: string; backHref: string }) {
  const { dispatch } = useApp();
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const draftKey = `digital-human:draft:v1:${userId}`;
  const [draft, setDraft] = useState<Draft>(defaultDraft);
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [person, setPerson] = useState<HumanAsset | null>(null);
  const [audio, setAudio] = useState<HumanAsset | null>(null);
  const [durationChoice, setDurationChoice] = useState<HumanDurationChoice>('');
  const [jobs, setJobs] = useState<HumanJob[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [uploading, setUploading] = useState('');
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState('');
  const [speechReady, setSpeechReady] = useState(false);
  const [speechPending, setSpeechPending] = useState(false);
  const [commerceAudioPending, setCommerceAudioPending] = useState(false);
  const [imitationReady,setImitationReady]=useState(false),[imitationPending,setImitationPending]=useState(false);
  const acceptSpeech = useCallback((asset: HumanAsset) => { setAudio(asset); setDraft(current => ({ ...current, audioId: asset.id })); setDurationChoice(''); }, []);
  const [storageError, setStorageError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(INITIAL_HISTORY_ITEMS);
  const [removing, setRemoving] = useState('');
  const [restoring, setRestoring] = useState('');
  const [restoreNotice, setRestoreNotice] = useState('');
  const locked = useRef(false), alive = useRef(true), jobsRef = useRef(jobs), activeUpload = useRef<ActiveUpload | null>(null), editorRef = useRef<HTMLElement | null>(null);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  const headers = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const modelsForMode = useCallback((mode: HumanMode) => models.filter(model => (model.capabilities.requiresSourceVideo === true) === (mode === 'video')), [models]);
  const availableModelsForMode = useCallback((mode: HumanMode) => modelsForMode(mode).filter(model => model.capabilities.available === true && model.capabilities.generationReady !== false), [modelsForMode]);
  const modeModels = modelsForMode(draft.mode);
  const availableModeModels = availableModelsForMode(draft.mode);
  const selected = availableModeModels.find(model => model.id === draft.modelId);
  const pending = jobs.some(humanJobPending);
  const lastPendingIndex = jobs.reduce((last, job, index) => humanJobPending(job) ? index : last, -1);
  const renderedHistoryCount = Math.max(historyVisible, lastPendingIndex + 1);
  const visibleJobs = jobs.slice(0, renderedHistoryCount);
  const needsDurationChoice = draft.mode === 'video' && !!person && !!audio && audio.duration > person.duration + 0.1;
  const longCandidate = shouldSegmentHumanVideo(selected?.capabilities, draft.mode, Number(audio?.duration));
  const effectiveDurationChoice: HumanDurationChoice = longCandidate && !needsDurationChoice ? 'preserve_audio' : durationChoice;
  const longRequested = longCandidate && effectiveDurationChoice === 'preserve_audio';
  const durationPlan = selected && person && audio ? planHumanDuration(selected.capabilities, draft.mode, person.duration, audio.duration, effectiveDurationChoice, audio.size) : null;
  const seconds = longRequested ? Number(audio?.duration || 0) : durationPlan?.seconds || 0;
  const billableSeconds = longRequested ? seconds : humanBillingSeconds(selected, seconds);
  const unitPrice = humanUnitPrice(selected, draft.resolution);
  const quotedUnitPrice = longRequested ? humanUnitPrice(selected, '720p') : unitPrice;
  const unitLabel = selected?.capabilities.billingUnit === 'output_second' ? '秒' : '次';
  const longQuote = Math.round((quotedUnitPrice * seconds + Number.EPSILON) * 100) / 100;
  const price = longRequested ? longQuote : humanQuote(selected, draft.resolution, seconds);
  const durationError = longCandidate
    ? longRequested ? '' : '配音超过 115 秒，请选择“保留完整配音”，系统会自动分段生成并合并。'
    : durationPlan?.error || '';
  const resolutions = (selected?.capabilities.resolutionOptions as string[] | undefined) || [];
  const updateJob = useCallback((job: HumanJob) => {
    try { saveHumanJob(localStorage, userId, job); } catch { setStorageError('任务追踪暂时无法保存，请保留当前页面'); }
    setJobs(current => sortHumanJobs([job, ...current.filter(item => item.requestId !== job.requestId && (!job.businessId || item.businessId !== job.businessId))]));
  }, [userId]);
  const refreshBalance = useCallback(async () => {
    const response = await fetch('/api/cash/balance', { headers: headers(), cache: 'no-store' });
    const data = await response.json(); if (response.ok && alive.current) { setBalance(Number(data.balance)); dispatch({ type: 'SET_CASH_BALANCE', payload: Number(data.balance) }); }
  }, [headers, dispatch]);
  const loadHistory = useCallback(async (offset = 0) => {
    setHistoryBusy(true);
    try {
      const [response, longResponse] = await Promise.all([
        fetch(`/api/video/history?surface=digital-human&limit=20&offset=${offset}`, { headers: headers(), cache: 'no-store' }),
        fetch(`/api/digital-human/long-history?limit=20&offset=${offset}`, { headers: headers(), cache: 'no-store' }),
      ]);
      const data = await response.json(); if (!response.ok) throw new Error(customerHumanMessage(data.error, '历史暂时无法读取'));
      const longPayload = await longResponse.json();
      const longData = longResponse.ok ? longPayload : { tasks: [], nextOffset: null };
      if (!longResponse.ok && alive.current) setError(customerHumanMessage(longPayload.error, '长视频历史暂时无法读取'));
      if (!alive.current) return;
      const ordinaryHistory: HumanJob[] = data.tasks.map((row: Record<string, unknown>) => ({
        requestId: String(row.clientRequestId || row.id), businessId: String(row.id), taskId: String(row.taskIdExternal || row.id),
        modelId: String(row.publicModelId), modelName: String(row.modelName), mode: String(row.taskLabel).includes(':video') ? 'video' : 'photo',
        status: String(row.status), error: String(row.errorMessage || ''), createdAt: String(row.createdAt), resolution: String(row.resolution),
        duration: Number(row.durationSeconds), price: Number(row.priceCharged), videoUrl: String(row.videoUrl || ''), canRetry: Boolean(row.canRetry),
        retrySource: row.retrySource as HumanJob['retrySource'],
      }));
      const longHistory: HumanJob[] = (Array.isArray(longData.tasks) ? longData.tasks : []).map((row: Record<string, unknown>) => ({
        requestId: String(row.clientRequestId || row.id), businessId: String(row.id), taskId: String(row.id),
        modelId: String(row.modelId), modelName: '阿里视频改口型 · 自动长视频', mode: 'video',
        status: String(row.status), error: customerHumanMessage(row.message, ''), createdAt: String(row.createdAt), resolution: String(row.resolution || '720p'),
        duration: Number(row.totalDurationSeconds), price: Number(row.priceChargedYuan), videoUrl: String(row.resultUrl || ''), canRetry: Boolean(row.canRetry), canHide: Boolean(row.canHide),
        retrySource: row.retrySource as HumanJob['retrySource'],
      }));
      const history = sortHumanJobs([...longHistory, ...ordinaryHistory]);
      history.forEach(job => { if (!humanJobPending(job)) saveHumanJob(localStorage, userId, job); });
      setJobs(current => {
        const received = new Set(history.map(job => job.requestId));
        const receivedTasks = new Set(history.flatMap(job => [job.taskId, job.businessId]).filter(Boolean));
        return sortHumanJobs([...history, ...current.filter(job => !received.has(job.requestId) && !receivedTasks.has(job.taskId) && !receivedTasks.has(job.businessId) && (offset > 0 || humanJobPending(job)))]);
      });
      setHistoryOffset(offset); setHistoryMore(data.nextOffset != null || longData.nextOffset != null);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '历史暂时无法读取'); }
    finally { if (alive.current) setHistoryBusy(false); }
  }, [headers, userId]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true); setModelsError('');
    try {
      const response = await fetch('/api/video/models?surface=digital-human', { headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.models)) throw new Error('MODEL_CATALOG_UNAVAILABLE');
      if (alive.current) setModels(data.models);
    } catch {
      if (alive.current) { setModels([]); setModelsError('模型列表暂时无法读取，请重试'); }
    } finally { if (alive.current) setModelsLoading(false); }
  }, [headers]);

  useEffect(() => {
    alive.current = true;
    try {
      localStorage.removeItem(draftKey);
      setDraft(defaultDraft);
    } catch { setStorageError('浏览器无法清理旧草稿，请允许本站存储后再试'); }
    try { setJobs(readHumanJobs(localStorage, userId)); }
    catch { setStorageError('原任务记录暂时无法读取，请保留当前页面'); }
    void loadModels();
    void refreshBalance().catch(() => {}); void loadHistory(); setReady(true);
    return () => {
      alive.current = false;
      activeUpload.current?.controller.abort();
      activeUpload.current?.xhr?.abort();
    };
  }, [draftKey, userId, loadModels, loadHistory, refreshBalance]);
  useEffect(() => {
    if (!ready || modelsLoading) return;
    const currentAvailable = availableModelsForMode(draft.mode);
    if (currentAvailable.length > 0) {
      if (currentAvailable.some(model => model.id === draft.modelId)) return;
      const first = currentAvailable[0];
      setDraft(current => ({ ...current, modelId: first.id, resolution: String(first.capabilities.defaultResolution || '') }));
      return;
    }
    const fallbackMode: HumanMode = draft.mode === 'video' ? 'photo' : 'video';
    const fallback = availableModelsForMode(fallbackMode)[0];
    if (fallback) {
      setDraft(current => ({ ...current, mode: fallbackMode, modelId: fallback.id, resolution: String(fallback.capabilities.defaultResolution || ''), personId: '' }));
      setPerson(null);
      return;
    }
    if (draft.modelId) setDraft(current => ({ ...current, modelId: '', resolution: '' }));
  }, [ready, modelsLoading, draft.mode, draft.modelId, availableModelsForMode]);

  const poll = useCallback(async (original: HumanJob) => {
    let job = original;
    try {
      if (isLongJob(job)) {
        const query = new URLSearchParams();
        if (job.taskId.startsWith('dhl_')) query.set('taskId', job.taskId);
        else query.set('clientRequestId', job.requestId);
        const response = await fetch('/api/digital-human/long-status?' + new URLSearchParams(query), { headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(25_000) });
        const data = await response.json();
        if (!alive.current) return;
        if (!response.ok) { updateJob({ ...job, error: customerHumanMessage(data.error, '长视频状态连接暂时中断，系统将继续查询原任务') }); return; }
        const next = { ...job, taskId: String(data.id || job.taskId), businessId: String(data.id || job.businessId), status: String(data.status || job.status), error: customerHumanMessage(data.message, ''), price: Number(data.priceChargedYuan ?? job.price), videoUrl: String(data.resultUrl || '') };
        updateJob(next);
        if (!humanJobPending(next)) { await loadHistory(); await refreshBalance(); }
        return;
      }
      if (!job.taskId) {
        const response = await fetch('/api/video/request-status?' + new URLSearchParams({ clientRequestId: job.requestId }), { headers: headers(), cache: 'no-store' });
        const receipt = await response.json();
        if (!response.ok || !receipt.found) return;
        job = { ...job, taskId: receipt.taskId, businessId: receipt.businessTaskId || job.businessId };
      }
      const response = await fetch('/api/video/status?' + new URLSearchParams({ taskId: job.taskId, modelId: job.modelId }), { headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(25_000) });
      const data = await response.json();
      if (!alive.current) return;
      if (!response.ok) { updateJob({ ...job, error: '状态连接暂时中断，系统将继续查询原任务' }); return; }
      const next = { ...job, status: String(data.status || job.status), error: customerHumanMessage(data.errorMessage, ''), price: Number(data.priceCharged ?? job.price), videoUrl: String(data.videoUrl || data.video_url || '') };
      updateJob(next);
      if (!humanJobPending(next)) { await loadHistory(); await refreshBalance(); }
    } catch { /* Keep the original receipt; a network interruption never resubmits a task. */ }
  }, [headers, loadHistory, refreshBalance, updateJob]);
  useEffect(() => {
    let stopped = false, running = false;
    const tick = async () => { if (stopped || running) return; running = true; try { for (const job of jobsRef.current.filter(humanJobPending)) { if (stopped) break; await poll(job); } } finally { running = false; } };
    const timer = setInterval(() => void tick(), 5000); void tick();
    return () => { stopped = true; clearInterval(timer); };
  }, [poll]);

  async function cancelQueued(job: HumanJob) {
    try {
      const response=await fetch(isLongJob(job)?'/api/digital-human/long-cancel':'/api/digital-human/cancel',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({taskId:job.businessId||job.taskId})});
      const data=await response.json();
      if(!response.ok){setError(customerHumanMessage(data.error,'暂时无法取消排队'));await poll(job);return;}
      updateJob({...job,status:'cancelled',price:0,error:data.message});await loadHistory();
    }catch{setError('暂时无法确认取消结果，请查询原任务');}
  }
  async function upload(file: File | undefined, slot: UploadSlot) {
    if (!file || pending || uploading) return;
    const category = slot === 'audio' ? 'audio' : draft.mode === 'photo' ? 'image' : 'video';
    const limit = category === 'image' ? 10 : category === 'audio' ? 30 : 100;
    if (file.size <= 0 || file.size > limit * 1024 * 1024) {
      setError(`文件大小需在 1 字节到 ${limit} MB 之间`);
      return;
    }
    const requestId = `digital-upload-${crypto.randomUUID()}`;
    const current: ActiveUpload = { controller: new AbortController(), xhr: null, requestId };
    activeUpload.current = current;
    setUploading(slot); setUploadProgress({ slot, percent: 0, message: '正在检查文件…' }); setError('');
    try {
      const prefixBase64 = await filePrefixBase64(file);
      let asset: HumanAsset | null = null;
      for (let attempt = 0; attempt < 2 && !asset; attempt += 1) {
        setUploadProgress({ slot, percent: 0, message: attempt ? '正在重新建立安全上传…' : '正在建立安全上传…' });
        let ticketResponse = await fetch('/api/digital-human/upload-ticket', {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
          signal: current.controller.signal,
          body: JSON.stringify({ requestId, category, size: file.size, contentType: file.type, originalName: file.name, prefixBase64 }),
        });
        if (ticketResponse.status === 429 && attempt === 0) {
          const retryAfter = Math.max(1, Math.min(10, Number(ticketResponse.headers.get('Retry-After') || 5)));
          setUploadProgress({ slot, percent: 0, message: `上传较多，${retryAfter} 秒后自动重试…` });
          await waitFor(retryAfter * 1000, current.controller.signal);
          ticketResponse = await fetch('/api/digital-human/upload-ticket', {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
            signal: current.controller.signal,
            body: JSON.stringify({ requestId, category, size: file.size, contentType: file.type, originalName: file.name, prefixBase64 }),
          });
        }
        const ticket = await ticketResponse.json() as UploadTicketResponse;
        if (!ticketResponse.ok) throw new Error(String(ticket.error || '无法建立上传，请重试'));
        if (ticket.mode === 'completed' && ticket.asset) { asset = ticket.asset as HumanAsset; break; }
        if (ticket.mode === 'proxy') {
          const form = new FormData(); form.append('file', file); form.append('category', category); form.append('client_request_id', requestId);
          const result = await xhrUpload({
            url: String(ticket.uploadUrl || '/api/digital-human/upload'), method: 'POST', body: form, headers: headers(), active: current,
            onProgress: percent => setUploadProgress({ slot, percent, message: `兼容上传 ${percent}%` }),
          });
          if (result.status < 200 || result.status >= 300 || !result.body.asset) throw new Error(String(result.body.error || '兼容上传失败'));
          asset = result.body.asset as HumanAsset;
          break;
        }
        current.ticketId = String(ticket.ticketId || '');
        let transferError: unknown = null;
        try {
          const result = await xhrUpload({
            url: String(ticket.upload?.url || ''), method: 'PUT', body: file,
            headers: ticket.upload?.headers || { 'Content-Type': file.type }, active: current,
            onProgress: percent => setUploadProgress({ slot, percent, message: `正在直传云存储 ${percent}%` }),
          });
          if (result.status < 200 || result.status >= 300) throw new Error('云存储上传失败，请重试');
        } catch (cause) { transferError = cause; }

        setUploadProgress({ slot, percent: transferError ? 0 : 100, message: transferError ? '上传连接中断，正在确认文件是否保存…' : '文件已传输，正在校验…' });
        for (let verifyAttempt = 0; verifyAttempt < 3 && !asset; verifyAttempt += 1) {
          const completeResponse = await fetch(String(ticket.completeUrl || '/api/digital-human/upload-session'), {
            method: 'POST',
            headers: { ...headers(), 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
            signal: current.controller.signal,
            body: JSON.stringify({ requestId, ticketId: current.ticketId }),
          });
          const completed = await completeResponse.json() as UploadCompletionResponse;
          if (completeResponse.ok && completed.asset) { asset = completed.asset as HumanAsset; break; }
          const retryableVerification = completed.code === 'UPLOAD_NOT_VISIBLE'
            || completed.code === 'UPLOAD_COMPLETE_RETRY'
            || completeResponse.status === 503;
          if (retryableVerification && verifyAttempt < 2) {
            const retryAfter = Math.max(1, Math.min(5, Number(completeResponse.headers.get('Retry-After') || 2)));
            setUploadProgress({ slot, percent: transferError ? 0 : 100, message: `正在确认上传结果，${retryAfter} 秒后继续…` });
            await waitFor(retryAfter * 1000, current.controller.signal);
            continue;
          }
          if (retryableVerification) {
            transferError = new Error(transferError && completed.code === 'UPLOAD_NOT_VISIBLE'
              ? '素材未能上传，请检查网络后重新选择文件；未创建生成任务，不收生成费。'
              : String(completed.error || '云端暂未确认上传结果'));
            break;
          }
          throw new Error(String(completed.error || '上传校验未通过'));
        }
        if (!asset && transferError) {
          if (attempt === 0 && !current.controller.signal.aborted) continue;
          throw transferError;
        }
      }
      if (!asset) throw new Error('上传未完成，请重试');
      if (!alive.current) return;
      if (slot === 'person') { setPerson(asset); setDraft(draftValue => ({ ...draftValue, personId: asset!.id })); }
      else { setAudio(asset); setDraft(draftValue => ({ ...draftValue, audioId: asset!.id })); }
      setDurationChoice(''); setRestoreNotice('');
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') setError('已取消本次上传，未创建生成任务');
      else setError(customerHumanMessage(cause instanceof Error ? cause.message : '', '素材上传失败，请重试'));
    } finally {
      if (activeUpload.current === current) activeUpload.current = null;
      if (alive.current) { setUploading(''); setUploadProgress(null); }
    }
  }

  async function cancelUpload() {
    const current = activeUpload.current;
    if (!current) return;
    current.controller.abort();
    current.xhr?.abort();
    if (current.ticketId) {
      void fetch('/api/digital-human/upload-session', {
        method: 'DELETE',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: current.requestId, ticketId: current.ticketId }),
        keepalive: true,
      }).catch(() => {});
    }
  }
  async function submit() {
    if (locked.current || pending || commerceAudioPending || storageError || modelsLoading || modelsError || !selected || !person || !audio || durationError || ((draft.audioSource === 'speech' && !speechReady) || (draft.audioSource === 'imitation' && !imitationReady))) return;
    locked.current = true; setError(''); setRestoreNotice('');
    const job: HumanJob = { requestId: `${longRequested ? 'digital-long' : 'digital'}-${crypto.randomUUID()}`, taskId: '', businessId: '', modelId: selected.id, modelName: selected.displayName, mode: draft.mode,
      status: 'submitting', error: '', createdAt: new Date().toISOString(), resolution: draft.resolution, duration: billableSeconds, price };
    try { saveHumanJob(localStorage, userId, job); } catch { setStorageError('浏览器无法保存原任务，本次尚未提交'); locked.current = false; return; }
    setJobs(current => [job, ...current]);
    try {
      const response = await fetch(longRequested ? '/api/digital-human/long-generate' : '/api/digital-human/generate', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180_000),
        body: JSON.stringify({ mode: draft.mode, modelId: selected.id, resolution: longRequested ? '720p' : draft.resolution, personAssetId: person.id, audioAssetId: audio.id, clientRequestId: job.requestId, durationChoice: effectiveDurationChoice }) });
      const data = await response.json();
      const taskId = String(data.task_id || data.taskId || '');
      const knownFailure = data.task_submitted === false || (data.task_submitted !== null && !taskId && [400, 401, 402, 403, 404, 422, 429].includes(response.status));
      updateJob({ ...job, taskId, businessId: String(data.business_task_id || data.taskId || ''), status: knownFailure ? 'failed' : taskId ? String(data.status || 'pending') : 'unknown', error: customerHumanMessage(data.error || data.message, longRequested ? `已自动拆分为 ${Number(data.segmentCount || 0)} 段，全部完成后自动合并并一次结算。` : '') });
      if (response.status === 402 && data.error_code === 'INSUFFICIENT_CASH_BALANCE') setError('现金余额不足，请充值后再试');
    } catch { updateJob({ ...job, status: 'unknown', error: '暂未收到提交结果，系统会继续查询原任务' }); }
    finally { locked.current = false; }
  }
  async function restoreFromHistory(job: HumanJob) {
    const source = job.retrySource;
    if (pending || restoring || job.status !== 'failed' || !job.canRetry || !source) return;
    if (![source.personAssetId, source.audioAssetId].every(id => /^[0-9a-f-]{36}$/iu.test(id))) {
      setError('原任务没有可安全恢复的站内素材，请重新选择素材');
      return;
    }
    setRestoring(job.requestId); setError(''); setRestoreNotice('');
    try {
      const assetQuery = new URLSearchParams();
      assetQuery.append('id', source.personAssetId); assetQuery.append('id', source.audioAssetId);
      const [assetResponse, modelResponse] = await Promise.all([
        fetch('/api/digital-human/assets?' + assetQuery, { headers: headers(), cache: 'no-store' }),
        fetch('/api/video/models?surface=digital-human', { headers: headers(), cache: 'no-store' }),
      ]);
      const [assetData, modelData] = await Promise.all([assetResponse.json(), modelResponse.json()]);
      if (!assetResponse.ok) throw new Error(assetData.error || '原素材已不可用，请重新上传');
      if (!modelResponse.ok) throw new Error(modelData.error || '模型目录暂时无法读取，请稍后再试');
      const latestModels = Array.isArray(modelData.models) ? modelData.models as Model[] : [];
      const currentModel = latestModels.find(model => model.id === job.modelId);
      if (!currentModel || currentModel.capabilities.available !== true || currentModel.capabilities.generationReady === false) throw new Error('原模型当前未完成生成验收，请重新选择可用模型');
      const modelMode: HumanMode = currentModel.capabilities.requiresSourceVideo === true ? 'video' : 'photo';
      if (modelMode !== job.mode) throw new Error('原模型能力已经变化，不能按旧创作方式载入');
      const resolutionOptions = Array.isArray(currentModel.capabilities.resolutionOptions)
        ? currentModel.capabilities.resolutionOptions.map(String)
        : [];
      if (!job.resolution || !resolutionOptions.includes(job.resolution)) {
        throw new Error('原画质当前不可用，请重新选择模型和画质');
      }
      const assets = Array.isArray(assetData.assets) ? assetData.assets as HumanAsset[] : [];
      const restoredPerson = assets.find(asset => asset.id === source.personAssetId);
      const restoredAudio = assets.find(asset => asset.id === source.audioAssetId);
      if (!restoredPerson || restoredPerson.category !== (job.mode === 'photo' ? 'image' : 'video')) throw new Error('原人物素材类型已不匹配，请重新上传');
      if (!restoredAudio || restoredAudio.category !== 'audio') throw new Error('原配音素材已不可用，请重新选择');
      setModels(latestModels);
      setPerson(restoredPerson); setAudio(restoredAudio);
      setSpeechReady(false); setImitationReady(false);
      setDraft({ mode: job.mode, modelId: currentModel.id, resolution: job.resolution, personId: restoredPerson.id, audioId: restoredAudio.id, audioSource: 'upload' });
      setDurationChoice(source.durationChoice || '');
      setRestoreNotice('已重新核验并载入原模型、画质和本人素材；旧任务编号不会复用。请核对页面显示的当前价格，再主动点击“生成数字人视频”创建新任务。');
      window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (cause) {
      setError(customerHumanMessage(cause instanceof Error ? cause.message : '', '原参数暂时无法载入，请稍后重试'));
    } finally {
      if (alive.current) setRestoring('');
    }
  }
  async function download(job: HumanJob) {
    try {
      const name = `${job.mode === 'photo' ? '照片说话' : '视频改口型'}-${job.createdAt.slice(0, 10)}.mp4`;
      const endpoint = isLongJob(job)
        ? '/api/digital-human/long-download?' + new URLSearchParams({ taskId: job.taskId, name })
        : '/api/video/access-ticket?' + new URLSearchParams({ taskId: job.businessId || job.taskId, scope: 'download', name });
      const response = await fetch(endpoint, { headers: headers() });
      const data = await response.json(); if (!response.ok || !data.url) throw new Error(customerHumanMessage(data.error, '下载失败'));
      const link = document.createElement('a'); link.href = data.url; link.download = name; link.click();
    } catch (cause) { setError(customerHumanMessage(cause instanceof Error ? cause.message : '', '下载暂时不可用')); }
  }
  async function removeHistory(job: HumanJob) {
    if (humanJobPending(job) || (isLongJob(job) && !job.canHide)) return;
    try {
      if (job.businessId) {
        const endpoint = (isLongJob(job) ? '/api/digital-human/long-history?' : '/api/video/history?') + new URLSearchParams({ taskId: job.businessId });
        const response = await fetch(endpoint, { method: 'DELETE', headers: headers() });
        const data = await response.json(); if (!response.ok) throw new Error(customerHumanMessage(data.error, '记录暂时无法移除'));
      }
      setJobs(current => current.filter(item => item.requestId !== job.requestId)); setRemoving('');
    } catch (cause) { setError(customerHumanMessage(cause instanceof Error ? cause.message : '', '记录暂时无法移除')); }
  }
  const uploadControl = (slot: UploadSlot) => <div className={styles.uploadControls}>
    <label className={styles.uploadButton}>
      <input aria-label={slot === 'audio' ? '上传配音音频' : draft.mode === 'photo' ? '上传人物照片' : '上传人物视频'} type="file" accept={slot === 'audio' ? '.mp3,.wav,.aac' : draft.mode === 'photo' ? '.png,.jpg,.jpeg,.webp,.bmp' : '.mp4,.mov,.avi'} disabled={pending || !!uploading} onChange={event => { void upload(event.target.files?.[0], slot); event.target.value = ''; }} />
      {uploading === slot ? uploadProgress?.message || '正在上传…' : (slot === 'person' ? person : audio) ? '替换素材' : slot === 'person' ? '上传人物素材' : '上传配音音频'}
    </label>
    {uploading === slot && uploadProgress && <div className={styles.uploadStatus} role="status" aria-live="polite">
      <div role="progressbar" aria-label="素材上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgress.percent}><span style={{ width: `${uploadProgress.percent}%` }} /></div>
      <span>{uploadProgress.percent}%</span>
      <button type="button" onClick={() => void cancelUpload()}>取消</button>
    </div>}
  </div>;
  return <main className={styles.page}>
    <SubPageHeader title="AI 数字人" subtitle="让视频说出新台词，让照片开口说话" icon={<Clapperboard size={23} />} backHref={backHref} />
    <div className={styles.scrollArea} tabIndex={0} aria-label="数字人工作区">
    <div className={styles.accountBar}><span>创作工作台</span><div className={styles.wallet}><WalletCards size={17} /><strong>本站钱包 {balance == null ? '读取中' : '¥' + balance.toFixed(2)}</strong><button type="button" className={styles.recharge} onClick={() => setRechargeOpen(true)}>充值</button></div></div>
    <div className={styles.layout}>
      <section ref={editorRef} className={styles.editor} aria-label="数字人创作">
        <div className={styles.modes} role="tablist" aria-label="创作方式">{(['video', 'photo'] as HumanMode[]).map(mode => {
          const availableCount = availableModelsForMode(mode).length;
          return <button role="tab" aria-selected={draft.mode === mode} aria-disabled={!modelsLoading && availableCount === 0} disabled={pending || !!uploading || modelsLoading || availableCount === 0} key={mode} onClick={() => { setDraft(current => ({ ...current, mode, modelId: '', resolution: '', personId: '' })); setPerson(null); setDurationChoice(''); setRestoreNotice(''); setError(''); }}><strong>{mode === 'photo' ? '照片说话' : '视频改口型'}</strong><span>{modelsLoading ? '正在读取可用模型…' : modelsError ? '模型列表读取失败' : availableCount === 0 ? '当前没有可提交的模型' : mode === 'photo' ? '一张人物照片 + 配音' : '人物视频 + 新配音'}</span></button>;
        })}</div>
        <div className={styles.assets}>
          <section className={styles.asset}><h2><b>1</b>{draft.mode === 'photo' ? '人物照片' : '人物视频'}</h2><div className={styles.preview}>{person ? draft.mode === 'photo' ? <img src={person.url} alt="已上传的人物照片" /> : <video src={person.url} controls preload="metadata" /> : <div className={styles.uploadEmpty}><ImagePlus size={46} strokeWidth={1.2} /><strong>{draft.mode === 'photo' ? '让照片中的人物开口说话' : '让视频中的人物说出新台词'}</strong><span>选择清晰、正面、无遮挡的人物素材</span></div>}</div>{uploadControl('person')}<p>{person ? `${person.width} × ${person.height}${person.duration ? ` · ${person.duration.toFixed(1)} 秒` : ''}` : draft.mode === 'photo' ? 'JPG / PNG / WebP · 最大 10 MB' : 'MP4 / MOV / AVI · 最大 100 MB · 时长见所选模型'}</p></section>
          <section className={styles.asset}><h2><b>2</b>台词与声音</h2>
            <div className={styles.audioTabs} role="tablist" aria-label="配音来源"><button role="tab" aria-selected={draft.audioSource === 'speech'} disabled={pending || !!uploading || speechPending || imitationPending} onClick={() => setDraft(current => ({ ...current, audioSource: 'speech' }))}>语音合成</button><button role="tab" aria-selected={draft.audioSource === 'imitation'} disabled={pending || !!uploading || speechPending || imitationPending} onClick={() => setDraft(current => ({ ...current, audioSource: 'imitation' }))}>音色模仿</button><button role="tab" aria-selected={draft.audioSource === 'upload'} disabled={pending || !!uploading || speechPending || imitationPending} onClick={() => setDraft(current => ({ ...current, audioSource: 'upload' }))}>上传现成音频</button></div>
            {draft.audioSource === 'speech' && <SpeechComposer userId={userId} token={token} maxSeconds={Number(selected?.capabilities.maxDuration || 120)} disabled={pending || !!uploading} audio={audio} onAudio={acceptSpeech} onReady={setSpeechReady} onPending={setSpeechPending} />}
            {draft.audioSource === 'imitation' && <ImitationComposer userId={userId} token={token} maxSeconds={Number(selected?.capabilities.maxDuration||120)} disabled={pending||!!uploading} audio={audio} onAudio={acceptSpeech} onReady={setImitationReady} onPending={setImitationPending}/>}
            {draft.audioSource === 'upload' && <div><div className={styles.audioPreview}>{audio ? <audio aria-label="试听上传配音" src={audio.url} controls preload="metadata" /> : <div className={styles.uploadEmpty}><AudioLines size={40} /><strong>用你已经制作好的配音</strong><span>音频将驱动人物口型与表情</span></div>}</div>{uploadControl('audio')}<p>{audio ? audio.duration.toFixed(1) + ' 秒' : 'MP3 / WAV / AAC · 最大 30 MB · 时长见所选模型'}</p><p className={styles.hint}>上传现成音频不收取配音合成费。{backHref==='/commerce'?'也可以直接选择当前账号在带货 Agent 已完成的配音。':'也可以切换到“语音合成”，直接调用智音工坊。'}</p>{backHref==='/commerce'&&<CommerceAudioAssetPicker userId={userId} token={token} disabled={pending||!!uploading} audio={audio} onAudio={acceptSpeech} onBusyChange={setCommerceAudioPending}/>}</div>}
          </section>
        </div>
        <section className={styles.settings}><h2><b>3</b>生成设置</h2><div className={styles.settingsRow}><label>生成模型<select aria-label="数字人模型" value={selected?.id || ''} disabled={pending || availableModeModels.length === 0} onChange={event => { const model = availableModeModels.find(item => item.id === event.target.value); setDraft(current => ({ ...current, modelId: event.target.value, resolution: String(model?.capabilities.defaultResolution || '') })); setDurationChoice(''); setRestoreNotice(''); }}>{!selected && <option value="">{modelsLoading ? '正在读取模型…' : modelsError ? '模型列表读取失败' : draft.modelId ? '原模型暂不可用，请重新选择' : availableModeModels.length ? '请选择生成模型' : '暂无可提交模型'}</option>}{modeModels.map(model => {const generationReady=model.capabilities.available===true&&model.capabilities.generationReady!==false;return <option key={model.id} value={model.id} disabled={!generationReady}>{model.displayName}{!generationReady?` · ${String(model.capabilities.readinessMessage||model.capabilities.availabilityMessage||'真实生成尚未验收')}`:` · ¥${humanUnitPrice(model,String(model.capabilities.defaultResolution||'')).toFixed(3)}/${model.capabilities.billingUnit==='output_second'?'秒起':'次起'}`}</option>;})}</select></label><label>输出画质<select aria-label="数字人画质" value={draft.resolution} disabled={pending || !selected} onChange={event => { setDraft(current => ({ ...current, resolution: event.target.value })); setRestoreNotice(''); }}>{resolutions.map(value => <option key={value} value={value}>{draft.mode === 'video' ? '原视频画质' : value}</option>)}</select></label></div>{selected && <div className={styles.modelPrice}><strong>当前画质 ¥{unitPrice.toFixed(3)} / {unitLabel}</strong><span>{unitLabel === '秒' ? '按生成时长计费，不足一分钟不按整分钟收取' : '每个成功任务收取一次费用'}</span></div>}<p className={styles.hint}>{selected ? `配音${humanDurationRange(selected.capabilities)}${draft.mode === 'video' ? `；人物视频${humanDurationRange(selected.capabilities, 'video')}。配音较长时可选择时长处理方式。` : '；画幅按照片方向适配。'}` : modelsLoading ? '正在读取可用模型…' : modelsError ? modelsError : modeModels.length && availableModeModels.length === 0 ? '模型仍会显示，但真实生成验收完成前不能提交。' : modeModels.length ? '请选择适合当前素材的生成模型。' : '当前方式暂不可用，请稍后重试。'}</p></section>
        {needsDurationChoice && <section className={styles.durationChoice} aria-label="音画时长处理"><h3>配音长于人物视频</h3><p>人物视频 {person!.duration.toFixed(1)} 秒 · 配音 {audio!.duration.toFixed(1)} 秒</p><div>{selected?.capabilities.supportsVideoExtension === true && <button aria-pressed={durationChoice === 'preserve_audio'} disabled={pending} onClick={() => setDurationChoice('preserve_audio')}><strong>保留完整配音</strong><span>{longCandidate ? `自动拆成每段不超过 115 秒，逐段生成后合并为 ${audio!.duration.toFixed(1)} 秒完整视频` : `成片 ${audio!.duration.toFixed(1)} 秒 · 画面往返播放至配音结束`}</span></button>}<button aria-pressed={durationChoice === 'trim_audio'} disabled={pending} onClick={() => setDurationChoice('trim_audio')}><strong>按视频长度截短配音</strong><span>成片 {person!.duration.toFixed(1)} 秒 · 末尾 {(audio!.duration-person!.duration).toFixed(1)} 秒配音不使用</span></button></div></section>}
        {longRequested && <div className={styles.modelPrice} role="status"><strong>长视频自动处理 · 720p · ¥{quotedUnitPrice.toFixed(3)}/秒</strong><span>系统按自然句界规划分段，每段不超过 115 秒；逐段生成、自动合并，完整成片保存成功后只结算一次。</span></div>}
        {restoreNotice && <div className={styles.restoreNotice} role="status">{restoreNotice}</div>}
        {modelsError && <div className={styles.error} role="alert">{modelsError}<button type="button" disabled={modelsLoading} onClick={() => void loadModels()}>重新加载模型</button></div>}
        {(error || storageError || (durationError && durationPlan?.code !== 'DIGITAL_HUMAN_DURATION_CHOICE')) && <div className={styles.error} role="alert">{storageError || error || durationError}</div>}
        <footer className={styles.submit}>
          <div className={styles.priceBlock}><span>本次视频费用</span><strong>{seconds && selected ? '¥' + price.toFixed(2) : durationError ? durationPlan?.needsChoice ? '请选择时长方案' : '请先调整时长' : '待素材就绪'}{billableSeconds > 0 && <small> / {billableSeconds.toFixed(1)} 秒</small>}</strong><span>成功交付后扣本站现金，失败不收视频费</span></div>
          <button className={styles.generateButton} disabled={!ready || modelsLoading || !!modelsError || !selected || !person || !audio || !!uploading || commerceAudioPending || pending || !!storageError || !!durationError || ((draft.audioSource === 'speech' && !speechReady) || (draft.audioSource === 'imitation' && !imitationReady))} onClick={() => void submit()}><Sparkles size={18} />{pending ? '原任务正在处理' : commerceAudioPending ? '正在核验带货配音' : '生成数字人视频'}</button>
        </footer>
        <details className={styles.pricing}><summary>价格说明与计费规则</summary><p>以下为本站对用户的售价。智音工坊配音使用本站积分；数字人视频成功交付后使用本站现金。每笔视频任务提交时锁定价格，后续调价不会改变这笔任务的费用。</p>
          {selected && unitLabel === '秒' && <p>当前画质单价 ¥{unitPrice.toFixed(3)}/秒。{[30, 40, 60, 61, 90].filter(value => !planHumanDuration(selected.capabilities, 'photo', 0, value).error).map(value => value + '秒 ¥' + humanQuote(selected, draft.resolution, value).toFixed(2)).join('；')}。提交前按模型支持的时长精度确定生成时长，金额四舍五入到分；以“本次视频费用”显示的报价为准。</p>}
          <div className={styles.priceTable}><table><thead><tr><th>模型</th><th>画质</th><th>本站单价</th><th>支持时长</th></tr></thead><tbody>{models.flatMap(model => ((model.capabilities.resolutionOptions as string[]) || ['默认']).map(resolution => {
            const prices = Object.fromEntries(((model.capabilities.resolutionPrices as string[]) || []).map(item => String(item).split('='))); const rate = Number(prices[resolution] ?? model.publicPrice);
            return <tr key={model.id + resolution}><td>{model.displayName}{model.capabilities.available === false ? ' · 暂停提交' : ''}</td><td>{model.capabilities.requiresSourceVideo ? '原视频' : resolution}</td><td>{model.capabilities.available === false ? '暂停提交' : `¥${rate.toFixed(3)} / ${model.capabilities.billingUnit === 'output_second' ? '秒' : '次'}`}</td><td>{model.capabilities.available === false ? String(model.capabilities.availabilityMessage || '服务暂不可用，请稍后重试') : humanDurationRange(model.capabilities)}</td></tr>;
          }))}</tbody></table></div>
          <p>阿里视频改口型超过单段上限时，选择“保留完整配音”即可自动按不超过 115 秒分段，逐段生成后统一画质并合并成片。任务按整片锁定报价，完整成片保存成功后只结算一次；中途失败不交付残片，也不扣整片视频费。</p>
          <p>已成功生成的配音会保留配音费用，即使随后不生成视频。重复查询原任务不会再次收费。</p>
        </details>
      </section>
      <section className={styles.results} aria-label="数字人生成记录"><div className={styles.resultsTitle}><h2><History size={19} />作品与任务</h2><button disabled={historyBusy} onClick={() => { setError(''); void loadHistory(); }}>刷新</button></div><p>记录保存在当前账号，切换页面后仍可继续查看。</p>{historyBusy && !jobs.length ? <p role="status">正在读取作品…</p> : !jobs.length ? <div className={styles.empty}>先试听声音，再生成视频；第一条作品将在这里出现</div> : visibleJobs.map(job => <article className={styles.job} key={job.requestId}><div className={styles.jobHeading}><strong>{job.mode === 'photo' ? '照片说话' : isLongJob(job) ? '视频改口型 · 自动长视频' : '视频改口型'}</strong><span>{isLongJob(job) && job.status === 'processing' ? '分段生成中' : labels[job.status] || '正在处理'}</span></div><small>{job.modelName} · {isLongJob(job) ? '720p 自动分段合并' : job.mode === 'video' ? '原视频画质' : job.resolution} · {new Date(job.createdAt).toLocaleString('zh-CN')}</small>{job.status === 'completed' && job.videoUrl ? <><HistoryVideo url={job.videoUrl} label={`${job.modelName}生成视频`} /><div className={styles.jobActions}><span>本站实付 ¥{job.price.toFixed(2)}</span><button onClick={() => void download(job)}>下载视频</button></div></> : <div className={styles.jobStatus}><p>{job.status === 'failed' ? job.error || '本次未生成成功，未扣费' : job.status === 'unknown' || job.status === 'confirming' ? '正在确认原任务，无需重新提交' : job.error || (job.status === 'queued' ? '排队中，轮到后自动开始' : job.status === 'cancelled' ? '已取消排队，本次未扣费' : job.status === 'merging' ? '全部分段已完成，正在自动合并完整视频' : job.status === 'billing_pending' ? '完整视频已保存，正在完成本站钱包结算' : '生成完成后，成片会自动显示在这里')}</p>{job.status === 'queued' && <button onClick={() => void cancelQueued(job)}>取消排队</button>}{humanJobPending(job) && <button onClick={() => void poll(job)}>查询原任务</button>}{job.status === 'failed' && job.canRetry && job.retrySource && <button disabled={!!restoring || pending} onClick={() => void restoreFromHistory(job)}>{restoring === job.requestId ? '正在重新核验…' : '载入原参数'}</button>}</div>}{!humanJobPending(job) && (!isLongJob(job) || job.canHide) && <div className={styles.jobActions}>{removing === job.requestId ? <><span>仅移出作品列表，保留任务、成品和账单。</span><button onClick={() => void removeHistory(job)}>确认移除</button><button onClick={() => setRemoving('')}>保留</button></> : <button onClick={() => setRemoving(job.requestId)}>从记录中移除</button>}</div>}</article>)}{jobs.length > renderedHistoryCount && <button disabled={historyBusy} onClick={() => setHistoryVisible(count => Math.min(jobs.length, count + INITIAL_HISTORY_ITEMS))}>显示更多本页记录 · {Math.min(renderedHistoryCount, jobs.length)} / {jobs.length}</button>}{historyMore && jobs.length <= renderedHistoryCount && <button disabled={historyBusy} onClick={() => void loadHistory(historyOffset + 20)}>加载更多作品</button>}</section>
    </div>
    </div>
    {rechargeOpen && <RechargeDialog open={rechargeOpen} onOpenChange={setRechargeOpen} credits={0} cashBalance={balance || 0} mode="cash" onCashUpdated={value => { setBalance(value); dispatch({ type:'SET_CASH_BALANCE', payload:value }); }} />}
  </main>;
}
