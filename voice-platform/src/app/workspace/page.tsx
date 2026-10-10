'use client';

import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Button from '@/components/ui/Button';
import Slider from '@/components/ui/Slider';
import Select from '@/components/ui/Select';
import VoiceCard from '@/components/VoiceCard';
import AudioPlayer from '@/components/AudioPlayer';
import { setRunningTask, clearRunningTask } from '@/components/GlobalTaskBar';
import {
  RESOURCE_IDS,
  MODEL_VERSIONS,
  AUDIO_FORMATS,
  SAMPLE_RATES,
  EXPLICIT_LANGUAGES,
  EXPLICIT_DIALECTS,
  isCommandSupported,
  isDialectSupported,
} from '@/lib/voices-data';

// 顶部静态导入保持不变（Button/Slider/Select 很小且各处复用）

interface Voice {
  id: string;
  speakerId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  gender: string;
}

const SAMPLE_TEXTS = [
  { label: '新闻播报', text: '各位观众晚上好，今天是2026年7月19日，欢迎收看今天的新闻联播。' },
  { label: '广告配音', text: '限时特惠，全场五折起！错过今天，再等一年！赶快行动吧！' },
  { label: '有声阅读', text: '夜色渐浓，城市的灯火次第亮起。每个人都在为自己的生活奔波，从未停歇。' },
  { label: '情感独白', text: '你知道吗，有时候我真的很想你。但我知道，我们已经回不去了。' },
  { label: '客服播报', text: '您好，欢迎致电智音客服中心。普通话请按1，For English please press 2。' },
  { label: '故事讲述', text: '从前有一座山，山上有一座庙，庙里有一个老和尚和一个小和尚。' },
];

const DUAL_SAMPLE_TEXTS = [
  { label: '客服对话', text1: '您好，请问有什么可以帮您的？', text2: '我想咨询一下退款的事情。' },
  { label: '情感对白', text1: '你知道吗，我一直在等你。', text2: '对不起，我已经有了新的生活。' },
  { label: '商务洽谈', text1: '王总，这个方案我们考虑了很久。', text2: '说说你的想法吧，我很感兴趣。' },
];

