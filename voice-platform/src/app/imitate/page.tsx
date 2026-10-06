'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import AudioPlayer from '@/components/AudioPlayer';
import ReferenceAudioSelector from '@/components/ReferenceAudioSelector';

export default function ImitatePage() {
  const router = useRouter();
  const [textPrompt, setTextPrompt] = useState('');
  const [selectedAudio, setSelectedAudio] = useState<{
    url: string; name: string; source: 'saved' | 'link' | 'upload'; file?: File;
  } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ audioUrl: string; duration: number; originalDuration: number } | null>(null);
  const [error, setError] = useState('');



  // 生成历史（localStorage，最多20条）
  interface HistoryItem {
    text: string;
    refName: string;
    audioUrl: string;
    duration: number;
    time: string;
  }
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try { return JSON.parse(localStorage.getItem('imitate_history') || '[]'); } catch { return []; }
  });

  // 生成
  const handleGenerate = async () => {
    if (!textPrompt.trim()) { setError('请输入文案/提示词'); return; }

    setGenerating(true);
    setResult(null);
    setError('');
    try {
      const body: Record<string, unknown> = {
        textPrompt: textPrompt.trim(),
      };

      if (selectedAudio) {
        if (selectedAudio.file) {
          // 本地文件转 base64
          const buf = await selectedAudio.file.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          body.audioData = base64;
        } else if (selectedAudio.url) {
          body.audioUrl = selectedAudio.url;
        }
      }

      const res = await fetch('/voice-platform/api/audio-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.success) {
        const newResult = {
          audioUrl: d.data.audioUrl,
          duration: d.data.duration,
          originalDuration: d.data.originalDuration,
        };
        setResult(newResult);

        // 保存到历史记录
        const item: HistoryItem = {
          text: textPrompt.trim().slice(0, 60),
          refName: selectedAudio?.name || '参考音频',
          audioUrl: d.data.audioUrl,
          duration: d.data.duration,
          time: new Date().toLocaleString('zh-CN'),
        };
        setHistory(prev => {
          const next = [item, ...prev].slice(0, 20);
          localStorage.setItem('imitate_history', JSON.stringify(next));
          return next;
        });
      } else {
        setError(d.message || '生成失败');
      }
    } catch (err: any) {
      setError(err.message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* 标题 */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-rose-400 to-pink-600 mb-4 shadow-lg shadow-rose-500/30">
          <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path d="M15 4.5V2m0 2.5a3 3 0 110 6m0-6a3 3 0 000 6m-5 3a7 7 0 0114 0" strokeLinecap="round" opacity="0.6"/>
            <path d="M8 14l-4 4m0 0l1 1m-1-1l-1 1" strokeWidth={2.5}/>
          </svg>
        </div>
        <h1 className="text-4xl font-bold text-vp-foreground">音色模仿</h1>
        <p className="text-vp-muted-foreground mt-2 text-sm">Seed-Audio-1.0 · 支持已保存/链接提取/上传 · 一键模仿任意音色</p>
      </div>

      {/* ===== 第1行：参考音源（已保存/链接/上传 三合一下拉） ===== */}
      <div className="bg-vp-card/80 rounded-2xl border border-rose-400/15 p-6 mb-6">
        <h3 className="text-lg font-semibold text-rose-200 mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-rose-400/15 flex items-center justify-center text-rose-300 text-xs font-bold">1</span>
          参考音源
          <span className="text-[10px] text-vp-muted-foreground font-normal ml-auto">支持 mp3/wav/mp4 · ≤10MB · 建议人声清晰</span>
        </h3>

        <ReferenceAudioSelector
          onSelect={(audio) => setSelectedAudio(audio)}
          currentAudio={selectedAudio}
        />

        {/* 已选择参考音频的预览 */}
        {selectedAudio && (
          <div className="mt-4 p-4 rounded-xl border border-rose-400/20 bg-rose-400/5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-rose-400/10 flex items-center justify-center">
                <span className="text-rose-400 text-lg">🎤</span>
              </div>
              <div>
                <p className="text-sm text-slate-200">{selectedAudio.name || '参考音频'}</p>
                <p className="text-[10px] text-vp-muted-foreground">
                  {selectedAudio.source === 'saved' && '💾 已保存'}
                  {selectedAudio.source === 'link' && '📎 链接提取'}
                  {selectedAudio.source === 'upload' && '📁 本地文件'}
                  {' · 将作为 @音频1 参考音色'}
                </p>
              </div>
              <button
                onClick={() => setSelectedAudio(null)}
                className="ml-auto text-xs text-vp-muted-foreground hover:text-red-400"
              >
                移除
              </button>
            </div>
            {/* 如果是本地文件，显示音频播放器 */}
            {selectedAudio.source === 'upload' && selectedAudio.file && (
              <div className="mt-3 bg-slate-950/40 rounded-lg p-3 border border-rose-400/10">
                <AudioPlayer audioUrl={selectedAudio.url} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== 第2行：文案输入 ===== */}
      <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6 mb-6">
        <h3 className="text-lg font-semibold text-vp-foreground mb-4 flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-sky-400/15 flex items-center justify-center text-vp-primary text-xs font-bold">2</span>
          输入文案
          <span className="text-[10px] text-vp-muted-foreground font-normal ml-auto">
            正文建议≤400字 · @音频1 引用参考音色 · 太长会加速不清
          </span>
        </h3>
        <textarea
          value={textPrompt}
          onChange={(e) => setTextPrompt(e.target.value)}
          placeholder={`@音频1 请用自然流畅的语气朗读下面的文案：\n\n认知决定财富，思维决定命运。`}
          rows={5}
          className={`w-full rounded-xl border bg-vp-background/60 px-4 py-3 text-sm text-slate-200 placeholder:text-vp-muted-foreground focus:outline-none resize-none ${
            textPrompt.replace(/@音频\d\s*/g, '').length > 400
              ? 'border-amber-400/40 focus:border-amber-400'
              : 'border-vp-border focus:border-rose-400/40'
          }`}
        />
        <div className="flex justify-between mt-2">
          <div className="flex gap-2">
            {selectedAudio && (
              <button
                onClick={() => setTextPrompt(prev => prev + ' @音频1')}
                className="px-2 py-0.5 text-[10px] rounded-md bg-rose-400/10 text-rose-300 border border-rose-400/20 hover:bg-rose-400/20"
              >
                @音频1
              </button>
            )}
          </div>
          <p className={`text-xs ${
            textPrompt.replace(/@音频\d\s*/g, '').length > 400
              ? 'text-amber-400'
              : 'text-vp-muted-foreground'
          }`}>
            正文 {textPrompt.replace(/@音频\d\s*/g, '').length}/400
            <span className="text-slate-700"> · 总 {textPrompt.length}/3000</span>
          </p>
        </div>
        {textPrompt.replace(/@音频\d\s*/g, '').length > 400 && (
          <div className="p-2 rounded-lg bg-amber-400/5 border border-amber-400/10 text-[10px] text-amber-300/70">
            ⚠️ 合成文本超过400字符可能导致语速加快、吐字不清。建议精简或分段生成。
          </div>
        )}

        {/* 生成按钮 - 融入卡片 */}
        <button
          onClick={handleGenerate}
          disabled={generating || !textPrompt.trim()}
          className="w-full mt-4 py-3 rounded-xl bg-gradient-to-r from-rose-500 to-pink-600 text-white text-sm font-bold hover:from-rose-400 hover:to-pink-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-rose-500/20 flex items-center justify-center gap-2"
        >
          {generating ? (
            <><svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> 生成中... (最长等待120秒)</>
          ) : !textPrompt.trim() ? (
            '📝 请先输入文案'
          ) : (
            '🎬 开始模仿 · Seed-Audio-1.0'
          )}
        </button>
      </div>

      {/* ===== 第3行：结果 ===== */}
      <div className="space-y-6">

        {error && (
          <div className="bg-red-400/5 border border-red-400/20 rounded-xl p-4 text-sm text-red-400">{error}</div>
        )}

        {/* 结果 */}
        {result && (
          <div className="bg-vp-card/80 rounded-2xl border border-rose-400/20 p-6 animate-slideUp">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-400 to-pink-600 flex items-center justify-center shadow-lg shadow-rose-500/30">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-vp-foreground">模仿完成</p>
                <p className="text-xs text-vp-muted-foreground">原始时长 {result.originalDuration.toFixed(1)}秒 · 处理后 {result.duration.toFixed(1)}秒</p>
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <a
                  href={result.audioUrl}
                  download="模仿配音.wav"
                  target="_blank"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-500/15 text-rose-200 border border-rose-400/20 hover:bg-rose-500/25 text-xs font-medium transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  下载配音
                </a>
                {selectedAudio && (
                  <button
                    onClick={() => {
                      // 跳转到声音复刻页，预填参考音频
                      const params = new URLSearchParams();
                      params.set('refAudioUrl', selectedAudio.url);
                      params.set('refAudioName', selectedAudio.name);
                      router.push('/clone?' + params.toString());
                    }}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-500/15 text-vp-primary border border-vp-border hover:bg-sky-500/25 text-xs font-medium transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    训练为专属音色
                  </button>
                )}
              </div>
            </div>
            {/* 训练提示 */}
            {selectedAudio && (
              <div className="mb-4 px-3 py-2 rounded-lg bg-sky-400/5 border border-sky-400/10 text-[10px] text-vp-primary/70">
                💡 满意这个音色？点击「训练为专属音色」将跳转到声音复刻，训练后可获得固定 speakerId，在语音合成页面反复使用。
              </div>
            )}
            <div className="bg-slate-950/40 rounded-xl p-4 border border-rose-400/10">
              <AudioPlayer audioUrl={result.audioUrl} />
            </div>
          </div>
        )}

        {/* 生成历史记录 */}
        {history.length > 0 && (
          <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-vp-foreground">📋 生成历史</h3>
              <button
                onClick={() => {
                  setHistory([]);
                  localStorage.removeItem('imitate_history');
                }}
                className="text-[10px] text-vp-muted-foreground hover:text-red-400 transition-colors"
              >
                清空记录
              </button>
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1 custom-scroll">
              {history.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-vp-background/40 border border-slate-700/30 group">
                  <span className="text-[10px] text-vp-muted-foreground w-5 text-center shrink-0">{idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-vp-foreground truncate">{item.text}</p>
                    <p className="text-[10px] text-vp-muted-foreground">
                      🎤 {item.refName} · {item.duration}秒 · {item.time}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                    {/* 试听 */}
                    <button
                      onClick={() => {
                        const a = new Audio(item.audioUrl);
                        a.play().catch(() => {});
                      }}
                      className="w-6 h-6 rounded-md flex items-center justify-center text-vp-muted-foreground hover:text-sky-400 hover:bg-sky-400/10 transition-colors"
                      title="试听"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5.14v14l11-7-11-7z" />
                      </svg>
                    </button>
                    {/* 下载 */}
                    <a
                      href={item.audioUrl}
                      download={`模仿配音_${idx + 1}.wav`}
                      className="w-6 h-6 rounded-md flex items-center justify-center text-vp-muted-foreground hover:text-sky-400 hover:bg-sky-400/10 transition-colors"
                      title="下载"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
