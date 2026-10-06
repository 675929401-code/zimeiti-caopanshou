'use client';

import React, { useState } from 'react';
import Button from '@/components/ui/Button';
import AudioPlayer from '@/components/AudioPlayer';

interface LinkCloneFormProps {
  onCloneSuccess?: (result: { speakerId: string; videoTitle: string; status: number }) => void;
}

export default function LinkCloneForm({ onCloneSuccess }: LinkCloneFormProps) {
  const [url, setUrl] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [duration, setDuration] = useState(20);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    speakerId: string;
    videoTitle: string;
    videoCover: string;
    status: number;
    demoAudio?: string;
  } | null>(null);
  const [parsing, setParsing] = useState(false);
  const [videoPreview, setVideoPreview] = useState<{
    title: string;
    cover: string;
    platform: string;
  } | null>(null);

  const handleParseLink = async () => {
    if (!url.trim()) { setError('请输入视频链接'); return; }
    setError('');
    setParsing(true);
    setStatus('正在解析视频链接...');

    try {
      // 解析凭据只保留在服务器环境变量中，浏览器仅调用本域受认证接口。
      const token = localStorage.getItem('auth_token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch('/api/voice/link-clone/extract-audio', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: url.trim() }),
      });
      const payload = await res.json().catch(() => ({}));
      const data = payload.data ?? payload;

      if (res.ok && data?.audioUrl) {
        setVideoPreview({
          title: data.title || '未知标题',
          cover: data.cover || '',
          platform: detectPlatform(url),
        });
        setStatus('视频解析成功！点击"开始克隆"');
      } else {
        setError(payload.message || payload.error || '视频解析失败，请检查链接是否正确');
      }
    } catch {
      setError('链接解析失败，请检查网络');
    } finally {
      setParsing(false);
    }
  };

  const handleClone = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    setStatus('正在提取音频并提交克隆...');
    setResult(null);

    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/voice-platform/api/voice/link-clone', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url: url.trim(),
          name: voiceName.trim() || undefined,
          duration,
        }),
      });

      const data = await res.json();

      if (data.success) {
        setResult(data.data);
        setStatus('链接克隆成功！');
        // 如果状态不是已完成，启动轮询
        if (data.data.status !== 2 && data.data.status !== 4) {
          setStatus('训练中，正在等待完成...');
          pollCloneStatus(data.data.speakerId);
        }
        onCloneSuccess?.(data.data);
      } else {
        setError(data.message || '克隆失败');
        setStatus('');
      }
    } catch {
      setError('网络错误，请重试');
      setStatus('');
    } finally {
      setLoading(false);
    }
  };

  const handleUseVoice = () => {
    if (result?.speakerId) {
      window.location.href = `/voice-platform/workspace?speaker=${encodeURIComponent(result.speakerId)}&preload=true`;
    }
  };

  // 轮询克隆训练状态
  const pollCloneStatus = async (speakerId: string) => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await fetch(`/voice-platform/api/voice/status?speakerId=${speakerId}`);
        const data = await res.json();
        if (data.success) {
          const s = data.data.status;
          if (s === 2 || s === 4) {
            setStatus('克隆完成！');
            const demo = data.data.speakerStatus?.[0]?.demoAudio || '';
            setResult(prev => prev ? { ...prev, demoAudio: demo, status: s } : null);
            setLoading(false);
            return;
          }
          setStatus(`训练中...(${i+1}/60)`);
        }
      } catch {}
    }
    setError('训练超时，请稍后在「我的定制」中查看结果');
    setLoading(false);
  };

  const handleReset = () => {
    setUrl('');
    setVoiceName('');
    setVideoPreview(null);
    setResult(null);
    setStatus('');
    setError('');
  };

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      {/* 提示信息 */}
      <div className="bg-amber-400/5 border border-amber-400/15 rounded-2xl p-4 text-xs text-amber-300/80">
        <p className="font-medium mb-1">📋 使用说明</p>
        <p>粘贴小红书/抖音短视频分享链接，系统自动提取视频中的人声并生成克隆音色。</p>
        <p className="mt-1">要求：人声清晰、单人发言、时长不少于14秒。音频会自动截取前30秒。</p>
        <p className="mt-1 text-amber-400/50">⚠️ 仅供个人学习研究，请勿用于商业目的。</p>
      </div>

      {/* 链接输入 */}
      <div>
        <label className="block text-sm font-medium text-vp-foreground mb-2">
          短视频链接
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://v.douyin.com/xxxxx 或 https://www.xiaohongshu.com/..."
            className="flex-1 rounded-xl bg-vp-card/80 border border-vp-border px-4 py-3 text-sm text-vp-foreground placeholder-slate-600 focus:border-sky-400 focus:ring-2 focus:ring-vp-primary/20 focus:outline-none"
            disabled={loading}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={handleParseLink}
            loading={parsing}
            disabled={!url.trim() || loading}
            className="shrink-0"
          >
            解析
          </Button>
        </div>
      </div>

      {/* 视频预览（解析成功后显示） */}
      {videoPreview && (
        <div className="rounded-2xl border border-vp-border bg-vp-card/60 p-4 flex items-center gap-4">
          {videoPreview.cover && (
            <img
              src={videoPreview.cover}
              alt=""
              className="w-16 h-16 rounded-xl object-cover shrink-0"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-vp-foreground truncate">{videoPreview.title}</p>
            <p className="text-xs text-vp-muted-foreground mt-1">
              <span className="inline-flex items-center rounded-md px-2 py-0.5 bg-sky-300/10 text-vp-primary border border-vp-border">
                {videoPreview.platform}
              </span>
            </p>
          </div>
        </div>
      )}

      {/* 音色名称 + 截取时长 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-vp-foreground mb-2">
            音色名称（可选）
          </label>
          <input
            type="text"
            value={voiceName}
            onChange={(e) => setVoiceName(e.target.value)}
            placeholder="如：科普大叔"
            maxLength={30}
            className="w-full rounded-xl bg-vp-card/80 border border-vp-border px-4 py-3 text-sm text-vp-foreground placeholder-slate-600 focus:border-sky-400 focus:ring-2 focus:ring-vp-primary/20 focus:outline-none"
            disabled={loading}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-vp-foreground mb-2">
            截取秒数（14-30秒）
          </label>
          <input
            type="number"
            value={duration}
            onChange={(e) => setDuration(Math.max(14, Math.min(30, Number(e.target.value))))}
            min={14}
            max={30}
            className="w-full rounded-xl bg-vp-card/80 border border-vp-border px-4 py-3 text-sm text-vp-foreground focus:border-sky-400 focus:ring-2 focus:ring-vp-primary/20 focus:outline-none"
            disabled={loading}
          />
        </div>
      </div>

      {/* 操作按钮 */}
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={loading}
        onClick={handleClone}
        disabled={!url.trim() || loading}
      >
        {loading ? status || '处理中...' : '🚀 开始克隆'}
      </Button>

      {/* 状态提示 */}
      {status && !error && (
        <div className="bg-sky-300/8 border border-vp-border rounded-xl p-4 text-sm text-vp-primary text-center">
          {loading && (
            <div className="w-8 h-8 mx-auto mb-2 rounded-full bg-sky-300/10 flex items-center justify-center">
              <svg className="w-4 h-4 text-vp-primary animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          )}
          {status}
        </div>
      )}

      {/* 错误 */}
      {error && (
        <div className="bg-rose-500/8 border border-rose-400/15 rounded-xl p-4 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* 成功结果 */}
      {result && (
        <div className="space-y-4 animate-slideUp">
          <div className="text-center py-4">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-cyan-400 to-indigo-600 mb-3 shadow-lg shadow-cyan-500/30">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-vp-foreground">克隆成功！</h3>
            <p className="text-sm text-vp-muted-foreground mt-1">
              {result.videoTitle && `来源: ${result.videoTitle}`}
            </p>
          </div>

          <div className="bg-vp-card/80 border border-vp-border rounded-2xl p-5">
            {/* 试听 */}
            {result.demoAudio && (
              <div className="mb-4">
                <div className="text-xs text-vp-muted-foreground mb-2 uppercase tracking-wider">Demo 试听</div>
                <AudioPlayer audioUrl={result.demoAudio} />
              </div>
            )}

            {/* speakerId 复制 */}
            <div className="flex items-center gap-2 bg-slate-950/40 rounded-xl px-3 py-2.5 border border-vp-border">
              <span className="text-xs text-vp-muted-foreground shrink-0">speakerId:</span>
              <code className="text-xs font-mono text-vp-primary flex-1 truncate">{result.speakerId}</code>
              <button
                onClick={() => { navigator.clipboard.writeText(result.speakerId); }}
                className="text-xs px-2 py-1 bg-cyan-400/15 text-cyan-200 rounded-md hover:bg-cyan-400/25 transition-colors shrink-0"
              >
                复制
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <Button variant="primary" onClick={handleUseVoice}>🚀 立即使用</Button>
              {result.demoAudio && (
                <a href={result.demoAudio} download target="_blank" className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold border border-vp-border text-vp-primary bg-sky-400/5 hover:bg-sky-400/10 transition-colors">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                  下载 Demo
                </a>
              )}
              <Button variant="outline" onClick={handleReset}>继续克隆</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function detectPlatform(url: string): string {
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) return '小红书';
  if (url.includes('douyin.com') || url.includes('v.douyin.com')) return '抖音';
  return '其他平台';
}
