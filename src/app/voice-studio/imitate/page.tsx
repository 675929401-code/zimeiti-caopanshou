'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useAppScopedRouter } from '@/hooks/use-app-scoped-router';
import { useApp } from '@/contexts/app-context';
import { resolveWorkbenchIdentity, workbenchUserStorageKey } from '@/lib/workbench-user-storage';
import { downloadOwnedAudio } from '@/lib/vs/owned-audio';
import AudioPlayer from '@/components/vs/AudioPlayer';
import ReferenceAudioSelector from '@/components/vs/ReferenceAudioSelector';
import { PencilLine, Settings2 } from 'lucide-react';
import {
  buildClientRequestFingerprint,
  readBrowserClientAttempt,
  clearBrowserClientAttempt,
  resolveBrowserClientAttempt,
} from '@/lib/browser-client-attempt';

interface AudioRef {
  id: string;
  assetId?: string;
  url: string;
  name: string;
  source: 'saved' | 'link' | 'upload';
  file?: File;
}

interface AudioConfig {
  format: 'wav' | 'mp3' | 'ogg_opus';
  sampleRate: 8000 | 16000 | 24000 | 32000 | 44100 | 48000;
  speechRate: number;   // [-50, 100]
  loudnessRate: number;  // [-50, 100]
  pitchRate: number;     // [-12, 12]
}

interface ResultInfo {
  audioUrl: string;
  duration: number;
  originalDuration: number;
  assetId: string;
  generationId: string;
}

const MAX_REFERENCES = 3; // API 上限
const MAX_PROMPT_LEN = 2048; // API 上限

function customerVoiceError(value: unknown, fallback = '音色模仿暂未完成，请稍后重试') {
  const detail = typeof value === 'string' ? value.trim() : '';
  if (/余额不足|积分不足|额度不足/u.test(detail)) return '当前余额不足，请充值后重试。';
  if (/参考音频|音频/u.test(detail) && /无效|识别|读取|格式|过大|过小/u.test(detail)) return '参考音频未通过检查，请更换清晰的人声录音后重试。';
  if (/API|HTTP|provider|供应商|上游|渠道|密钥|后台|数据库|迁移|作业键|预占|终态|落库/iu.test(detail)) return fallback;
  return detail || fallback;
}

const SAMPLE_RATE_OPTIONS: Array<AudioConfig['sampleRate']> = [8000, 16000, 24000, 32000, 44100, 48000];
const FORMAT_OPTIONS: Array<{ value: AudioConfig['format']; label: string; desc: string }> = [
  { value: 'mp3', label: 'MP3', desc: '通用·压缩' },
  { value: 'wav', label: 'WAV', desc: '无损·大文件' },
  { value: 'ogg_opus', label: 'OGG', desc: '开源·压缩' },
];

