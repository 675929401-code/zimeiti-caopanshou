'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SpeechVoicePicker } from './SpeechVoicePicker';
import dynamic from 'next/dynamic';
import type { HumanAsset } from './client-state';
import styles from '@/app/digital-human/workspace.module.css';
import { useApp } from '@/contexts/app-context';
import { fingerprintPendingAudioPayload, readPendingAudioAttempt, writePendingAudioAttempt, type PendingAudioAttempt } from './pending-audio-attempt';
const RechargeDialog = dynamic(() => import('@/components/recharge-dialog').then(module => module.RechargeDialog), { ssr: false });

type Voice = { id: string; name: string; description: string; group: string; speakerId: string; engine: string; model: string; resourceId: string; gender?:string };
type SpeechDraft = { text: string; voiceId: string; speed: number; applied: string; assetId: string; attempt?: PendingAudioAttempt };
const empty: SpeechDraft = { text: '', voiceId: '', speed: 1, applied: '', assetId: '' };
const fingerprint = (draft: SpeechDraft) => fingerprintPendingAudioPayload([draft.text.trim(), draft.voiceId, draft.speed]);
type Props = { userId: string; token: string; disabled: boolean; maxSeconds: number; audio: HumanAsset | null; onAudio: (asset: HumanAsset) => void; onReady: (ready: boolean) => void; onPending: (pending: boolean) => void };
const customerSpeechError = (value: unknown, fallback: string) => {
  const detail = typeof value === 'string' ? value.trim() : '';
  if (/API|HTTP|provider|供应商|上游|渠道|密钥|后台|数据库|迁移|作业键|预占|终态|落库/iu.test(detail)) return fallback;
  return detail || fallback;
};

