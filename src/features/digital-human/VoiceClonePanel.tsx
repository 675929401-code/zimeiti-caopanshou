'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import styles from '@/app/digital-human/workspace.module.css';

export function VoiceClonePanel({ userId, token, disabled, remaining, synthesisAvailable, onComplete }: {
  userId: string; token: string; disabled: boolean; remaining: number; synthesisAvailable: boolean; onComplete: () => void;
}) {
  const key = `digital-human:clone:v1:${userId}`;
  const [sample, setSample] = useState<File | null>(null), [name, setName] = useState('我的数字人声音');
  const [license, setLicense] = useState(''), [jobKey, setJobKey] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const checking = useRef(false), active = useRef(true), complete = useRef(onComplete); complete.current = onComplete;
  const headers = useCallback(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);
  useEffect(() => { active.current = true; try { setJobKey(localStorage.getItem(key) || ''); setReady(true); } catch { setError('原声音训练记录暂时无法读取'); } return () => { active.current = false; }; }, [key]);
  const check = useCallback(async () => {
    if (!jobKey || checking.current) return; checking.current = true;
    try {
      const response = await fetch('/api/voice/status', { method: 'POST', headers: headers(), body: JSON.stringify({ jobKey, operationKind: 'clone' }), signal: AbortSignal.timeout(15000) });
      const result = await response.json(); if (!active.current) return;
      if (result.data?.status === 'ready' || result.data?.terminal) {
        localStorage.removeItem(key); setJobKey('');
        if (result.data?.status === 'ready') { setNotice('音色训练完成，已同步智音工坊。请在“我的音色”中选择使用。'); complete.current(); }
        else setError(result.message || '训练未完成，授权已释放');
      } else setNotice('正在查询原声音训练任务，完成后自动同步音色');
    } catch { if (active.current) setNotice('连接暂时中断，正在继续查询原声音训练'); }
    finally { checking.current = false; }
  }, [headers, jobKey, key]);
  useEffect(() => { if (!jobKey) return; void check(); const timer = setInterval(() => void check(), 5000); return () => clearInterval(timer); }, [jobKey, check]);
  async function activate() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/voice/license', { method: 'POST', headers: headers(), body: JSON.stringify({ licenseKey: license.trim() }) });
      const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.message || '授权未激活');
      setLicense(''); setNotice('声音克隆授权已激活'); complete.current();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '授权暂时无法激活'); } finally { setBusy(false); }
  }
  async function clone() {
    if (!sample || !name.trim() || busy || jobKey || disabled || !remaining || !ready || !synthesisAvailable) return;
    setBusy(true); setError(''); setNotice('正在上传声音样本');
    let submitted = false, original = '';
    try {
      const form = new FormData(); form.append('file', sample); form.append('name', name.trim());
      const upload = await fetch('/api/voice/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      const uploaded = await upload.json(); if (!upload.ok || !uploaded.voice?.id) throw new Error(uploaded.message || uploaded.error || '样本上传失败');
      original = `digital-clone-${crypto.randomUUID()}`;
      localStorage.setItem(key, original); if (localStorage.getItem(key) !== original) throw new Error('浏览器无法保存原声音训练任务，本次尚未提交训练');
      setJobKey(original); submitted = true;
      const response = await fetch('/api/voice/clone', { method: 'POST', headers: { ...headers(), 'Idempotency-Key': original }, signal: AbortSignal.timeout(180000), body: JSON.stringify({ referenceAudioId: uploaded.voice.id, voiceName: name.trim(), engine: 'volcano', language: 'zh', clientRequestId: original }) });
      const result = await response.json(); if (!active.current) return;
      if (!response.ok && ([400, 401, 402, 403, 404, 413, 415, 422].includes(response.status) || result.data?.terminal)) {
        localStorage.removeItem(key); setJobKey(''); submitted = false; throw new Error(result.message || '声音训练尚未提交，请检查授权及样本');
      }
      setNotice('样本已提交，正在确认训练结果');
    } catch (cause) { if (!submitted) setError(cause instanceof Error ? cause.message : '声音样本上传失败'); else setNotice('正在确认原声音训练任务，请勿重复提交'); }
    finally { setBusy(false); }
  }
  const locked = disabled || busy || !!jobKey || !ready;
  return <details className={styles.clone}><summary>使用自己的声音 <span>上传样本 · 克隆音色</span></summary>
    <p className={styles.hint}>上传清晰的单人讲话录音，训练完成后可反复用于配音。每次训练占用 1 次本站声音克隆授权；配音另按积分计费。</p>
    <p className={styles.hint}>可用训练次数：{remaining}{!synthesisAvailable ? ' · 克隆音色合成尚未开通，可先使用常用音色' : ''}</p>
    {!remaining && <div className={styles.activation}><input aria-label="声音克隆授权码" type="password" autoComplete="off" placeholder="输入已有的声音克隆授权码" value={license} disabled={locked} onChange={event => setLicense(event.target.value)} /><button type="button" disabled={locked || !license.trim()} onClick={() => void activate()}>激活授权</button><Link href="/voice-studio/clone">获取声音克隆授权 →</Link></div>}
    <label className={styles.field}>音色名称<input value={name} maxLength={100} disabled={locked} onChange={event => setName(event.target.value)} /></label>
    <label className={styles.uploadButton}><input type="file" aria-label="上传声音样本" accept=".mp3,.wav,.m4a,.aac,.ogg,.opus" disabled={locked} onChange={event => { const file = event.target.files?.[0]; if (file && file.size > 15 * 1024 * 1024) { setError('声音样本最大为 15 MB'); return; } setSample(file || null); }} />{sample ? sample.name : '选择声音样本 · 最大 15 MB'}</label>
    <button className={styles.secondaryPrimary} type="button" disabled={locked || !sample || !name.trim() || !remaining || !synthesisAvailable} onClick={() => void clone()}>{jobKey ? '声音训练中…' : '创建我的音色'}</button>
    {notice && <p className={styles.hint} role="status">{notice}</p>}{error && <p className={styles.inlineError} role="alert">{error}</p>}
    {jobKey && <button type="button" onClick={() => void check()}>查询原声音训练</button>}
  </details>;
}