function WorkspaceContent() {
  const searchParams = useSearchParams();
  const preloadSpeaker = searchParams.get('speaker');
  const preloadFlag = searchParams.get('preload');

  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(false); // 延迟加载，不阻塞首屏
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [selectedVoice2, setSelectedVoice2] = useState<Voice | null>(null);
  const [search, setSearch] = useState('');
  const [search2, setSearch2] = useState('');
  const [category, setCategory] = useState('全部');
  const [text, setText] = useState('');
  const [text2, setText2] = useState('');
  const [ssml, setSsml] = useState('');
  const [useSsml, setUseSsml] = useState(false);

  // 基础参数
  const [pitch, setPitch] = useState(0);
  const [speed, setSpeed] = useState(0);             // -12~12（向后兼容）
  const [volume, setVolume] = useState(0);           // -12~12
  const [synthesizing, setSynthesizing] = useState(false);
  const [result, setResult] = useState<{ audioUrl: string; duration: number; subtitles?: Array<{ text: string; startMs: number; endMs: number }>; logId?: string } | null>(null);
  const [error, setError] = useState('');
  const [model, setModel] = useState<'tts' | 'audio'>('tts');
  const [mode, setMode] = useState<'single' | 'dual' | 'long-text' | 'mix' | 'audio-gen'>('single');

  // SSE 流式合成开关（边生成边播放）
  const [sseStream, setSseStream] = useState(false);
  const [sseProgress, setSseProgress] = useState<string[]>([]);

  // 长文本异步任务
  const [longTextTaskId, setLongTextTaskId] = useState<string | null>(null);
  const [longTextStatus, setLongTextStatus] = useState<'idle' | 'submitted' | 'processing' | 'success' | 'failed'>('idle');
  const [longTextAudioUrl, setLongTextAudioUrl] = useState<string | null>(null);
  const [longTextSentences, setLongTextSentences] = useState<Array<{ text: string; startMs: number; endMs: number }>>([]);

  // 混音 mix_speaker
  const [mixVoices, setMixVoices] = useState<Array<{ voice: Voice | null; factor: number }>>([
    { voice: null, factor: 0.5 },
    { voice: null, factor: 0.5 },
  ]);

  // 音频生成 (Seed-Audio-1.0)
  const [audioGenText, setAudioGenText] = useState('');       // 提示词（支持@音频N）
  const [audioGenLinks, setAudioGenLinks] = useState<string[]>([]); // 抖音/小红书链接
  const [audioGenRefs, setAudioGenRefs] = useState<Array<{ url: string; name: string; extracting: boolean }>>([]); // 已提取的参考音频
  const [audioGenLoading, setAudioGenLoading] = useState(false);
  const [audioGenResult, setAudioGenResult] = useState<{ audioUrl: string; duration: number } | null>(null);

  // 从链接提取参考音频
  const extractAudioFromLink = async (link: string) => {
    setAudioGenLinks(prev => [...prev, link]);
    const idx = audioGenRefs.length;
    setAudioGenRefs(prev => [...prev, { url: '', name: '提取中...', extracting: true }]);
    try {
      const res = await fetch('/voice-platform/api/voice/link-clone/extract-audio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(localStorage.getItem('auth_token')
            ? { Authorization: `Bearer ${localStorage.getItem('auth_token')}` }
            : {}),
        },
        body: JSON.stringify({ url: link }),
      });
      const d = await res.json();
      if (d.success) {
        setAudioGenRefs(prev => prev.map((r, i) => i === idx ? { url: d.data.audioUrl, name: d.data.title || `参考音频${idx + 1}`, extracting: false } : r));
      } else {
        setAudioGenRefs(prev => prev.map((r, i) => i === idx ? { ...r, name: '提取失败', extracting: false } : r));
      }
    } catch {
      setAudioGenRefs(prev => prev.map((r, i) => i === idx ? { ...r, name: '提取失败', extracting: false } : r));
    }
  };

  // 音色分类
  const [voiceFilter, setVoiceFilter] = useState<'all' | 'favorites' | 'cloned' | 'designed'>('all');
  const [voiceFilter2, setVoiceFilter2] = useState<'all' | 'favorites' | 'cloned' | 'designed'>('all');
  const [myFavorites, setMyFavorites] = useState<Set<string>>(new Set());
  const [isLoggedIn, setIsLoggedIn] = useState(true); // 随主站登录，不需要独立验证

  // 高级参数（新增，对齐官方文档）
  const [resourceId, setResourceId] = useState('seed-tts-2.0');
  const [modelVersion, setModelVersion] = useState('seed-tts-2.0-expressive');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [sampleRate, setSampleRate] = useState(24000);
  const [emotion, setEmotion] = useState('');
  const [emotionScale, setEmotionScale] = useState(1);
  const [enableSubtitle, setEnableSubtitle] = useState(false);
  const [enableTimestamp, setEnableTimestamp] = useState(false);

  // additions 高级
  const [contextTexts, setContextTexts] = useState('');  // 语音指令（每行一条）
  const [explicitLanguage, setExplicitLanguage] = useState('');
  const [explicitDialect, setExplicitDialect] = useState('');
  const [silenceDuration, setSilenceDuration] = useState(0);
  const [sectionId, setSectionId] = useState('');
  const [enableLanguageDetector, setEnableLanguageDetector] = useState(false);
  const [disableMarkdownFilter, setDisableMarkdownFilter] = useState(false);
  const [disableEmojiFilter, setDisableEmojiFilter] = useState(false);
  const [enableLatexTn, setEnableLatexTn] = useState(false);
  const [enableAigcWatermark, setEnableAigcWatermark] = useState(false);
  const [useCache, setUseCache] = useState(true);
  const [autoSplit, setAutoSplit] = useState(false);

  // 折叠面板
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showAdditions, setShowAdditions] = useState(false);

  // 合成历史（localStorage缓存）— 初始化延迟到 useEffect 避免阻塞首次渲染
  interface HistoryItem { text: string; speaker: string; audioUrl: string; time: string; duration: number; }
  const [history, setHistory] = useState<HistoryItem[]>([]);
  useEffect(() => {
    try { setHistory(JSON.parse(localStorage.getItem('tts_history') || '[]')); } catch {}
  }, []);
  const saveToHistory = (item: HistoryItem) => {
    setHistory(prev => {
      const next = [item, ...prev].slice(0, 20);
      localStorage.setItem('tts_history', JSON.stringify(next));
      return next;
    });
  };

  // 历史记录播放控制
  const playingAudioRef = useRef<HTMLAudioElement | null>(null);

  // 使用频率统计（localStorage）
  const getUsageCount = (speakerId: string): number => {
    try { const m: Record<string,number> = JSON.parse(localStorage.getItem('voice_usage')||'{}'); return m[speakerId] || 0; } catch { return 0; }
  };
  const recordUsage = (speakerId: string) => {
    try {
      const m: Record<string,number> = JSON.parse(localStorage.getItem('voice_usage')||'{}');
      m[speakerId] = (m[speakerId] || 0) + 1;
      localStorage.setItem('voice_usage', JSON.stringify(m));
    } catch {}
  };

  useEffect(() => {
    // 使用 requestIdleCallback 或 setTimeout 延迟数据加载，避免阻塞页面切换动画
    const timer = setTimeout(() => {
      setLoading(true);
      fetchVoices();
      checkLogin();
    }, 50); // 50ms 延迟，足够 Next.js 完成路由切换
    return () => clearTimeout(timer);
  }, []);

  const checkLogin = () => {
    setIsLoggedIn(true);
    // 1. 优先从 localStorage 加载收藏（无token时兜底）
    try {
      const favs = JSON.parse(localStorage.getItem('voice_favorites') || '[]');
      if (favs.length > 0) setMyFavorites(new Set(favs));
    } catch {}
    // 2. 再尝试从 API 同步
    const token = localStorage.getItem('token');
    if (token) fetchFavorites(token);
  };

  // 在工作台快速收藏/取消收藏
  const toggleFavoriteInWorkspace = async (voiceId: string) => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const voice = voices.find(v => v.id === voiceId);
    if (!voice) return;
    const isFav = myFavorites.has(voice.speakerId);
    try {
      const res = await fetch(`/voice-platform/api/voices/${voiceId}/favorite`, {
        method: isFav ? 'DELETE' : 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setMyFavorites(prev => {
          const next = new Set(prev);
          if (isFav) next.delete(voice.speakerId);
          else next.add(voice.speakerId);
          return next;
        });
      }
    } catch {}
  };

  const fetchFavorites = async (token: string) => {
    try {
      const res = await fetch('/voice-platform/api/voices/favorites?limit=200', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success && data.data.favorites) {
        const ids = new Set<string>(data.data.favorites.map((f: any) => f.voice.speakerId));
        setMyFavorites(ids);
      }
    } catch {
      // 静默
    }
  };

  const fetchVoices = async () => {
    try {
      const params = new URLSearchParams({ limit: '500' }); // 加载全部442个音色
      if (voiceFilter === 'cloned' || voiceFilter === 'designed') {
        params.set('type', voiceFilter === 'cloned' ? 'cloned' : 'designed');
        params.set('mine', 'true');
      }

      const token = localStorage.getItem('token');
      const headers: Record<string,string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`/voice-platform/api/voices?${params}`, { headers });
      const data = await res.json();
      if (data.success) {
        let voiceList = data.data.voices || [];
        // 排序：推荐置顶 → 收藏优先 → 使用频率高靠前 → 其余按名称
        voiceList = voiceList.sort((a: any, b: any) => {
          const aRec = a.isRecommended ? 1 : 0;
          const bRec = b.isRecommended ? 1 : 0;
          if (aRec !== bRec) return bRec - aRec;
          const aFav = myFavorites.has(a.speakerId) ? 1 : 0;
          const bFav = myFavorites.has(b.speakerId) ? 1 : 0;
          if (aFav !== bFav) return bFav - aFav;
          const aUse = getUsageCount(a.speakerId);
          const bUse = getUsageCount(b.speakerId);
          if (aUse !== bUse) return bUse - aUse;
          return (a.name || '').localeCompare(b.name || '');
        });
        setVoices(voiceList);
        if (preloadFlag && preloadSpeaker) {
          const target = voiceList.find((v: any) => v.speakerId === preloadSpeaker);
          if (target) {
            setSelectedVoice(target);
            if (voiceList.length > 1) {
              const second = voiceList.find((v: any) => v.id !== target.id) || voiceList[1];
              setSelectedVoice2(second);
            }
            setText('你好，这是我的新声音，希望能为你带来好的体验。');
            return;
          }
        }
        if (voiceList.length > 0 && !selectedVoice) setSelectedVoice(voiceList[0]);
        if (voiceList.length > 1 && !selectedVoice2) setSelectedVoice2(voiceList[1]);
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  // 当筛选条件变化时重新加载
  useEffect(() => {
    if (!loading) fetchVoices();
  }, [voiceFilter]);

  // 客户端过滤（搜索 + 收藏）
  const filteredVoices = voices.filter((v) => {
    if (search && !v.name.includes(search) && !v.speakerId.includes(search)) return false;
    if (voiceFilter === 'favorites' && !myFavorites.has(v.speakerId)) return false;
    return true;
  });

  // 角色二音色过滤
  const filteredVoices2 = voices.filter((v) => {
    if (search2 && !v.name.includes(search2) && !v.speakerId.includes(search2)) return false;
    if (voiceFilter2 === 'favorites' && !myFavorites.has(v.speakerId)) return false;
    return true;
  });

  // 当前音色是否支持语音指令
  const commandSupported = selectedVoice ? isCommandSupported(selectedVoice?.speakerId) : false;
  const dialectSupported = selectedVoice ? isDialectSupported(selectedVoice?.speakerId) : false;

  const handleSynthesize = async () => {
    if (useSsml && !ssml.trim()) { setError('请输入 SSML 文本'); return; }
    if (!useSsml && !text.trim()) { setError('请输入合成文本'); return; }
    if (!selectedVoice) { setError('请选择一个音色'); return; }
    if (mode === 'dual' && (!text2.trim() || !selectedVoice2)) {
      setError('双人模式需要填写两个角色的文本和音色'); return;
    }
    setError('');
    setSynthesizing(true);
    setResult(null);

    // 注册全局任务（切换页面不中断）
    const taskId = `tts_${Date.now()}`;
    setRunningTask({
      taskId,
      text: text.slice(0, 50),
      speaker: selectedVoice?.name || selectedVoice?.speakerId || '',
      startTime: Date.now(),
      page: '/workspace',
    });

    const endpoint = model === 'audio' ? '/voice-platform/api/tts/generate-audio' : '/voice-platform/api/tts/synthesize';

    try {
      const contextTextsArray = contextTexts
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      const body: Record<string, unknown> = {
        speaker: selectedVoice?.speakerId,
        mode,
        ...(modelVersion !== 'auto' && { model: modelVersion }),
        resourceId,
        pitch,
        speed,
        volume,
        format: audioFormat,
        sampleRate,
        emotion,
        emotionScale,
        enableSubtitle,
        enableTimestamp,
        explicitLanguage,
        explicitDialect,
        silenceDuration,
        sectionId,
        enableLanguageDetector,
        disableMarkdownFilter,
        disableEmojiFilter,
        enableLatexTn,
        enableAigcWatermark,
        useCache,
        autoSplit,
      };

      if (contextTextsArray.length > 0 && commandSupported) {
        body.contextTexts = contextTextsArray;
      }

      if (useSsml) {
        body.ssml = ssml;
        delete body.text;
      } else {
        body.text = text;
      }

      if (mode === 'dual' && selectedVoice2) {
        body.text2 = text2;
        body.speaker2 = selectedVoice2.speakerId;
      }

      if (model === 'audio') {
        body.textPrompt = text;
        delete body.text;
        delete body.speaker;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        const r = {
          audioUrl: data.data.audioUrl,
          duration: data.data.duration,
          subtitles: data.data.subtitles,
          logId: data.data.logId,
        };
        setResult(r);
        try {
          recordUsage(selectedVoice?.speakerId || '');
          saveToHistory({ text: text.slice(0, 50), speaker: selectedVoice?.name || '', audioUrl: r.audioUrl, time: new Date().toLocaleTimeString(), duration: r.duration });
        } catch { /* 静默 */ }
      } else {
        setError(data.message || '合成失败');
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setSynthesizing(false);
      clearRunningTask();
    }
  };

  // SSE 流式合成 - 边生成边播放
  const handleSseSynthesize = async () => {
    if (!text.trim()) { setError('请输入合成文本'); return; }
    if (!selectedVoice) { setError('请选择一个音色'); return; }
    setError('');
    setSynthesizing(true);
    setResult(null);
    setSseProgress([]);

    try {
      const contextTextsArray = contextTexts.split('\n').map(s => s.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        speaker: selectedVoice?.speakerId,
        ...(modelVersion !== 'auto' && { model: modelVersion }),
        resourceId,
        text,
        pitch,
        speed,
        volume,
        format: audioFormat,
        sampleRate,
        emotion,
        emotionScale,
        enableSubtitle,
        enableTimestamp,
        explicitLanguage,
        explicitDialect,
        silenceDuration,
        sectionId,
        enableLanguageDetector,
        disableMarkdownFilter,
        disableEmojiFilter,
        enableLatexTn,
        enableAigcWatermark,
        useCache,
        autoSplit,
      };
      if (contextTextsArray.length > 0 && commandSupported) body.contextTexts = contextTextsArray;

      const res = await fetch('/voice-platform/api/tts/stream-sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) { setError('SSE 连接失败'); setSynthesizing(false); return; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const audioChunks: ArrayBuffer[] = [];
      const subtitles: Array<{ text: string; startMs: number; endMs: number }> = [];
      let buffer = '';
      let logId: string | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            const eventType = line.slice(7).trim();
            setSseProgress(prev => [...prev, `收到事件: ${eventType}`]);
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (!dataStr) continue;
            try {
              const evt = JSON.parse(dataStr);
              if (evt.event === 352 && evt.data?.audio) {
                // base64 音频块
                const binary = atob(evt.data.audio);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                audioChunks.push(bytes.buffer);
              } else if (evt.event === 351) {
                // 句子结束
                if (evt.data?.text) {
                  subtitles.push({
                    text: evt.data.text,
                    startMs: evt.data?.start_ms || 0,
                    endMs: evt.data?.end_ms || 0,
                  });
                }
              } else if (evt.event === 153) {
                setError(`合成错误: ${evt.data?.message || '未知错误'}`);
              }
              if (evt.data?.event_id === 0 && evt.data?.extra_info?.request_id) {
                logId = evt.data.extra_info.request_id;
              }
            } catch { /* skip non-JSON */ }
          }
        }
      }

      if (audioChunks.length > 0) {
        const blob = new Blob(audioChunks, { type: `audio/${audioFormat}` });
        const url = URL.createObjectURL(blob);
        const duration = subtitles.length > 0 ? subtitles[subtitles.length - 1].endMs / 1000 : 0;
        setResult({ audioUrl: url, duration, subtitles: subtitles.length > 0 ? subtitles : undefined, logId });
        saveToHistory({ text: text.slice(0, 50), speaker: selectedVoice?.name || selectedVoice?.speakerId || '', audioUrl: url, time: new Date().toLocaleTimeString(), duration });
        setSseProgress(prev => [...prev, `✅ 合成完成，共 ${audioChunks.length} 个音频块`]);
      } else {
        setError('未收到音频数据');
      }
    } catch {
      setError('SSE 流式合成失败，请重试');
    } finally {
      setSynthesizing(false);
    }
  };

  // 长文本异步合成 - 提交任务
  const handleLongTextSubmit = async () => {
    if (!text.trim()) { setError('请输入合成文本'); return; }
    if (!selectedVoice) { setError('请选择一个音色'); return; }
    if (text.length > 100000) { setError('长文本最大支持 100,000 字'); return; }
    setError('');
    setSynthesizing(true);
    setLongTextStatus('idle');
    setLongTextTaskId(null);
    setLongTextAudioUrl(null);
    setLongTextSentences([]);

    try {
      const contextTextsArray = contextTexts.split('\n').map(s => s.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        speaker: selectedVoice?.speakerId,
        ...(modelVersion !== 'auto' && { model: modelVersion }),
        resourceId,
        text,
        pitch,
        speed,
        volume,
        format: audioFormat,
        sampleRate,
        emotion,
        emotionScale,
        enableSubtitle: true,
        enableTimestamp: true,
        autoSplit: true,
      };
      if (contextTextsArray.length > 0 && commandSupported) body.contextTexts = contextTextsArray;

      const res = await fetch('/voice-platform/api/tts/long-text/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setLongTextTaskId(data.data.taskId);
        setLongTextStatus('submitted');
        // 开始轮询
        pollLongTextTask(data.data.taskId);
      } else {
        setError(data.message || '提交失败');
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setSynthesizing(false);
      clearRunningTask();
    }
  };

  // 长文本轮询查询
  const pollLongTextTask = async (taskId: string) => {
    let attempts = 0;
    const maxAttempts = 120; // 最多查询120次（约10分钟）
    const poll = async () => {
      if (attempts >= maxAttempts) { setLongTextStatus('failed'); setError('查询超时，请稍后手动查询'); return; }
      attempts++;
      try {
        const res = await fetch('/voice-platform/api/tts/long-text/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId }),
        });
        const data = await res.json();
        if (data.success) {
          const status = data.data.taskStatus;
          if (status === 2) {
            // 成功
            setLongTextStatus('success');
            setLongTextAudioUrl(data.data.audioUrl);
            setLongTextSentences(data.data.sentences || []);
          } else if (status === 3 || status === 4) {
            // 失败
            setLongTextStatus('failed');
            setError(`合成失败: ${data.data.message || '服务端错误'}`);
          } else {
            // 0=队列中 1=处理中
            setLongTextStatus('processing');
            setTimeout(poll, 5000); // 5秒后再次查询
          }
        }
      } catch {
        setTimeout(poll, 5000);
      }
    };
    poll();
  };

  // 混音合成
  const handleMixSynthesize = async () => {
    if (!text.trim()) { setError('请输入合成文本'); return; }
    const validVoices = mixVoices.filter(mv => mv.voice);
    if (validVoices.length < 2) { setError('混音至少需要选择 2 个音色'); return; }
    if (validVoices.length > 3) { setError('混音最多支持 3 个音色'); return; }
    const factorSum = validVoices.reduce((sum, mv) => sum + mv.factor, 0);
    if (Math.abs(factorSum - 1) > 0.01) { setError(`混音比例之和必须等于 1.0，当前为 ${factorSum.toFixed(2)}`); return; }

    setError('');
    setSynthesizing(true);
    setResult(null);

    try {
      const body = {
        text,
        mixSpeakers: validVoices.map(mv => ({
          speaker: mv.voice!.speakerId,
          factor: mv.factor,
        })),
        model: modelVersion,
        resourceId,
        pitch,
        speed,
        volume,
        format: audioFormat,
        sampleRate,
      };

      const res = await fetch('/voice-platform/api/tts/mix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        const r = {
          audioUrl: data.data.audioUrl,
          duration: data.data.duration,
          logId: data.data.logId,
        };
        setResult(r);
        try {
          recordUsage(selectedVoice?.speakerId || "");
          saveToHistory({ text: text.slice(0, 50), speaker: selectedVoice?.name || '', audioUrl: r.audioUrl, time: new Date().toLocaleTimeString(), duration: r.duration });
        } catch { /* 静默 */ }
      } else {
        setError(data.message || '混音合成失败');
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setSynthesizing(false);
      clearRunningTask();
    }
  };

  // 统一合成入口 - 根据模式分发
  const handleSynthesizeAll = () => {
    if (mode === 'long-text') {
      handleLongTextSubmit();
    } else if (mode === 'mix') {
      handleMixSynthesize();
    } else if (sseStream && mode === 'single') {
      handleSseSynthesize();
    } else {
      handleSynthesize();
    }
  };

  // 字幕格式化为 SRT
  const formatSrt = (subtitles: Array<{ text: string; startMs: number; endMs: number }>) => {
    const fmt = (ms: number) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const msec = ms % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(msec).padStart(3, '0')}`;
    };
    return subtitles.map((s, i) => `${i + 1}\n${fmt(s.startMs)} --> ${fmt(s.endMs)}\n${s.text}\n`).join('\n');
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-6">
          <div className="skeleton h-8 w-48" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-4"><div className="skeleton h-64" /></div>
            <div className="lg:col-span-2 space-y-4"><div className="skeleton h-48" /></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-vp-foreground mb-6">语音合成工作台</h1>

      {/* 第1段：左窄右宽工作区 */}
      <div className="flex flex-col lg:flex-row gap-6 items-stretch">
        {/* 左栏：音色选择（窄） */}
        <div className="lg:w-1/3 flex flex-col gap-5">
          {/* 模型选择 */}
          <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-5">
            <h3 className="text-sm font-semibold text-vp-foreground mb-3">模型选择</h3>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setModel('tts')}
                className={`p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  model === 'tts' ? 'border-indigo-500 bg-sky-300/10 text-vp-primary' : 'border-vp-border text-vp-muted-foreground hover:border-vp-border'
                }`}
              >
                Doubao-TTS 2.0
              </button>
              <button
                onClick={() => setModel('audio')}
                className={`p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  model === 'audio' ? 'border-indigo-500 bg-sky-300/10 text-vp-primary' : 'border-vp-border text-vp-muted-foreground hover:border-vp-border'
                }`}
              >
                seed-audio 1.0
              </button>
            </div>
          </div>

          {/* 配音模式 */}
          <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-5">
            <h3 className="text-sm font-semibold text-vp-foreground mb-3">配音模式</h3>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setMode('single')}
                className={`p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  mode === 'single' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-vp-border text-vp-muted-foreground hover:border-vp-border'
                }`}
              >
                🎤 单人模式
              </button>
              <button
                onClick={() => setMode('dual')}
                className={`p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  mode === 'dual' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-vp-border text-vp-muted-foreground hover:border-vp-border'
                }`}
              >
                🎭 双人对话
              </button>
              <button
                onClick={() => setMode('long-text')}
                className={`p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  mode === 'long-text' ? 'border-amber-500 bg-amber-50 text-amber-700' : 'border-vp-border text-vp-muted-foreground hover:border-vp-border'
                }`}
              >
                📝 长文本异步
              </button>
              <button
                onClick={() => setMode('mix')}
                className={`p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  mode === 'mix' ? 'border-purple-500 bg-purple-50 text-purple-700' : 'border-vp-border text-vp-muted-foreground hover:border-vp-border'
                }`}
              >
                🎵 混音合成
              </button>
              <button
                onClick={() => setMode('audio-gen')}
                className={`p-3 rounded-xl border-2 text-sm font-medium transition-all ${
                  mode === 'audio-gen' ? 'border-rose-500 bg-rose-50 text-rose-700' : 'border-vp-border text-vp-muted-foreground hover:border-vp-border'
                }`}
              >
                🎬 音频生成
              </button>
            </div>
            {/* SSE 流式开关（仅单人模式可用） */}
            {mode === 'single' && (
              <label className="flex items-center gap-2 text-sm mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sseStream}
                  onChange={(e) => setSseStream(e.target.checked)}
                  className="rounded"
                />
                <span className="text-vp-foreground">⚡ SSE 流式合成（边生成边播放，适合长段落实时体验）</span>
              </label>
            )}
            {mode === 'long-text' && (
              <p className="text-xs text-amber-400/80 mt-2">支持最长 100,000 字异步合成，提交后自动轮询查询结果</p>
            )}
            {mode === 'mix' && (
              <p className="text-xs text-purple-400/80 mt-2">混合 2-3 个音色，比例之和需 = 1.0（仅 TTS 1.0）</p>
            )}
          </div>

          {/* 音色选择 - Speaker 1 */}
          <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-5 flex flex-col flex-1 min-h-0">
            <h3 className="text-sm font-semibold text-vp-foreground mb-3">
              {mode === 'dual' ? '角色一 音色' : '选择音色'}
            </h3>
            <div className="space-y-3">
              <input
                type="text" placeholder="搜索音色名称或ID..." value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-vp-border px-4 py-2 text-sm focus:border-sky-400 focus:ring-2 focus:ring-vp-primary/20 focus:outline-none"
              />

              {/* 单一音色分类下拉 */}
              <div>
                <label className="text-xs text-vp-muted-foreground mb-1 block">音色分类</label>
                <Select
                  options={[
                    { value: 'all', label: '全部音色（含内置/克隆/设计）' },
                    { value: 'favorites', label: '我的收藏' },
                    { value: 'cloned', label: '克隆音色' },
                    { value: 'designed', label: '我的设计' },
                  ]}
                  value={voiceFilter}
                  onChange={(e) => {
                    setVoiceFilter(e.target.value as any);
                  }}
                />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 overflow-y-auto pr-1 flex-1 min-h-0">
              {filteredVoices.map((voice) => (
                <VoiceCard
                  key={voice.id} id={voice.id} speakerId={voice.speakerId} name={voice.name}
                  category={voice.category} gender={voice.gender}
                  selected={selectedVoice?.id === voice.id}
                  onSelect={() => setSelectedVoice(voice)} compact
                  isFavorite={myFavorites.has(voice.speakerId)}
                  onToggleFavorite={() => toggleFavoriteInWorkspace(voice.id)}
                />
              ))}
              {filteredVoices.length === 0 && (
                <div className="col-span-2 text-center py-8 text-sm text-vp-muted-foreground">没有找到匹配的音色</div>
              )}
            </div>
          </div>

          {/* 角色二 音色（双人模式） */}
          {mode === 'dual' && (
            <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-5 flex flex-col flex-1 min-h-0">
              <h3 className="text-sm font-semibold text-vp-foreground mb-3">角色二 音色</h3>
              <div className="space-y-3">
                <input
                  type="text" placeholder="搜索音色名称或ID..." value={search2}
                  onChange={(e) => setSearch2(e.target.value)}
                  className="w-full rounded-xl border border-vp-border px-4 py-2 text-sm focus:border-sky-400 focus:ring-2 focus:ring-vp-primary/20 focus:outline-none"
                />

                {/* 音色分类下拉 */}
                <div>
                  <label className="text-xs text-vp-muted-foreground mb-1 block">音色分类</label>
                  <Select
                    options={[
                      { value: 'all', label: '全部音色（含内置/克隆/设计）' },
                      { value: 'favorites', label: '我的收藏' },
                      { value: 'cloned', label: '克隆音色' },
                      { value: 'designed', label: '我的设计' },
                    ]}
                    value={voiceFilter2}
                    onChange={(e) => {
                      setVoiceFilter2(e.target.value as any);
                    }}
                  />
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 flex-1 min-h-0 overflow-y-auto pr-1">
                {filteredVoices2.map((voice) => (
                  <VoiceCard
                    key={voice.id} id={voice.id} speakerId={voice.speakerId} name={voice.name}
                    category={voice.category} gender={voice.gender}
                    selected={selectedVoice2?.id === voice.id}
                    onSelect={() => setSelectedVoice2(voice)} compact
                    isFavorite={myFavorites.has(voice.speakerId)}
                    onToggleFavorite={() => toggleFavoriteInWorkspace(voice.id)}
                  />
                ))}
                {filteredVoices2.length === 0 && (
                  <div className="col-span-2 text-center py-8 text-sm text-vp-muted-foreground">没有找到匹配的音色</div>
                )}
              </div>
            </div>
          )}

          {/* 混音音色配置 - 已移至右栏高级设置下方 */}

          {/* 基础参数 - 已移至右栏高级设置 */}
          <div className="hidden">
            <h3 className="text-sm font-semibold text-vp-foreground">基础参数调节</h3>
            <Slider label="音调 pitch (-12~12)" min={-12} max={12} value={pitch} onChange={setPitch} />
            <Slider label="语速 speed (-12~12，自动映射 -50~100)" min={-12} max={12} value={speed} onChange={setSpeed} />
            <Slider label="音量 volume (-12~12，自动映射 -50~100)" min={-12} max={12} value={volume} onChange={setVolume} />
          </div>

          {/* 高级参数 - 已移至右栏 */}
          <div className="hidden">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between text-sm font-semibold text-vp-foreground"
            >
              <span>🎵 高级音频参数（情感/格式/采样率/字幕）</span>
              <span className="text-vp-muted-foreground">{showAdvanced ? '▼' : '▶'}</span>
            </button>
            {showAdvanced && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="text-xs text-vp-muted-foreground">资源 ID（X-Api-Resource-Id）</label>
                  <Select
                    options={RESOURCE_IDS.map(r => ({ value: r.value, label: r.label }))}
                    value={resourceId}
                    onChange={(e) => setResourceId(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-vp-muted-foreground">模型版本（仅 TTS2.0/ICL2.0 生效）</label>
                  <Select
                    options={MODEL_VERSIONS.map(r => ({ value: r.value, label: r.label }))}
                    value={modelVersion}
                    onChange={(e) => setModelVersion(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-vp-muted-foreground">音频格式</label>
                  <Select
                    options={AUDIO_FORMATS.map(r => ({ value: r.value, label: r.label }))}
                    value={audioFormat}
                    onChange={(e) => setAudioFormat(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-vp-muted-foreground">采样率</label>
                  <Select
                    options={SAMPLE_RATES.map(r => ({ value: String(r), label: `${r} Hz` }))}
                    value={String(sampleRate)}
                    onChange={(e) => setSampleRate(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="text-xs text-vp-muted-foreground">语种（explicit_language）</label>
                  <Select
                    options={EXPLICIT_LANGUAGES.map(r => ({ value: r.value, label: r.label }))}
                    value={explicitLanguage}
                    onChange={(e) => setExplicitLanguage(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-vp-muted-foreground">方言（explicit_dialect，仅部分音色支持）</label>
                  <Select
                    options={EXPLICIT_DIALECTS.map(r => ({ value: r.value, label: r.label }))}
                    value={explicitDialect}
                    onChange={(e) => setExplicitDialect(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={enableSubtitle} onChange={(e) => setEnableSubtitle(e.target.checked)} />
                    <span>字幕（返回字级别时间戳，用于做视频字幕）</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={autoSplit} onChange={(e) => setAutoSplit(e.target.checked)} />
                    <span>长文本自动切分（超过4500字按句号分段合成）</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={useCache} onChange={(e) => setUseCache(e.target.checked)} />
                    <span>启用缓存（同文本+同音色不重复计费）</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* additions 高级 - 已移至右栏 */}
          <div className="hidden">
            <button
              onClick={() => setShowAdditions(!showAdditions)}
              className="w-full flex items-center justify-between text-sm font-semibold text-vp-foreground"
            >
              <span>⚙️ additions 高级参数（语音指令/语种/水印等）</span>
              <span className="text-vp-muted-foreground">{showAdditions ? '▼' : '▶'}</span>
            </button>
            {showAdditions && (
              <div className="mt-4 space-y-4">
                {/* 语音指令 / 标签Cot */}
                {commandSupported ? (
                  <div>
                    <label className="text-xs text-vp-muted-foreground">
                      语音指令 / 标签Cot（context_texts，每行一条，仅第一个生效，不计费）
                    </label>
                    <textarea
                      value={contextTexts}
                      onChange={(e) => setContextTexts(e.target.value)}
                      placeholder={"[#用颤抖沙哑、带着崩溃与绝望的哭腔说#]\n[#用撒娇的语气说话#]\n[#用四川方言说话#]"}
                      rows={3}
                      className="w-full rounded-xl border border-vp-border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                    <p className="text-xs text-vp-muted-foreground mt-1">
                      格式：[#指令#] · 支持"控制情绪/方言/语气/语速/音调" · 强指令/COT 推荐选择 saturn_zh_xxx_tob 新版音色
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <button type="button" onClick={() => setContextTexts('[#用温柔亲切的语气说#]')} className="px-2 py-1 text-xs bg-sky-400/10 text-vp-primary rounded border border-vp-border hover:bg-sky-400/20">温柔</button>
                      <button type="button" onClick={() => setContextTexts('[#用撒娇的语气说话#]')} className="px-2 py-1 text-xs bg-pink-400/10 text-pink-200 rounded border border-pink-400/20 hover:bg-pink-400/20">撒娇</button>
                      <button type="button" onClick={() => setContextTexts('[#用崩溃绝望的哭腔说#]')} className="px-2 py-1 text-xs bg-red-400/10 text-red-200 rounded border border-red-400/20 hover:bg-red-400/20">哭腔</button>
                      <button type="button" onClick={() => setContextTexts('[#用沉稳专业的语气说#]')} className="px-2 py-1 text-xs bg-indigo-400/10 text-indigo-200 rounded border border-indigo-400/20 hover:bg-indigo-400/20">沉稳</button>
                      <button type="button" onClick={() => setContextTexts('[#用四川方言说话#]')} className="px-2 py-1 text-xs bg-emerald-400/10 text-emerald-200 rounded border border-emerald-400/20 hover:bg-emerald-400/20">四川话</button>
                      <button type="button" onClick={() => setContextTexts('[#放慢语速，声音低沉一点#]')} className="px-2 py-1 text-xs bg-amber-400/10 text-amber-200 rounded border border-amber-400/20 hover:bg-amber-400/20">低沉慢速</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-vp-muted-foreground">当前音色不支持语音指令（需 2.0 系列音色 + expressive 模型）</p>
                )}

                <Slider label="句尾静音（0-3000ms，用于段落间停顿）" min={0} max={3000} value={silenceDuration} onChange={setSilenceDuration} />

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={enableLanguageDetector} onChange={(e) => setEnableLanguageDetector(e.target.checked)} />
                    <span>自动识别语种</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={enableAigcWatermark} onChange={(e) => setEnableAigcWatermark(e.target.checked)} />
                    <span>AIGC 水印（标记AI生成，通常不需要）</span>
                  </label>
                </div>

                {/* 多轮会话 section_id */}
                <div>
                  <label className="text-xs text-vp-muted-foreground">多轮会话ID section_id（可选，同一ID下多次合成保持语气连贯）</label>
                  <input
                    type="text"
                    value={sectionId}
                    onChange={(e) => setSectionId(e.target.value)}
                    placeholder="留空则每次独立，填写UUID关联上下文"
                    className="w-full rounded-xl border border-vp-border bg-vp-background/60 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-700 focus:border-sky-400/40 focus:outline-none mt-2"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Panel */}
        <div className="lg:w-2/3 flex flex-col gap-5 lg:min-h-[580px]">
          {/* Selected Voices Info */}
          <div className="flex gap-3">
            {selectedVoice && (
              <div className="flex-1 bg-vp-card/80 rounded-2xl border border-vp-border p-4 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${
                  selectedVoice.gender === 'male' ? 'from-blue-500 to-indigo-600' : 'from-pink-400 to-rose-500'
                } flex items-center justify-center text-white text-sm font-bold shrink-0`}>
                  {selectedVoice.name.slice(0, 2)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-vp-foreground">{mode === 'dual' ? '角色一：' : ''}{selectedVoice.name}</p>
                  <p className="text-xs text-vp-muted-foreground truncate">{selectedVoice?.speakerId}</p>
                  {commandSupported && <span className="text-xs text-indigo-500">支持语音指令</span>}
                  {dialectSupported && <span className="text-xs text-emerald-500 ml-1">支持方言</span>}
                </div>
              </div>
            )}
            {mode === 'dual' && selectedVoice2 && (
              <div className="flex-1 bg-vp-card/80 rounded-2xl border border-vp-border p-4 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${
                  selectedVoice2.gender === 'male' ? 'from-cyan-500 to-blue-600' : 'from-orange-400 to-amber-500'
                } flex items-center justify-center text-white text-sm font-bold shrink-0`}>
                  {selectedVoice2.name.slice(0, 2)}
                </div>
                <div>
                  <p className="text-sm font-semibold text-vp-foreground">角色二：{selectedVoice2.name}</p>
                  <p className="text-xs text-vp-muted-foreground">{selectedVoice2.speakerId}</p>
                </div>
              </div>
            )}
          </div>

          {/* 高级设置 - 全部参数集中 */}
          <div className="bg-vp-card/80 rounded-2xl border border-amber-400/15 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-amber-400">🎛</span>
              <span className="text-sm font-semibold text-amber-200">高级设置</span>
              <span className="text-[10px] text-vp-muted-foreground">默认：表现力模型 · 无情感 · 24kHz MP3</span>
              <button
                onClick={() => {
                  setPitch(0); setSpeed(0); setVolume(0);
                  setModelVersion('seed-tts-2.0-expressive');
                  setEmotion(''); setEmotionScale(1);
                  setAudioFormat('mp3'); setSampleRate(24000);
                  setSilenceDuration(0); setContextTexts('');
                  setEnableSubtitle(false); setEnableTimestamp(false);
                  setAutoSplit(true); setUseCache(true);
                }}
                className="ml-auto text-[10px] text-amber-400/70 hover:text-amber-300 border border-amber-400/20 rounded-md px-2 py-0.5 transition-colors"
              >
                恢复默认
              </button>
            </div>
            {/* 基础参数 */}
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div><span className="text-[10px] text-vp-muted-foreground">音调</span><input type="range" min={-12} max={12} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} className="w-full accent-cyan-400 h-1" /></div>
              <div><span className="text-[10px] text-vp-muted-foreground">语速</span><input type="range" min={-12} max={12} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full accent-cyan-400 h-1" /></div>
              <div><span className="text-[10px] text-vp-muted-foreground">音量</span><input type="range" min={-12} max={12} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-full accent-cyan-400 h-1" /></div>
            </div>
            {/* 模型/情感/格式/采样率 */}
            <div className="grid grid-cols-4 gap-2 mb-3">
              <div><span className="text-[10px] text-vp-muted-foreground block mb-0.5">模型版本</span><select value={modelVersion} onChange={(e) => setModelVersion(e.target.value)} className="w-full rounded-lg bg-vp-background/60 border border-vp-border px-2 py-1.5 text-xs text-slate-200"><option value="seed-tts-2.0-expressive">⭐ 2.0表现力版</option><option value="seed-tts-2.0-standard">2.0标准版</option><option value="auto">自动</option></select></div>
              <div><span className="text-[10px] text-vp-muted-foreground block mb-0.5">情感</span><select value={emotion} onChange={(e) => setEmotion(e.target.value)} className="w-full rounded-lg bg-vp-background/60 border border-vp-border px-2 py-1.5 text-xs text-slate-200"><option value="">无</option><option value="happy">😊 开心</option><option value="sad">😢 悲伤</option><option value="angry">😠 愤怒</option><option value="surprised">😲 惊讶</option><option value="fear">😨 恐惧</option><option value="gentle">🌸 温柔</option><option value="calm">😌 平静</option><option value="excited">🎉 激动</option><option value="serious">📋 严肃</option><option value="hate">💔 厌恶</option><option value="encourage">💪 鼓励</option><option value="arrogant">😏 傲娇</option><option value="dejected">😞 沮丧</option><option value="broadcast">📢 播报</option><option value="narrator">🎙 旁白</option></select></div>
              <div><span className="text-[10px] text-vp-muted-foreground block mb-0.5">音频格式</span><select value={audioFormat} onChange={(e) => setAudioFormat(e.target.value)} className="w-full rounded-lg bg-vp-background/60 border border-vp-border px-2 py-1.5 text-xs text-slate-200"><option value="mp3">MP3</option><option value="wav">WAV</option></select></div>
              <div><span className="text-[10px] text-vp-muted-foreground block mb-0.5">采样率</span><select value={sampleRate} onChange={(e) => setSampleRate(Number(e.target.value))} className="w-full rounded-lg bg-vp-background/60 border border-vp-border px-2 py-1.5 text-xs text-slate-200"><option value="24000">24kHz</option><option value="16000">16kHz</option></select></div>
            </div>
            {/* 情绪强度 + 句尾静音 */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div><span className="text-[10px] text-vp-muted-foreground">情绪强度</span><input type="range" min={1} max={5} value={emotionScale} onChange={(e) => setEmotionScale(Number(e.target.value))} className="w-full accent-cyan-400 h-1" /></div>
              <div><span className="text-[10px] text-vp-muted-foreground">句尾静音</span><input type="range" min={0} max={30000} step={100} value={silenceDuration} onChange={(e) => setSilenceDuration(Number(e.target.value))} className="w-full accent-cyan-400 h-1" /></div>
            </div>
            {/* 语音指令 */}
            {commandSupported ? (
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[9px] text-amber-400/60">💡 语音指令精确控制语气情感（需⭐表现力模型）</span>
                  <select
                    onChange={(e) => { if (e.target.value) setContextTexts(e.target.value); e.target.value = ''; }}
                    className="ml-auto text-[10px] rounded-lg bg-vp-background/60 border border-amber-400/20 px-2 py-1 text-amber-300"
                  >
                    <option value="">预设语气 ▼</option>
                    <option value="[#用分享朋友圈的轻松语气说#]">📱 分享朋友圈</option>
                    <option value="[#用和朋友聊天的亲切语气说#]">💬 朋友聊天</option>
                    <option value="[#用专业播报的严肃语气说#]">📢 专业播报</option>
                    <option value="[#用讲故事的方式娓娓道来说#]">📖 娓娓道来</option>
                    <option value="[#用欢快活泼的语气说#]">🎵 欢快活泼</option>
                    <option value="[#用温柔治愈的语气说#]">🌸 温柔治愈</option>
                    <option value="[#用激动热血的语气说#]">🔥 激动热血</option>
                    <option value="[#用神秘悬疑的语气说#]">🔮 神秘悬疑</option>
                    <option value="[#用撒娇卖萌的语气说#]">🐱 撒娇卖萌</option>
                    <option value="[#用幽默搞笑的语气说#]">😄 幽默搞笑</option>
                    <option value="[#用深情款款的语气说#]">💕 深情款款</option>
                    <option value="[#用自信坚定的语气说#]">💪 自信坚定</option>
                  </select>
                </div>
                <div className="flex flex-wrap gap-1 mb-1.5">
                  <button type="button" onClick={() => setContextTexts('[#用撒娇的语气说#]')} className="px-1.5 py-0.5 text-[10px] rounded-md bg-amber-400/10 text-amber-300 border border-amber-400/20 hover:bg-amber-400/20">撒娇</button>
                  <button type="button" onClick={() => setContextTexts('[#用哭腔说#]')} className="px-1.5 py-0.5 text-[10px] rounded-md bg-amber-400/10 text-amber-300 border border-amber-400/20 hover:bg-amber-400/20">哭腔</button>
                  <button type="button" onClick={() => setContextTexts('[#用ASMR的语气说#]')} className="px-1.5 py-0.5 text-[10px] rounded-md bg-amber-400/10 text-amber-300 border border-amber-400/20 hover:bg-amber-400/20">ASMR</button>
                  <button type="button" onClick={() => setContextTexts('[#用吵架的语气说#]')} className="px-1.5 py-0.5 text-[10px] rounded-md bg-amber-400/10 text-amber-300 border border-amber-400/20 hover:bg-amber-400/20">吵架</button>
                  <button type="button" onClick={() => setContextTexts('[#用四川话说#]')} className="px-1.5 py-0.5 text-[10px] rounded-md bg-amber-400/10 text-amber-300 border border-amber-400/20 hover:bg-amber-400/20">四川话</button>
                  <button type="button" onClick={() => setContextTexts('[#用温柔的语气说#]')} className="px-1.5 py-0.5 text-[10px] rounded-md bg-amber-400/10 text-amber-300 border border-amber-400/20 hover:bg-amber-400/20">温柔</button>
                </div>
                <textarea value={contextTexts} onChange={(e) => setContextTexts(e.target.value)} placeholder="[#用撒娇的语气说#]" rows={1} className="w-full rounded-lg bg-vp-background/60 border border-vp-border px-2 py-1.5 text-xs text-slate-200 placeholder:text-vp-muted-foreground resize-none" />
              </div>
            ) : null}
            {/* 语种 + 方言 */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div><span className="text-[10px] text-vp-muted-foreground block mb-0.5">语种</span><select value={explicitLanguage} onChange={(e) => setExplicitLanguage(e.target.value)} className="w-full rounded-lg bg-vp-background/60 border border-vp-border px-2 py-1.5 text-xs text-slate-200"><option value="">自动</option><option value="zh-cn">中文</option><option value="en">英文</option></select></div>
              {dialectSupported ? <div><span className="text-[10px] text-vp-muted-foreground block mb-0.5">方言</span><select value={explicitDialect} onChange={(e) => setExplicitDialect(e.target.value)} className="w-full rounded-lg bg-vp-background/60 border border-vp-border px-2 py-1.5 text-xs text-slate-200"><option value="">无</option><option value="dongbei">东北话</option><option value="shaanxi">陕西话</option><option value="sichuan">四川话</option></select></div> : <div />}
            </div>
            {/* 开关组 */}
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={enableSubtitle} onChange={(e) => setEnableSubtitle(e.target.checked)} />字幕</label>
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={enableTimestamp} onChange={(e) => setEnableTimestamp(e.target.checked)} />时间戳</label>
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={useCache} onChange={(e) => setUseCache(e.target.checked)} />缓存</label>
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={autoSplit} onChange={(e) => setAutoSplit(e.target.checked)} />自动切分</label>
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={enableLanguageDetector} onChange={(e) => setEnableLanguageDetector(e.target.checked)} />自动识别语种</label>
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={disableMarkdownFilter} onChange={(e) => setDisableMarkdownFilter(e.target.checked)} />无Markdown过滤</label>
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={disableEmojiFilter} onChange={(e) => setDisableEmojiFilter(e.target.checked)} />无Emoji过滤</label>
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={enableLatexTn} onChange={(e) => setEnableLatexTn(e.target.checked)} />LaTeX公式</label>
              <label className="flex items-center gap-1 text-[10px] text-vp-muted-foreground"><input type="checkbox" checked={enableAigcWatermark} onChange={(e) => setEnableAigcWatermark(e.target.checked)} />AIGC水印</label>
            </div>
          </div>

          {/* 混音音色配置（横屏布局：左音色一 / 右音色二） */}
          {mode === 'mix' && (
            <div className="bg-vp-card/80 rounded-2xl border border-purple-400/15 p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-purple-400">🎵</span>
                <span className="text-sm font-semibold text-purple-200">混音音色配置</span>
                <span className="text-[10px] text-vp-muted-foreground">比例之和需 = 1.00（仅 TTS 1.0）</span>
              </div>
              {/* 横屏双列：音色一 | 音色二 */}
              <div className="grid grid-cols-2 gap-4 mb-3">
                {/* 音色一 */}
                <div className="p-3 rounded-xl bg-slate-950/30 border border-purple-300/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-300">音色一</span>
                    {mixVoices.length > 2 && (
                      <button
                        onClick={() => setMixVoices(prev => prev.filter((_, i) => i !== 0))}
                        className="text-[10px] text-red-400 hover:text-red-300"
                      >
                        移除
                      </button>
                    )}
                  </div>
                  <Select
                    options={[
                      { value: '', label: '— 选择音色 —' },
                      ...voices.map(v => ({ value: v.speakerId, label: `${v.name} (${v.speakerId})` })),
                    ]}
                    value={mixVoices[0]?.voice?.speakerId || ''}
                    onChange={(e) => {
                      const voice = voices.find(v => v.speakerId === e.target.value) || null;
                      setMixVoices(prev => prev.map((p, i) => i === 0 ? { ...p, voice } : p));
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-vp-muted-foreground shrink-0">比例</span>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={mixVoices[0]?.factor || 0}
                      onChange={(e) => {
                        const factor = parseFloat(e.target.value);
                        setMixVoices(prev => prev.map((p, i) => i === 0 ? { ...p, factor } : p));
                      }}
                      className="flex-1 accent-purple-500 h-1"
                    />
                    <span className="text-xs text-purple-300 w-10 text-right">{((mixVoices[0]?.factor || 0) * 100).toFixed(0)}%</span>
                  </div>
                </div>
                {/* 音色二 */}
                <div className="p-3 rounded-xl bg-slate-950/30 border border-purple-300/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-300">音色二</span>
                    {mixVoices.length > 2 && (
                      <button
                        onClick={() => setMixVoices(prev => prev.filter((_, i) => i !== 1))}
                        className="text-[10px] text-red-400 hover:text-red-300"
                      >
                        移除
                      </button>
                    )}
                  </div>
                  <Select
                    options={[
                      { value: '', label: '— 选择音色 —' },
                      ...voices.map(v => ({ value: v.speakerId, label: `${v.name} (${v.speakerId})` })),
                    ]}
                    value={mixVoices[1]?.voice?.speakerId || ''}
                    onChange={(e) => {
                      const voice = voices.find(v => v.speakerId === e.target.value) || null;
                      setMixVoices(prev => prev.map((p, i) => i === 1 ? { ...p, voice } : p));
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-vp-muted-foreground shrink-0">比例</span>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={mixVoices[1]?.factor || 0}
                      onChange={(e) => {
                        const factor = parseFloat(e.target.value);
                        setMixVoices(prev => prev.map((p, i) => i === 1 ? { ...p, factor } : p));
                      }}
                      className="flex-1 accent-purple-500 h-1"
                    />
                    <span className="text-xs text-purple-300 w-10 text-right">{((mixVoices[1]?.factor || 0) * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>
              {/* 音色三（如有） */}
              {mixVoices.length > 2 && mixVoices[2] && (
                <div className="p-3 rounded-xl bg-slate-950/30 border border-purple-300/10 space-y-2 mb-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-300">音色三</span>
                    <button
                      onClick={() => setMixVoices(prev => prev.filter((_, i) => i !== 2))}
                      className="text-[10px] text-red-400 hover:text-red-300"
                    >
                      移除
                    </button>
                  </div>
                  <Select
                    options={[
                      { value: '', label: '— 选择音色 —' },
                      ...voices.map(v => ({ value: v.speakerId, label: `${v.name} (${v.speakerId})` })),
                    ]}
                    value={mixVoices[2]?.voice?.speakerId || ''}
                    onChange={(e) => {
                      const voice = voices.find(v => v.speakerId === e.target.value) || null;
                      setMixVoices(prev => prev.map((p, i) => i === 2 ? { ...p, voice } : p));
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-vp-muted-foreground shrink-0">比例</span>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={mixVoices[2]?.factor || 0}
                      onChange={(e) => {
                        const factor = parseFloat(e.target.value);
                        setMixVoices(prev => prev.map((p, i) => i === 2 ? { ...p, factor } : p));
                      }}
                      className="flex-1 accent-purple-500 h-1"
                    />
                    <span className="text-xs text-purple-300 w-10 text-right">{((mixVoices[2]?.factor || 0) * 100).toFixed(0)}%</span>
                  </div>
                </div>
              )}
              {/* 添加第3个 + 比例总和 */}
              <div className="flex items-center justify-between">
                {mixVoices.length < 3 ? (
                  <button
                    onClick={() => setMixVoices(prev => [...prev, { voice: null, factor: 0.0 }])}
                    className="text-xs text-purple-300 border border-dashed border-purple-300/30 rounded-lg px-3 py-1 hover:bg-purple-50/10"
                  >
                    + 添加第 3 个音色
                  </button>
                ) : <div />}
                <div className="text-xs text-vp-muted-foreground">
                  比例总和：
                  <span className={Math.abs(mixVoices.reduce((s, mv) => s + mv.factor, 0) - 1) < 0.01 ? 'text-emerald-400' : 'text-amber-400'}>
                    {mixVoices.reduce((s, mv) => s + mv.factor, 0).toFixed(2)} / 1.00
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* SSML 切换 */}
          <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-4 flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useSsml} onChange={(e) => setUseSsml(e.target.checked)} />
              <span>使用 SSML 输入（仅 TTS1.0/ICL1.0 完整支持，2.0不报错但无字幕）</span>
            </label>
          </div>

          {/* 文本输入 - SSML 模式 */}
          {useSsml && (
            <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-5 flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-vp-foreground">SSML 输入</h3>
                <span className="text-xs text-vp-muted-foreground">{ssml.length} 字</span>
              </div>
              <textarea
                value={ssml}
                onChange={(e) => setSsml(e.target.value)}
                placeholder={'<speak>你好，<break time="1s"/>欢迎使用智音工坊。</speak>'}
                className="flex-1 w-full rounded-xl border border-vp-border px-4 py-3 text-sm font-mono focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none resize-none min-h-0"
              />
            </div>
          )}

          {/* 音频生成模式 (Seed-Audio-1.0) */}
          {mode === 'audio-gen' && (
            <div className="gap-4 flex-1 flex flex-col relative">
              {/* 链接提取参考音频 */}
              <div className="bg-vp-card/80 rounded-2xl border border-rose-400/15 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-rose-400">🔗</span>
                  <span className="text-sm font-semibold text-rose-200">参考音频来源</span>
                  <span className="text-[10px] text-vp-muted-foreground">粘贴抖音/小红书链接自动提取</span>
                </div>
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    placeholder="粘贴抖音或小红书链接..."
                    className="flex-1 rounded-xl border border-rose-400/20 bg-vp-background/60 px-3 py-2 text-sm text-slate-200 placeholder:text-vp-muted-foreground"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        extractAudioFromLink((e.target as HTMLInputElement).value);
                        (e.target as HTMLInputElement).value = '';
                      }
                    }}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      const input = document.querySelector('input[placeholder*=\"抖音或小红书\"]') as HTMLInputElement;
                      if (input?.value) { extractAudioFromLink(input.value); input.value = ''; }
                    }}
                  >
                    提取
                  </Button>
                </div>
                {/* 已提取的参考音频 */}
                {audioGenRefs.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {audioGenRefs.map((ref, i) => (
                      <div key={i} className={`p-2 rounded-lg border text-xs ${ref.extracting ? 'bg-slate-800/30 border-slate-600/20 animate-pulse' : ref.url ? 'bg-rose-400/5 border-rose-400/20' : 'bg-red-400/5 border-red-400/20'}`}>
                        <p className="text-vp-foreground truncate">{ref.name}</p>
                        {ref.url && <p className="text-[10px] text-rose-400">@音频{i + 1}</p>}
                        {ref.extracting && <p className="text-[10px] text-vp-muted-foreground">提取中...</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 提示词输入 */}
              <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-amber-400">✏️</span>
                  <span className="text-sm font-semibold text-vp-foreground">提示词 / 文案</span>
                  <span className="text-[10px] text-vp-muted-foreground">支持 @音频N 引用参考音频</span>
                </div>
                <textarea
                  value={audioGenText}
                  onChange={(e) => setAudioGenText(e.target.value)}
                  placeholder={`@音频1 请用参考音频中的音色和情感风格，说出以下文案：\n\n今天的天气很好，我们一起出去走走吧。`}
                  rows={6}
                  className="w-full rounded-xl border border-vp-border bg-vp-background/60 px-4 py-3 text-sm text-slate-200 placeholder:text-vp-muted-foreground focus:border-rose-400/40 focus:outline-none resize-none"
                />
                <p className="text-xs text-vp-muted-foreground mt-2">{audioGenText.length}/3000 字符 · 最长生成120秒 · 费用 1元/分钟</p>
              </div>

              {/* 弹性占位 - 推按钮到底部 */}
              <div className="flex-grow min-h-[80px]" />

              {/* 生成按钮 */}
              <div className="absolute bottom-4 left-0 right-0 px-4">
              <button
                onClick={async () => {
                  setAudioGenLoading(true);
                  setAudioGenResult(null);
                  try {
                    const body: any = { textPrompt: audioGenText };
                    // 取第一个有效的参考音频
                    const validRef = audioGenRefs.find(r => r.url && !r.extracting);
                    if (validRef) body.audioUrl = validRef.url;
                    
                    const res = await fetch('/voice-platform/api/audio-generate', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body),
                    });
                    const d = await res.json();
                    if (d.success) {
                      setAudioGenResult({ audioUrl: d.data.audioUrl, duration: d.data.duration });
                      saveToHistory({ text: audioGenText.slice(0, 50), speaker: 'Seed-Audio-1.0', audioUrl: d.data.audioUrl, time: new Date().toLocaleTimeString(), duration: d.data.duration });
                    } else {
                      setError(d.message || '生成失败');
                    }
                  } catch (err: any) {
                    setError(err.message || '生成失败');
                  } finally {
                    setAudioGenLoading(false);
                  }
                }}
                disabled={audioGenLoading || !audioGenText.trim()}
                className="w-full py-2 rounded-xl bg-gradient-to-r from-rose-500 to-pink-600 text-white text-sm font-bold hover:from-rose-400 hover:to-pink-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-none"
              >
                {audioGenLoading ? '🎬 生成中...' : '🎬 开始生成 (Seed-Audio-1.0)'}
              </button>

              {/* 生成结果 */}
              {audioGenResult && (
                <div className="bg-vp-card/80 rounded-2xl border border-rose-400/20 p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-rose-400">✅</span>
                    <span className="text-sm font-semibold text-vp-foreground">生成完成 · {audioGenResult.duration.toFixed(0)}秒</span>
                    <a href={audioGenResult.audioUrl} download target="_blank" className="ml-auto text-xs text-rose-300 hover:text-rose-200">下载</a>
                  </div>
                  <AudioPlayer audioUrl={audioGenResult.audioUrl} />
                </div>
              )}
              </div>
            </div>
          )}

          {/* 文本输入 - 单人/混音模式 */}
          {!useSsml && (mode === 'single' || mode === 'mix') && (
            <div className="flex-1 bg-vp-card/80 rounded-2xl border border-vp-border overflow-hidden flex flex-col min-h-0">
              {/* 头部标题 */}
              <div className="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
                <h3 className="text-sm font-semibold text-vp-foreground">
                  {mode === 'mix' ? '混音合成文本' : '输入文本'}
                </h3>
                <span className="text-xs text-vp-muted-foreground">
                  {text.length} / 5000 字 {text.length > 4500 && !autoSplit && <span className="text-amber-500 ml-1">建议开启自动切分</span>}
                </span>
              </div>
              {/* 文本区域 - 自适应填满剩余空间 */}
              <textarea
                value={text} onChange={(e) => setText(e.target.value)}
                placeholder={mode === 'mix' ? '输入混音合成的文本...' : '输入要合成的文本内容...'}
                className="flex-1 w-full border-0 px-5 py-3 text-sm bg-transparent focus:outline-none resize-none placeholder:text-vp-muted-foreground text-slate-200 min-h-0"
              />
              {/* 底部按钮 - 始终固定在卡片底部 */}
              <div className="shrink-0 border-t border-vp-border/50">
                <button
                  onClick={handleSynthesizeAll}
                  disabled={synthesizing}
                  className="w-full py-2 bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-sm font-bold hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  {synthesizing ? (
                    <><span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> 合成中...</>
                  ) : (
                    <>✦ 开始合成</>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 文本输入 - 长文本异步模式 */}
          {mode === 'long-text' && (
            <div className="flex-1 bg-vp-card/80 rounded-2xl border border-vp-border p-5 flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-vp-foreground">长文本输入（异步合成）</h3>
                <span className={`text-xs ${text.length > 100000 ? 'text-red-400' : 'text-vp-muted-foreground'}`}>
                  {text.length.toLocaleString()} / 100,000 字
                </span>
              </div>
              <textarea
                value={text} onChange={(e) => setText(e.target.value)}
                placeholder="支持最长 10 万字的超长文本，提交后将在云端异步合成。适合小说、长篇有声书等场景..."
                rows={10}
                className="w-full rounded-xl border border-vp-border px-4 py-3 text-sm focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 focus:outline-none resize-y"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => setText('第一章 初遇\n\n那是一个秋天的傍晚，夕阳将整座城市染成了金色。林晓站在公交站台前，手里攥着一封已经揉皱的信。她不知道自己为什么要来这里，也许是命运的安排，也许只是一个偶然。\n\n公交车缓缓驶来，她深吸一口气，踏上了车门。车上人不多，她找了个靠窗的位置坐下。窗外的风景飞速后退，就像她脑海中那些不愿回忆的往事。')}
                  className="px-3 py-1.5 text-xs font-medium text-vp-muted-foreground bg-vp-background/60 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  有声书示例
                </button>
                <button
                  onClick={() => setText('这是一段用于测试长文本合成的文字。火山引擎语音合成2.0支持最长10万字的异步合成，适合小说、新闻、有声书等超长内容场景。提交后系统会自动切分并在云端合成，完成后返回完整音频和逐句字幕。')}
                  className="px-3 py-1.5 text-xs font-medium text-vp-muted-foreground bg-vp-background/60 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  测试文本
                </button>
              </div>
              <button
                onClick={handleSynthesizeAll}
                disabled={synthesizing}
                className="w-full mt-3 py-3 bg-gradient-to-r from-amber-500 to-orange-600 text-white text-sm font-bold hover:from-amber-400 hover:to-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
              >
                {synthesizing ? (
                  <><span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> 提交中...</>
                ) : (
                  <>📝 提交异步合成</>
                )}
              </button>
            </div>
          )}

          {/* 文本输入 - 双人模式 */}
          {!useSsml && mode === 'dual' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex-1 flex flex-col min-h-0 gap-4">
                <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-5 flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-vp-primary">角色一 台词</h3>
                    <span className="text-xs text-vp-muted-foreground">{text.length} 字</span>
                  </div>
                  <textarea
                    value={text} onChange={(e) => setText(e.target.value)}
                    placeholder="输入角色一的台词..."
                    className="w-full flex-1 min-h-0 rounded-xl border border-vp-border px-4 py-3 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none resize-none"
                  />
                </div>
                <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-5 flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-cyan-600">角色二 台词</h3>
                    <span className="text-xs text-vp-muted-foreground">{text2.length} 字</span>
                  </div>
                  <textarea
                    value={text2} onChange={(e) => setText2(e.target.value)}
                    placeholder="输入角色二的台词..."
                    className="w-full flex-1 min-h-0 rounded-xl border border-vp-border px-4 py-3 text-sm focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 focus:outline-none resize-none"
                  />
                </div>
              </div>
              <div className="flex-shrink-0 mt-4">
                <div className="flex flex-wrap gap-2 mb-3">
                  {DUAL_SAMPLE_TEXTS.map((s) => (
                    <button key={s.label} onClick={() => { setText(s.text1); setText2(s.text2); }}
                      className="px-3 py-1.5 text-xs font-medium text-vp-muted-foreground bg-vp-background/60 rounded-lg hover:bg-gray-200 transition-colors">
                      {s.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={handleSynthesizeAll}
                  disabled={synthesizing}
                  className="w-full py-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-sm font-bold hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  {synthesizing ? (
                    <><span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" /> 合成中...</>
                  ) : (
                    <>✦ 开始双人合成</>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 合成按钮 */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>
          )}

          {/* SSE 流式进度 */}
          {sseStream && mode === 'single' && sseProgress.length > 0 && (
            <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-4 max-h-32 overflow-y-auto">
              <h4 className="text-xs font-semibold text-vp-primary mb-2">⚡ SSE 流式进度</h4>
              {sseProgress.map((msg, i) => (
                <p key={i} className="text-xs text-vp-muted-foreground font-mono">{msg}</p>
              ))}
            </div>
          )}

          {/* 长文本任务状态 */}
          {mode === 'long-text' && longTextStatus !== 'idle' && (
            <div className="bg-vp-card/80 rounded-2xl border border-amber-300/20 p-5">
              <div className="flex items-center gap-3 mb-3">
                {longTextStatus === 'submitted' && <span className="text-amber-400">📋 任务已提交</span>}
                {longTextStatus === 'processing' && (
                  <>
                    <span className="inline-block w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                    <span className="text-amber-400">⏳ 云端合成中，每 5 秒自动查询...</span>
                  </>
                )}
                {longTextStatus === 'success' && <span className="text-emerald-400">✅ 合成完成</span>}
                {longTextStatus === 'failed' && <span className="text-red-400">❌ 合成失败</span>}
              </div>
              {longTextTaskId && (
                <p className="text-xs text-vp-muted-foreground">任务 ID：<code className="text-vp-muted-foreground">{longTextTaskId}</code></p>
              )}
            </div>
          )}

          {/* 长文本结果 */}
          {mode === 'long-text' && longTextStatus === 'success' && longTextAudioUrl && (
            <div className="bg-vp-card/80 rounded-2xl border border-emerald-300/20 p-5 animate-slideUp">
              <h3 className="text-sm font-semibold text-vp-foreground mb-3">长文本合成结果</h3>
              <AudioPlayer audioUrl={longTextAudioUrl} onDownload={() => window.open(longTextAudioUrl, '_blank')} />
              {longTextSentences.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold text-vp-foreground">字幕（{longTextSentences.length} 句）</h4>
                    <button
                      onClick={() => {
                        const srt = formatSrt(longTextSentences);
                        const blob = new Blob([srt || ''], { type: 'text/plain;charset=utf-8' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `longtext_subtitle_${Date.now()}.srt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      className="text-xs text-vp-primary hover:underline"
                    >
                      导出 SRT
                    </button>
                  </div>
                  <div className="bg-vp-card rounded-xl p-3 max-h-48 overflow-y-auto text-sm space-y-1">
                    {longTextSentences.map((s, i) => (
                      <div key={i} className="flex gap-3">
                        <span className="text-xs text-vp-muted-foreground shrink-0 w-24">
                          {(s.startMs / 1000).toFixed(1)}s
                        </span>
                        <span className="text-vp-foreground">{s.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* 第2段：结果展示（全宽） */}
      {result && (
        <div className="mt-6 bg-gradient-to-b from-[#081B35]/90 to-[#061A2E]/90 rounded-2xl border border-vp-border p-6 animate-slideUp">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/30">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-bold text-vp-foreground">合成完成</h3>
              <p className="text-xs text-vp-muted-foreground">
                {result.duration ? `${result.duration.toFixed(1)}秒` : ''}
                {result.logId ? ` · logId: ${result.logId}` : ''}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <a
                href={result.audioUrl}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-cyan-500/15 text-cyan-200 border border-cyan-400/20 hover:bg-cyan-500/25 text-sm font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                下载音频
              </a>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(result.audioUrl);
                  alert('音频链接已复制');
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-700/30 text-vp-foreground border border-slate-600/30 hover:bg-slate-700/50 text-sm transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                复制链接
              </button>
            </div>
          </div>

          <div className="bg-slate-950/40 rounded-xl p-4 border border-sky-300/8">
            <AudioPlayer audioUrl={result.audioUrl} onDownload={() => window.open(result.audioUrl, '_blank')} />
          </div>

          {/* 字幕展示 */}
          {result.subtitles && result.subtitles.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-vp-muted-foreground">字幕 ({result.subtitles.length} 句)</span>
                <button
                  onClick={() => {
                    const srt = result.subtitles?.map((s: any, i: number) =>
                      `${i+1}\n${new Date(s.startMs).toISOString().substr(11, 8)} --> ${new Date(s.endMs).toISOString().substr(11, 8)}\n${s.text}\n`
                    ).join('\n');
                    const blob = new Blob([srt || ''], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `subtitle_${Date.now()}.srt`;
                    a.click(); URL.revokeObjectURL(url);
                  }}
                  className="text-xs text-vp-primary hover:underline"
                >
                  导出 SRT
                </button>
              </div>
              <div className="bg-slate-950/30 rounded-xl p-3 max-h-36 overflow-y-auto text-xs space-y-1">
                {result.subtitles.slice(0, 5).map((s: any, i: number) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-vp-muted-foreground shrink-0">{(s.startMs/1000).toFixed(1)}s</span>
                    <span className="text-vp-muted-foreground">{s.text}</span>
                  </div>
                ))}
                {result.subtitles.length > 5 && (
                  <p className="text-vp-muted-foreground text-center">... 共 {result.subtitles.length} 句</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 第3段：合成历史 */}
      {history.length > 0 && (
        <div className="mt-6 bg-vp-card/80 rounded-2xl border border-vp-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <svg className="w-4 h-4 text-vp-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-sm font-semibold text-vp-foreground">合成历史</h3>
            <span className="text-xs text-vp-muted-foreground">最近 {history.length} 条</span>
            <button
              onClick={() => { setHistory([]); localStorage.removeItem('tts_history'); }}
              className="ml-auto text-xs text-vp-muted-foreground hover:text-red-400 transition-colors"
            >
              清空
            </button>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {history.map((item, i) => (
              <div key={i} className="flex items-center gap-3 bg-slate-950/30 rounded-xl px-4 py-3 border border-vp-border hover:border-vp-border transition-colors group">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-vp-foreground truncate">{item.text}</p>
                  <p className="text-[10px] text-vp-muted-foreground mt-0.5">
                    {item.speaker} · {item.time} · {item.duration.toFixed(0)}秒
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={(e) => {
                      const btn = e.currentTarget;
                      const isPlaying = btn.dataset.playing === 'true';
                      if (isPlaying && playingAudioRef.current) {
                        playingAudioRef.current.pause();
                        playingAudioRef.current = null;
                        btn.dataset.playing = 'false';
                        btn.textContent = '播放';
                        btn.className = btn.className.replace('bg-cyan-500/20', 'bg-cyan-500/10');
                        return;
                      }
                      // 停止之前的
                      if (playingAudioRef.current) {
                        playingAudioRef.current.pause();
                        // 重置之前按钮状态
                        const prevBtn = document.querySelector('[data-playing="true"]');
                        if (prevBtn) {
                          (prevBtn as HTMLElement).dataset.playing = 'false';
                          prevBtn.textContent = '播放';
                          prevBtn.className = prevBtn.className.replace('bg-cyan-500/20', 'bg-cyan-500/10');
                        }
                      }
                      const audio = new Audio(item.audioUrl);
                      audio.onended = () => {
                        btn.dataset.playing = 'false';
                        btn.textContent = '播放';
                        btn.className = btn.className.replace('bg-cyan-500/20', 'bg-cyan-500/10');
                        playingAudioRef.current = null;
                      };
                      audio.onerror = () => { playingAudioRef.current = null; btn.dataset.playing = 'false'; btn.textContent = '播放'; };
                      playingAudioRef.current = audio;
                      audio.play();
                      btn.dataset.playing = 'true';
                      btn.textContent = '暂停';
                      btn.className = btn.className.replace('bg-cyan-500/10', 'bg-cyan-500/20');
                    }}
                    className="px-2 py-1 text-xs rounded-lg bg-cyan-500/10 text-vp-primary border border-cyan-400/15 hover:bg-cyan-500/20 transition-colors"
                  >
                    播放
                  </button>
                  <a
                    href={item.audioUrl}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-1 text-xs rounded-lg bg-slate-600/20 text-vp-muted-foreground border border-slate-600/20 hover:bg-slate-600/30 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    下载
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!result && !synthesizing && !(history.length > 0) && (
        <div className="mt-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-sky-400/10 mb-4">
            <svg className="w-8 h-8 text-sky-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <p className="text-sm text-vp-muted-foreground">选择音色、调整参数、输入文本后点击合成</p>
          <p className="text-xs text-vp-muted-foreground mt-1">合成结果将自动保存到历史记录</p>
        </div>
      )}

    </div>
  );
}

export default function WorkspacePage() {
  return (
    <Suspense fallback={
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-6">
          <div className="h-8 w-48 bg-slate-700/50 rounded-lg" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-4">
              <div className="h-12 bg-slate-700/30 rounded-xl" />
              <div className="h-80 bg-slate-700/20 rounded-2xl" />
            </div>
            <div className="lg:col-span-2 space-y-4">
              <div className="h-48 bg-slate-700/20 rounded-2xl" />
              <div className="h-16 bg-slate-700/20 rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    }>
      <WorkspaceContent />
    </Suspense>
  );
}