export function SpeechComposer({ userId, token, disabled, maxSeconds, audio, onAudio, onReady, onPending }: Props) {
  const { fetchCredits, state } = useApp();
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const key = `digital-human:speech:v1:${userId}`;
  const [draft, setDraft] = useState<SpeechDraft>(empty), [ready, setReady] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]), [credits, setCredits] = useState<number | null>(null);
  const [quote, setQuote] = useState<number | null>(null), [quoteStamp, setQuoteStamp] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [cloneRemaining, setCloneRemaining] = useState(0);
  const [cloneSynthesis, setCloneSynthesis] = useState(false), [loading, setLoading] = useState(true), [storageFailure, setStorageFailure] = useState(false);
  const [recoveredAssetId, setRecoveredAssetId] = useState('');
  const current = useRef(draft), alive = useRef(true), processing = useRef(false), onAudioRef = useRef(onAudio);
  useEffect(() => { onAudioRef.current = onAudio; }, [onAudio]);
  const headers = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const store = useCallback((next: SpeechDraft) => {
    try { writePendingAudioAttempt(localStorage, key, next.attempt); }
    catch {
      if (next.attempt) { setStorageFailure(true); setError('浏览器无法保存配音任务编号，本次尚未提交'); return false; }
    }
    if (next.text !== current.current.text || next.voiceId !== current.current.voiceId || next.speed !== current.current.speed) setRecoveredAssetId('');
    current.current = next; setDraft(next); return true;
  }, [key]);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/digital-human/voices', { headers: headers(), cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      if (!alive.current) return;
      setVoices(data.voices); setCredits(data.credits); setCloneRemaining(data.cloneRemaining); setCloneSynthesis(data.cloneSynthesisAvailable);
      void fetchCredits();
      if (!current.current.voiceId && data.voices.length) store({ ...current.current, voiceId: data.voices[0].id });
    } catch { if (alive.current) setError('音色暂时无法读取，请刷新音色列表'); }
    finally { if (alive.current) setLoading(false); }
  }, [headers, store, fetchCredits]);
  useEffect(() => {
    alive.current = true;
    try { const attempt = readPendingAudioAttempt(localStorage, key); current.current = { ...empty, attempt }; setDraft(current.current); }
    catch { setStorageFailure(true); setError('原配音任务编号暂时无法读取，请保留本页'); }
    setReady(true); void load(); return () => { alive.current = false; };
  }, [key, load]);
  const stamp = fingerprint(draft);
  const matched = !!audio && ((audio.id === draft.assetId && stamp === draft.applied) || audio.id === recoveredAssetId);
  useEffect(() => { onReady(matched && !draft.attempt); }, [matched, draft.attempt, onReady]);
  useEffect(() => { onPending(Boolean(draft.attempt)); }, [draft.attempt, onPending]);
  useEffect(() => {
    setQuote(null);
    if (!ready || !draft.text.trim() || !draft.voiceId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/digital-human/voices?' + new URLSearchParams({ chars: String(draft.text.trim().length), voiceId: draft.voiceId }), { headers: headers(), cache: 'no-store' });
        const data = await response.json(); if (!cancelled && response.ok) { setQuote(data.quote?.credits ?? null); setQuoteStamp(stamp); setCredits(data.credits); }
      } catch { /* Submission remains unavailable until a current quote arrives. */ }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [ready, stamp, draft.text, draft.voiceId, headers]);
  const recover = useCallback(async () => {
    const attempt = current.current.attempt;
    if (!attempt || processing.current) return;
    processing.current = true;
    try {
      const response = await fetch('/api/voice/generation-status?' + new URLSearchParams({ clientRequestId: attempt.key, phase: 'tts' }), { headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const result = await response.json(); if (!alive.current || current.current.attempt?.key !== attempt.key) return;
      if (!response.ok) { setMessage('正在查询原配音任务，无需重复合成'); return; }
      const task = result.data;
      if (task.state === 'completed' && task.assetId) {
        const assetResponse = await fetch('/api/digital-human/assets?id=' + encodeURIComponent(task.assetId), { headers: headers(), cache: 'no-store' });
        const assetResult = await assetResponse.json(); if (!alive.current) return;
        if (!assetResponse.ok || !assetResult.assets?.[0]) {
          setError(customerSpeechError(assetResult.error, '配音已保存在智音工坊，但暂时无法用于数字人，请稍后重试读取'));
          setMessage('配音合成已完成，不会自动再次合成或扣费');
          if (assetResponse.status === 422) store({ ...current.current, attempt: undefined, assetId: '', applied: '' });
          return;
        }
        const asset = assetResult.assets[0] as HumanAsset;
        if (store({ ...current.current, applied: attempt.fingerprint, assetId: asset.id, attempt: undefined })) {
          setRecoveredAssetId(asset.id);
          onAudioRef.current(asset); setMessage(`配音已就绪 · ${asset.duration.toFixed(1)} 秒 · 实际扣费 ${task.chargedCredits || 0} 积分`); setError(''); void load();
        }
      } else if (task.state === 'failed_unknown') {
        setMessage('原配音结果尚未确认，请在智音工坊查看任务记录；本页不会重复合成');
      } else if (['refunded', 'failed'].includes(task.state)) {
        setError('配音未生成成功，请在智音工坊查看任务与积分退款记录');
        store({ ...current.current, attempt: undefined }); setMessage(''); void load();
      } else setMessage('配音合成中，完成后自动用于当前数字人');
    } catch { if (alive.current) setMessage('连接暂时中断，正在继续查询原配音'); }
    finally { processing.current = false; }
  }, [headers, store, load]);
  const activeAttemptKey = draft.attempt?.key;
  useEffect(() => {
    if (!activeAttemptKey) return;
    void recover(); const timer = setInterval(() => void recover(), 4000); return () => clearInterval(timer);
  }, [activeAttemptKey, recover]);
  async function generate() {
    if (disabled || current.current.attempt || storageFailure || quote == null || quoteStamp !== stamp) return;
    const voice = voices.find(item => item.id === draft.voiceId); if (!voice) return;
    const attempt = { key: `digital-speech-${crypto.randomUUID()}`, fingerprint: stamp };
    if (!store({ ...draft, attempt })) return;
    setError(''); setMessage('正在合成配音…');
    try {
      const response = await fetch('/api/voice/tts', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ text: draft.text.trim(), speakerId: voice.speakerId, engine: voice.engine, model: voice.model, resourceId: voice.resourceId, speed: draft.speed, format: 'mp3', client_request_id: attempt.key }) });
      const data = await response.json(); if (!alive.current) return;
      if (!response.ok && [400, 401, 402, 403, 404, 422, 429].includes(response.status) && !data.data?.requestId) {
        store({ ...current.current, attempt: undefined }); setError(response.status === 402 ? '本站积分不足，请充值积分后再合成' : customerSpeechError(data.message || data.error, '配音提交未完成，请检查设置')); setMessage('');
      } else void recover();
    } catch { if (alive.current) setMessage('正在确认原配音任务，请勿重复提交'); }
  }
  const busy = disabled || !!draft.attempt;
  return <div className={styles.speech} aria-label="智音工坊配音">
    <div className={styles.sectionLabel}><span>智音工坊 · 直接配音</span><button type="button" onClick={() => setRechargeOpen(true)}>积分充值</button><button type="button" disabled={loading || busy} onClick={() => { setLoading(true); void load(); }}>刷新音色</button></div>
    <SpeechVoicePicker userId={userId} token={token} voices={voices} value={draft.voiceId} disabled={busy||!ready} onChange={voiceId=>store({...draft,voiceId})}/>
    <label className={styles.field}>人物台词<textarea aria-label="数字人配音文案" maxLength={5000} rows={6} placeholder="输入希望人物说出的内容。先试听配音，再生成视频。" disabled={busy || !ready} value={draft.text} onChange={event => store({ ...draft, text: event.target.value })} /></label>
    <p className={styles.hint}>当前视频模型最长 {maxSeconds} 秒，请控制台词长度，并在合成后试听确认。</p>
    <div className={styles.speechControls}><label>语速<select aria-label="配音语速" value={draft.speed} disabled={busy} onChange={event => store({ ...draft, speed: Number(event.target.value) })}>{[0.8, 1, 1.2, 1.5].map(speed => <option key={speed} value={speed}>{speed}×{speed === 1 ? ' 标准' : ''}</option>)}</select></label><span>{draft.text.length} / 5000 字符</span></div>
    <div className={styles.speechActions}><div><strong>{draft.attempt ? '正在处理原配音' : quote != null && quoteStamp === stamp ? `本次配音 ${quote} 积分` : '输入文案后显示配音费用'}</strong><small>{`本站积分 ${credits == null ? '读取中' : credits}`} · 合成失败自动退回</small></div><button className={styles.secondaryPrimary} type="button" disabled={busy || storageFailure || !ready || !draft.text.trim() || quote == null || quoteStamp !== stamp || (credits ?? 0) < quote || !voices.some(v => v.id === draft.voiceId)} onClick={() => void generate()}>{draft.attempt ? '正在合成…' : matched ? '重新合成' : '合成配音'}</button></div>
    {message && <p className={styles.hint} role="status">{message}</p>}
    {error && <p className={styles.inlineError} role="alert">{error}</p>}
    {audio && <div className={styles.audioResult}><audio aria-label="试听生成配音" src={audio.url} controls preload="metadata" /><span>{matched ? '已用于当前数字人' : '文案或音色已改变，请重新合成配音'}</span></div>}
    {draft.attempt && <button type="button" onClick={() => void recover()}>查询原配音</button>}
    <Link className={styles.subtleLink} href="/voice-studio/workspace">在智音工坊查看全部配音记录 →</Link>
    {rechargeOpen && <RechargeDialog open={rechargeOpen} onOpenChange={setRechargeOpen} mode="credits" credits={credits || 0} cashBalance={state.cashBalance} onCreditsUpdated={value => { setCredits(value); void fetchCredits(); }} />}
  </div>;
}