export default function ImitatePage() {
 const {state}=useApp();const identity=resolveWorkbenchIdentity(state.auth);
 return identity ? <ImitateWorkspace key={identity.userId} userId={identity.userId} token={identity.token}/> : <div className="p-8">请先登录后使用音色模仿。</div>;
}
function ImitateWorkspace({userId,token}:{userId:string;token:string}) {
 const attemptKey=workbenchUserStorageKey('voice-imitate:generate',userId);
 const [quote,setQuote]=useState<{reserveCredits:number;unitPrice:number}|null>(null);
 const [quoteError,setQuoteError]=useState('');
 const [quoteRevision,setQuoteRevision]=useState(0);
 const [recovering,setRecovering]=useState(false);
 const [recoveryRevision,setRecoveryRevision]=useState(0);
 const [recoveryError,setRecoveryError]=useState('');
 useEffect(()=>{const controller=new AbortController();setQuote(null);setQuoteError('');void (async()=>{try{const response=await fetch('/api/voice/imitation-quote',{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});const data=await response.json();if(!response.ok||!data.data||!Number.isFinite(Number(data.data.unitPrice)))throw new Error(customerVoiceError(data.message,'音色模仿价格暂时无法读取'));if(!controller.signal.aborted)setQuote(data.data);}catch(error){if(!controller.signal.aborted)setQuoteError(customerVoiceError(error instanceof Error?error.message:'','音色模仿价格暂时无法读取'));}})();return()=>controller.abort();},[token,quoteRevision]);
 useEffect(()=>{try{localStorage.removeItem(workbenchUserStorageKey('imitate_history',userId));}catch{}},[userId]);
  const router = useAppScopedRouter();
  const [references, setReferences] = useState<AudioRef[]>([]);
  const [showSelector, setShowSelector] = useState(false);
  const [textPrompt, setTextPrompt] = useState('');
  const [audioConfig, setAudioConfig] = useState<AudioConfig>({
    format: 'mp3',
    sampleRate: 24000,
    speechRate: 0,
    loudnessRate: 0,
    pitchRate: 0,
  });
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<ResultInfo | null>(null);
  const [error, setError] = useState('');
  const [providerStatus, setProviderStatus] = useState<'checking' | 'available' | 'unavailable'>('checking');

  // 生成历史只从账号服务器读取，浏览器不再保留影子副本。
  interface HistoryItem {
    text: string;
    refNames: string[];
    audioUrl?: string;
    duration: number;
    time: string;
    assetId?: string;
    generationId: string;
    status: 'success' | 'failed' | 'processing';
    errorMessage?: string;
    terminalState?: string;
    billingState?: string;
    retryEligible?: boolean;
    retryUnavailableReason?: string;
  }
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyError, setHistoryError] = useState('');

  const refreshHistory=useCallback(async()=>{
   setHistoryError('');
   try {const response=await fetch('/api/voice/history?modelId=seed-audio-1.0&pageSize=100',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const payload=await response.json();if(!response.ok)throw new Error('历史记录暂时无法读取');
    const records=(payload.data?.items||[]).filter((item:any)=>item.status==='failed'||item.status==='processing'||(item.status==='success'&&item.outputAssetId)).map((item:any)=>({text:item.inputText,refNames:[],audioUrl:item.outputAssetId?'/api/storage/files/'+item.outputAssetId+'/content':undefined,duration:Number(item.outputDuration||0),time:new Date(item.createdAt).toLocaleString('zh-CN'),assetId:item.outputAssetId||undefined,generationId:item.id,status:item.status,errorMessage:item.errorMessage,terminalState:item.terminalState,billingState:item.billingState,retryEligible:item.retryEligible,retryUnavailableReason:item.retryUnavailableReason}));
    setHistory(records);
   }catch(error){setHistoryError(error instanceof Error?error.message:'历史暂时无法读取');}
  },[token]);
  useEffect(()=>{void refreshHistory();},[refreshHistory]);
  useEffect(()=>{if(!history.some(item=>item.status==='processing'))return;const refreshIfVisible=()=>{if(document.visibilityState==='visible')void refreshHistory();};const interval=window.setInterval(refreshIfVisible,15000);window.addEventListener('focus',refreshIfVisible);document.addEventListener('visibilitychange',refreshIfVisible);return()=>{window.clearInterval(interval);window.removeEventListener('focus',refreshIfVisible);document.removeEventListener('visibilitychange',refreshIfVisible);};},[history,refreshHistory]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/voice/status?provider=volcano', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as {
          data?: { available?: boolean; canSubmit?: boolean; upstreamCalls?: number; creditsCharged?: number };
          message?: string;
        };
        const available = response.ok && payload.data?.available === true && payload.data.canSubmit === true;
        setProviderStatus(available ? 'available' : 'unavailable');
        if (!available) {
          setError('音色模仿服务暂时不可用，本次不会提交生成或产生费用。');
        }
      } catch (statusError) {
        if (statusError instanceof DOMException && statusError.name === 'AbortError') return;
        setProviderStatus('unavailable');
        setError('音色模仿服务状态暂时无法确认，本次不会提交生成或产生费用。');
      }
    })();
    return () => controller.abort();
  }, []);

  const addReference = (audio: { url: string; name: string; source: 'saved' | 'link' | 'upload'; file?: File; assetId?: string }) => {
    if (references.length >= MAX_REFERENCES) return;
    setReferences((prev) => [
      ...prev,
      {
        id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        assetId: audio.assetId,
        url: audio.url,
        name: audio.name,
        source: audio.source,
        file: audio.file,
      },
    ]);
    setShowSelector(false);
  };

  const removeReference = (id: string) => {
    const target = references.find((reference) => reference.id === id);
    if (target && !window.confirm(`确认从本次模仿任务移除“${target.name}”？`)) return;
    setReferences((previous) => {
      const removedIndex = previous.findIndex((reference) => reference.id === id);
      if (removedIndex < 0) return previous;
      setTextPrompt((prompt) => remapPromptAfterRemoval(prompt, removedIndex));
      return previous.filter((reference) => reference.id !== id);
    });
  };

  const remapPromptAfterRemoval = (prompt: string, removedIndex: number): string => {
    const removedNumber = removedIndex + 1;
    return prompt.replace(/@音频(\d+)\s*/gu, (match, rawNumber: string) => {
      const number = Number(rawNumber);
      if (number === removedNumber) return '';
      if (number > removedNumber) return `@音频${number - 1} `;
      return match;
    }).replace(/\s{2,}/gu, ' ').trim();
  };

  const insertTag = (refIdx: number) => {
    setTextPrompt((prev) => prev + ` @音频${refIdx + 1}`);
  };

  const handleGenerate = async () => {
    if(!quote || generating || recovering || recoveryError)return;
    if (providerStatus !== 'available') {
      setError('音色模仿服务暂时不可用，本次不会提交生成或产生费用。');
      return;
    }
    if (!textPrompt.trim()) { setError('请输入文案/提示词'); return; }
    if (!references.length) { setError('请先选择至少 1 条参考音源'); return; }
    setGenerating(true);
    setResult(null);
    setError('');
    try {
      // 构造 references 数组（base64 转换 + URL）
      const refsPayload = await Promise.all(
        references.map(async (ref) => {
          if (ref.assetId) return { assetId: ref.assetId };
          throw new Error('参考音频身份已过期，请重新选择已保存音频');
        })
      );
      const validRefs = refsPayload.filter(Boolean);

      const body: Record<string, unknown> = {
        textPrompt: textPrompt.trim(),
        references: validRefs,
        format: audioConfig.format,
        sampleRate: audioConfig.sampleRate,
        speechRate: audioConfig.speechRate,
        loudnessRate: audioConfig.loudnessRate,
        pitchRate: audioConfig.pitchRate,
      };

      const fingerprint = await buildClientRequestFingerprint(body);
      const attemptStorageKey = attemptKey;
      const attempt = resolveBrowserClientAttempt({
        storageKey: attemptStorageKey,
        fingerprint,
        prefix: 'voice-imitate',
      });

      const res = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': attempt.clientRequestId,
          ...(localStorage.getItem('auth_token')
            ? { Authorization: `Bearer ${localStorage.getItem('auth_token')}` }
            : {}),
        },
        body: JSON.stringify({
          ...body,
          client_request_id: attempt.clientRequestId,
        }),
      });
      const d = await res.json().catch(() => ({}));
      const assetId = String(d.data?.asset?.id || '');
      const generationId = String(d.data?.generationId || '');
      const isDeliverable = res.ok
        && d.success === true
        && d.data?.terminalStatus === 'completed'
        && d.data?.persisted === true
        && Boolean(d.data?.audioUrl && assetId && generationId);
      if (isDeliverable) {
        clearBrowserClientAttempt(attemptStorageKey, attempt.clientRequestId);
        const durableAudioUrl = `/api/storage/files/${encodeURIComponent(assetId)}/content`;
        const newResult: ResultInfo = {
          audioUrl: durableAudioUrl,
          duration: Number(d.data.duration || 0),
          originalDuration: Number(d.data.originalDuration ?? d.data.duration ?? 0),
          assetId,
          generationId,
        };
        setResult(newResult);
        void refreshHistory();
      } else {
        if(['refunded','failed'].includes(d.data?.terminalStatus)||[400,401,402,403,404,422,429].includes(res.status)&&!d.data?.requestId)clearBrowserClientAttempt(attemptStorageKey,attempt.clientRequestId);
        else setRecovering(true);
        setError(customerVoiceError(d.message, d.success ? '结果正在保存，请查询原任务' : '音色模仿暂未完成，请稍后重试'));
      }
    } catch (err: unknown) {
      setRecovering(true);setError(customerVoiceError(err instanceof Error ? err.message : '', '音色模仿暂未完成，请稍后重试'));
    } finally {
      setGenerating(false);
    }
  };

  useEffect(()=>{
   if(generating)return;const attempt=readBrowserClientAttempt(attemptKey);if(!attempt){setRecovering(false);setRecoveryError('');return;}let alive=true;let timer:number|undefined;setRecovering(true);setRecoveryError('');
   const recover=async()=>{try{const response=await fetch('/api/voice/generation-status?'+new URLSearchParams({clientRequestId:attempt.clientRequestId,phase:'seed-audio'}),{headers:{Authorization:'Bearer '+token},cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.message||'原任务状态暂时无法读取');if(!alive)return;const task=data.data;
    if(task?.state==='completed'&&task.assetId){setResult({audioUrl:'/api/storage/files/'+task.assetId+'/content',assetId:task.assetId,generationId:task.generationId,duration:task.response?.data?.duration||0,originalDuration:task.response?.data?.originalDuration||0});clearBrowserClientAttempt(attemptKey,attempt.clientRequestId);setRecovering(false);setError('');void refreshHistory();}
    else if(['failed','refunded'].includes(task?.state)){clearBrowserClientAttempt(attemptKey,attempt.clientRequestId);setRecovering(false);setError(customerVoiceError(task.error?.message,'原任务未完成，已退回扣费'));}
   }catch(error){if(!alive)return;if(timer)window.clearInterval(timer);setRecovering(false);setRecoveryError(customerVoiceError(error instanceof Error?error.message:'','原任务状态暂时无法读取，请手动重试。'));}};void recover();timer=window.setInterval(()=>void recover(),4000);return()=>{alive=false;if(timer)window.clearInterval(timer);};
  },[generating,attemptKey,token,refreshHistory,recoveryRevision]);
  return (
    <div className="voice-studio-root bg-[var(--vs-bg)] text-[var(--vs-text)]">
      <div className="vs-page-container">
        {/* Hero 徽章 + 标题 + 描述 */}
        <div className="vs-page-hero">
          <div className="vs-page-kicker">VOICE IMITATION</div>
          <h1 className="vs-page-title">
            音色模仿
          </h1>
          <p className="vs-page-description">
            上传 <span className="text-[var(--vs-text)] font-semibold">1-3 条</span> 参考音频，按文案生成相近音色的配音
          </p>
        </div>

        <div className={`mb-5 rounded-xl border px-4 py-3 text-sm ${providerStatus === 'available' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/30 bg-amber-400/10 text-amber-300'}`}>
          {providerStatus === 'checking'
            ? '正在检查音色模仿服务；确认前不会提交生成或产生费用。'
            : providerStatus === 'available'
              ? '音色模仿服务可用。'
              : '音色模仿服务暂时不可用，本次不会提交生成或产生费用。'}
        </div>

        {/* 第 1 行：参考音源 + 音频配置 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* 左：参考音源（最多 3 条） */}
          <div className="bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-5">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--vs-border)] text-xs font-bold text-[var(--vs-primary)]">01</span>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-[var(--vs-text)]">参考音源</h2>
                <p className="text-sm text-[var(--vs-text-muted)] mt-1">
                  上传 1-3 条参考音频，时长范围 14-30 秒
                </p>
              </div>
              <div className="shrink-0 px-3 py-1.5 rounded-full bg-[var(--vs-primary)]/15 border border-[var(--vs-primary)]/30">
                <span className="text-base font-bold text-[var(--vs-primary)]">
                  {references.length} / {MAX_REFERENCES}
                </span>
              </div>
            </div>

            {/* 已选参考列表 */}
            {references.length > 0 && (
              <div className="space-y-2.5 mb-4">
                {references.map((ref, idx) => (
                  <div
                    key={ref.id}
                    className="flex items-center gap-3 p-3.5 rounded-xl bg-[var(--vs-primary)]/5 border border-[var(--vs-primary)]/20"
                  >
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-gradient-to-br from-[var(--vs-primary)] to-[var(--vs-accent)] flex items-center justify-center text-white text-sm font-bold">
                      @{idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-medium text-[var(--vs-text)] truncate">
                        {ref.name || '参考音频'}
                      </p>
                      <p className="text-sm text-[var(--vs-text-muted)] mt-0.5">
                        {ref.source === 'saved' && '已保存音色'}
                        {ref.source === 'link' && '链接提取'}
                        {ref.source === 'upload' && '本地文件'}
                      </p>
                    </div>
                    <button
                      data-workbench-action="secondary"
                      onClick={() => insertTag(idx)}
                      className="shrink-0 px-3 py-1.5 text-sm rounded-lg bg-[var(--vs-primary)]/15 text-[var(--vs-primary)] border border-[var(--vs-primary)]/30 hover:bg-[var(--vs-primary)]/25 transition-colors font-medium"
                      title="在文末插入 @音频N 引用"
                    >
                      引用
                    </button>
                    <button
                      onClick={() => removeReference(ref.id)}
                      className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[var(--vs-text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors text-lg"
                      title="移除"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 添加按钮 / 选择器 */}
            {showSelector ? (
              <div className="rounded-xl border border-[var(--vs-border)] overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--vs-surface)] border-b border-[var(--vs-border)]">
                  <span className="text-sm font-semibold text-[var(--vs-text)]">选择第 {references.length + 1} 条参考音源</span>
                  <button
                    onClick={() => setShowSelector(false)}
                    className="text-sm text-[var(--vs-text-muted)] hover:text-[var(--vs-text)]"
                  >
                    取消
                  </button>
                </div>
                <ReferenceAudioSelector
                  onSelect={addReference}
                  currentAudio={null}
                />
              </div>
            ) : (
              <button
                data-workbench-action="secondary"
                onClick={() => setShowSelector(true)}
                disabled={references.length >= MAX_REFERENCES}
                className="w-full py-3.5 rounded-xl border-2 border-dashed border-[var(--vs-border)] hover:border-[var(--vs-primary)]/50 text-base font-medium text-[var(--vs-text-muted)] hover:text-[var(--vs-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--vs-border)] disabled:hover:text-[var(--vs-text-muted)]"
              >
                {references.length === 0
                  ? '+ 选择第一条参考音频'
                  : references.length >= MAX_REFERENCES
                  ? `✓ 已达上限（${MAX_REFERENCES} 条）`
                  : `+ 添加第 ${references.length + 1} 条参考音频`}
              </button>
            )}

            <p className="mt-4 text-sm text-[var(--vs-text-muted)] leading-relaxed">
              <span className="text-[var(--vs-text)]">使用提示</span>：每条音频不超过 15MB，参考文本越清晰，模仿效果越好。在文案中使用
              <code className="mx-1 px-1.5 py-0.5 rounded bg-[var(--vs-surface)] text-[var(--vs-primary)] font-mono text-[13px]">@音频1</code>
              等可引用对应音色。
            </p>
          </div>

          {/* 右：音频配置 */}
          <div className="bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-5">
              <Settings2 className="h-6 w-6 text-[var(--vs-primary)]" aria-hidden="true" />
              <div className="flex-1">
                <h2 className="text-xl font-bold text-[var(--vs-text)]">音频配置</h2>
                <p className="text-sm text-[var(--vs-text-muted)] mt-1">
                  调整输出音频的格式、采样率和音调
                </p>
              </div>
            </div>

            <div className="space-y-5">
              {/* 语速 */}
              <div>
                <div className="flex justify-between items-center mb-2.5">
                  <label className="text-base font-medium text-[var(--vs-text)]">语速</label>
                  <span className="text-base font-mono text-[var(--vs-primary)]">
                    {audioConfig.speechRate > 0 ? '+' : ''}{audioConfig.speechRate}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="语速"
                  min={-50}
                  max={100}
                  step={5}
                  value={audioConfig.speechRate}
                  onChange={(e) => setAudioConfig((c) => ({ ...c, speechRate: Number(e.target.value) }))}
                  className="w-full accent-[var(--vs-primary)]"
                />
                <div className="flex justify-between text-sm text-[var(--vs-text-muted)] mt-1.5">
                  <span>-50</span>
                  <span>0（默认）</span>
                  <span>+100</span>
                </div>
              </div>

              {/* 音量 */}
              <div>
                <div className="flex justify-between items-center mb-2.5">
                  <label className="text-base font-medium text-[var(--vs-text)]">音量</label>
                  <span className="text-base font-mono text-[var(--vs-primary)]">
                    {audioConfig.loudnessRate > 0 ? '+' : ''}{audioConfig.loudnessRate}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="音量"
                  min={-50}
                  max={100}
                  step={5}
                  value={audioConfig.loudnessRate}
                  onChange={(e) => setAudioConfig((c) => ({ ...c, loudnessRate: Number(e.target.value) }))}
                  className="w-full accent-[var(--vs-primary)]"
                />
                <div className="flex justify-between text-sm text-[var(--vs-text-muted)] mt-1.5">
                  <span>-50</span>
                  <span>0（默认）</span>
                  <span>+100</span>
                </div>
              </div>

              {/* 音调 */}
              <div>
                <div className="flex justify-between items-center mb-2.5">
                  <label className="text-base font-medium text-[var(--vs-text)]">音调</label>
                  <span className="text-base font-mono text-[var(--vs-primary)]">
                    {audioConfig.pitchRate > 0 ? '+' : ''}{audioConfig.pitchRate}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="音调"
                  min={-12}
                  max={12}
                  step={1}
                  value={audioConfig.pitchRate}
                  onChange={(e) => setAudioConfig((c) => ({ ...c, pitchRate: Number(e.target.value) }))}
                  className="w-full accent-[var(--vs-primary)]"
                />
                <div className="flex justify-between text-sm text-[var(--vs-text-muted)] mt-1.5">
                  <span>-12（低沉）</span>
                  <span>0（默认）</span>
                  <span>+12（高亢）</span>
                </div>
              </div>

              {/* 格式 + 采样率 */}
              <div className="grid grid-cols-2 gap-4 pt-3 border-t border-[var(--vs-border)]">
                <div>
                  <label className="text-base font-medium text-[var(--vs-text)] block mb-2.5">输出格式</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {FORMAT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        data-workbench-control="choice"
                        aria-pressed={audioConfig.format === opt.value}
                        onClick={() => setAudioConfig((c) => ({ ...c, format: opt.value }))}
                        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                          audioConfig.format === opt.value
                            ? 'brand-action'
                            : 'bg-[var(--vs-surface)] border-[var(--vs-border)] text-[var(--vs-text-muted)] hover:border-[var(--vs-border)]/80'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-base font-medium text-[var(--vs-text)] block mb-2.5">采样率</label>
                  <select
                    aria-label="采样率"
                    value={audioConfig.sampleRate}
                    onChange={(e) => setAudioConfig((c) => ({ ...c, sampleRate: Number(e.target.value) as AudioConfig['sampleRate'] }))}
                    className="w-full px-3 py-2.5 rounded-lg bg-[var(--vs-surface)] border border-[var(--vs-border)] text-base text-[var(--vs-text)] focus:outline-none focus:border-[var(--vs-primary)]/50"
                  >
                    {SAMPLE_RATE_OPTIONS.map((sr) => (
                      <option key={sr} value={sr}>
                        {sr / 1000}k Hz
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 第 2 行：输入文案（满宽） */}
        <div className="mt-5 bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <PencilLine className="h-6 w-6 text-[var(--vs-primary)]" aria-hidden="true" />
              <h2 className="text-xl font-bold text-[var(--vs-text)]">输入文案</h2>
            </div>
            <span className="text-sm text-[var(--vs-text-muted)]">
              <span className={textPrompt.length > MAX_PROMPT_LEN ? 'text-amber-400 font-medium' : ''}>
                {textPrompt.length}
              </span>
              {' '}/ {MAX_PROMPT_LEN} 字符
            </span>
          </div>
          <textarea
            aria-label="输入文案"
            value={textPrompt}
            onChange={(e) => setTextPrompt(e.target.value.slice(0, MAX_PROMPT_LEN))}
            placeholder={
              references.length > 0
                ? `可用 @音频1 @音频2 @音频3 引用参考音色\n\n例如：@音频1 用温柔的语气说："认知决定财富，思维决定命运。"\n@音频2 用激昂的语气喊："把握机会，成就未来！"`
                : `请先在左侧上传参考音频...\n\n示例：@音频1 用自然流畅的语气朗读：\n认知决定财富，思维决定命运。`
            }
            className="w-full min-h-[200px] rounded-xl border border-[var(--vs-border)] bg-[var(--vs-surface)] px-5 py-4 text-base text-[var(--vs-text)] placeholder:text-[var(--vs-text-muted)]/70 focus:outline-none focus:border-[var(--vs-primary)]/50 resize-y leading-relaxed"
          />
          <div className="flex items-center justify-between mt-3.5">
            <div className="flex flex-wrap gap-2">
              {references.length === 0 ? (
                <p className="text-sm text-[var(--vs-text-muted)]">请先在左侧添加参考音频</p>
              ) : (
                references.map((_, idx) => (
                  <button
                    key={idx}
                    data-workbench-action="secondary"
                    onClick={() => insertTag(idx)}
                    className="px-3 py-1.5 text-sm rounded-lg bg-[var(--vs-primary)]/10 text-[var(--vs-primary)] border border-[var(--vs-primary)]/25 hover:bg-[var(--vs-primary)]/20 transition-colors font-medium"
                  >
                    + @音频{idx + 1}
                  </button>
                ))
              )}
            </div>
            <p className="text-sm text-[var(--vs-text-muted)]">
              单次合成建议 ≤ 400 字符
            </p>
          </div>
        </div>

        {/* 第 3 行：生成按钮 + 结果 */}
        <div className="mt-5 flex flex-col gap-5 min-w-0">
          <p className="text-sm text-[var(--vs-text-muted)]" role={quoteError||recoveryError?'alert':'status'}>{recovering?'正在确认原模仿任务，请勿重复提交。':recoveryError?<>{recoveryError}，为避免重复扣费已关闭新提交。 <button type="button" className="underline" onClick={()=>setRecoveryRevision(value=>value+1)}>重新确认原任务</button></>:quoteError?<>{quoteError}，已关闭提交。 <button type="button" className="underline" onClick={()=>setQuoteRevision(value=>value+1)}>重新读取价格</button></>:quote ? '当前模型：Seed-Audio 1.0 · ¥'+quote.unitPrice+'/分钟，按实际秒数折算。预留 '+quote.reserveCredits+' 积分（最长120秒），完成退差额，失败全退。':'正在读取音色模仿价格…'}</p>
          <div className="flex justify-center">
            <button
              data-workbench-action="primary"
              onClick={handleGenerate}
              disabled={providerStatus !== 'available' || generating || recovering || Boolean(recoveryError) || !quote || !textPrompt.trim() || references.length === 0}
              className="w-full max-w-lg h-14 text-lg font-semibold rounded-2xl brand-action disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {providerStatus === 'checking' ? (
                '正在检查服务状态'
              ) : providerStatus === 'unavailable' ? (
                '音色模仿服务暂不可用'
              ) : generating ? (
                <><svg className="w-6 h-6 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> 生成中...（最长 120 秒）</>
              ) : !textPrompt.trim() ? (
                '请先输入文案'
              ) : references.length === 0 ? (
                '请先选择参考音源'
              ) : (
                '开始模仿'
              )}
            </button>
          </div>

          {error && (
            <div className="bg-red-400/10 border border-red-400/30 rounded-xl p-5 text-base text-red-400">
              {error}
            </div>
          )}

          {result && (
            <div className="bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[var(--vs-primary)] to-[var(--vs-accent)] flex items-center justify-center shadow-[0_0_16px_rgba(124,92,255,0.4)]">
                  <span className="text-white text-2xl">✓</span>
                </div>
                <div>
                  <p className="text-lg font-bold text-[var(--vs-text)]">模仿完成</p>
                  <p className="text-sm text-[var(--vs-text-muted)] mt-0.5">
                    原始时长 {result.originalDuration.toFixed(1)} 秒 · 处理后 {result.duration.toFixed(1)} 秒
                  </p>

                </div>
                <div className="flex items-center gap-2 ml-auto">
                  <button type="button" data-workbench-action="secondary" onClick={() => void downloadOwnedAudio(result.audioUrl, `模仿配音.${audioConfig.format}`).catch(error=>setError(customerVoiceError(error.message,'音频下载暂时不可用')))}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--vs-primary)]/15 text-[var(--vs-primary)] border border-[var(--vs-primary)]/30 hover:bg-[var(--vs-primary)]/25 text-sm font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    下载配音
                  </button>

                </div>
              </div>
              {references.length > 0 && (
                <div className="px-4 py-3 rounded-lg bg-[var(--vs-accent)]/5 border border-[var(--vs-accent)]/15 text-sm text-[var(--vs-accent)]/90 leading-relaxed">
                  模仿结果只用于本次配音，不会创建克隆音色。下载后可直接作为 AI 数字人视频改口型的配音音频。
                </div>
              )}
              <div className="bg-[var(--vs-bg)]/40 rounded-xl p-5 border border-[var(--vs-border)]">
                <AudioPlayer audioUrl={result.audioUrl} />
              </div>
            </div>
          )}

          {/* 生成历史记录 */}
          {(history.length > 0 || historyError) && (
            <div className="bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-[var(--vs-text)]">📋 生成历史</h3>
                <button
                  data-workbench-action="secondary"
                  onClick={() => void refreshHistory()}
                  className="text-sm text-[var(--vs-text-muted)] hover:text-red-400 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-400/10"
                >
                  刷新记录
                </button>
              </div>
              {historyError && (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3" role="alert">
                  <span className="text-sm text-amber-300">{historyError}</span>
                  <button
                    type="button"
                    onClick={() => void refreshHistory()}
                    className="shrink-0 rounded-lg border border-amber-300/40 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-300/10"
                  >
                    重新读取历史
                  </button>
                </div>
              )}
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1 custom-scroll">
                {history.map((item, idx) => (
                  <div key={item.generationId} className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--vs-surface)]/40 border border-[var(--vs-border)]/40 hover:bg-[var(--vs-surface)]/70 group transition-colors">
                    <span className="text-sm text-[var(--vs-text-muted)] w-7 text-center shrink-0 font-mono">{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-base text-[var(--vs-text)] truncate">{item.text}</p>
                      <p className="text-sm text-[var(--vs-text-muted)] mt-0.5">
                        {item.terminalState==='failed_unknown'?'待核对 · ':item.status==='failed'?'未完成 · ':item.status==='processing'?'处理中 · ':''}{item.refNames.length ? `${item.refNames.join(' · ')} · ` : ''}{item.duration?`${item.duration}秒 · `:''}{item.time}
                      </p>
                      {item.status==='failed'&&<p className="mt-1 text-xs text-amber-400">{item.terminalState==='failed_unknown'?'任务终态尚未确认，需先完成核对，当前禁止重试':item.retryEligible===true?(item.errorMessage||'生成未完成')+'；参考音频不会从历史自动恢复。':item.retryUnavailableReason||'缺少明确的未扣费或已退款证明，暂不能安全重试'}</p>}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                      {item.status==='success'&&item.audioUrl&&item.assetId?<button
                        onClick={() => setResult({audioUrl:item.audioUrl!,duration:item.duration,originalDuration:item.duration,assetId:item.assetId!,generationId:item.generationId})}
                        className="w-8 h-8 rounded-md flex items-center justify-center text-[var(--vs-text-muted)] hover:text-[var(--vs-primary)] hover:bg-[var(--vs-primary)]/10 transition-colors"
                        title="试听"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.14v14l11-7-11-7z" />
                        </svg>
                      </button>:item.status==='failed'&&item.retryEligible===true?<button type="button" className="rounded-md border border-amber-400/30 px-2 py-1 text-xs text-amber-300" onClick={()=>{setTextPrompt(item.text.slice(0,MAX_PROMPT_LEN));setResult(null);setError('已载入失败记录的文案；请重新选择参考音频并确认当前价格后再提交。历史载入不会自动生成。');}}>载入文案</button>:null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
