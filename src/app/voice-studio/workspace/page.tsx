'use client';
import './workspace.css';
import VoicePortrait from '@/components/vs/VoicePortrait';
import { useVoiceFavorites } from '@/hooks/use-voice-favorites';

import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AudioLines, ChevronDown, Clapperboard, FileText, Headphones, Heart, History, LoaderCircle, MessagesSquare, Mic2, Music2, PencilLine, Play, Settings2, Square, User } from 'lucide-react';
import { loadPreview } from '@/lib/vs/preview-cache';
import Button from '@/components/vs/ui/Button';
import Slider from '@/components/vs/ui/Slider';
import Select from '@/components/vs/ui/Select';
import AudioPlayer from '@/components/vs/AudioPlayer';
import AudioDownloadButton from '@/components/vs/AudioDownloadButton';
import VoiceGenerationHistory from '@/components/vs/VoiceGenerationHistory';
import type { VoiceGeneration } from '@/lib/types';
import { canLoadVoiceHistoryForRetry, voiceHistoryRetryUnavailableReason } from '@/lib/voice-history-retry';
import { getGradient } from '@/lib/vs/avatar';
import type { UserVoiceDto } from '@/lib/vs/user-voice-dto';
import { useApp } from '@/contexts/app-context';
import { resolveWorkbenchIdentity, workbenchUserStorageKey, type WorkbenchIdentity } from '@/lib/workbench-user-storage';
import {
  buildClientRequestFingerprint,
  clearBrowserClientAttempt,
  resolveBrowserClientAttempt,
} from '@/lib/browser-client-attempt';
import {
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_SEED_AUDIO_REFERENCES,
  REFERENCE_AUDIO_DEFAULT_DURATION_SECONDS,
} from '@/lib/vs/reference-audio-contract';
import { extractReferenceAudioFromShareLink } from '@/lib/vs/reference-audio-extraction';
import {
  ReferenceAudioChargeConfirm,
  ReferenceAudioRuntimeStatus,
  useReferenceAudioRuntimeGate,
} from '@/components/vs/ReferenceAudioExtractionGate';
import {
  RESOURCE_IDS,
  MODEL_VERSIONS,
  AUDIO_FORMATS,
  SAMPLE_RATES,
  EXPLICIT_LANGUAGES,
  EXPLICIT_DIALECTS,
  SYNTHESIS_PRESETS,
  isCommandSupported,
  isDialectSupported,
} from '@/lib/vs/voices-data';

// Generated files must have a supported audio container for validation,
// persistent storage and browser playback. Raw PCM is not a file delivery mode.
const FILE_AUDIO_FORMATS = AUDIO_FORMATS.filter((format) => format.value !== 'pcm');

interface Voice {
  id: string;
  speakerId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  gender: string;
  language?: string;
  engine?: string;
}

interface VoiceResult {
  audioUrl: string;
  duration: number;
  subtitles?: Array<{ text: string; startMs: number; endMs: number }>;
  logId?: string;
  generationId?: string;
  providerTaskId?: string;
  cost?: number;
  warnings?: string[];
  quotedCredits?: number;
  retailPrice?: number;
  asset?: {
    id?: string;
    storageKey?: string;
    storageProvider?: string;
    contentType?: string;
    size?: number;
  } | null;
}

interface AudioGenReference {
  assetId: string;
  url: string;
  name: string;
  source: 'upload' | 'link';
}

// Official 1.0 voice table marks these two voices as MIX-supported:
// https://docs.volcengine.com/docs/6561/1257544?lang=zh (2026-08-31).
const MIX_VOICES: Voice[] = [
  { id: 'zh_female_shuangkuaisisi_moon_bigtts', speakerId: 'zh_female_shuangkuaisisi_moon_bigtts', name: '爽快思思（TTS 1.0）', description: '官方支持混音的 1.0 音色', category: '混音', tags: ['MIX'], gender: 'female' },
  { id: 'zh_male_wennuanahu_moon_bigtts', speakerId: 'zh_male_wennuanahu_moon_bigtts', name: '温暖阿虎（TTS 1.0）', description: '官方支持混音的 1.0 音色', category: '混音', tags: ['MIX'], gender: 'male' },
];
const MODEL_VERSION_LABELS: Record<typeof MODEL_VERSIONS[number]['value'], string> = {
  auto: '自动（表现力增强版）',
  'seed-tts-2.0-standard': '标准版',
  'seed-tts-2.0-expressive': '表现力增强版',
};

function customerVoiceError(value: unknown, fallback = '语音生成暂未完成，请稍后重试') {
  const detail = typeof value === 'string' ? value.trim() : '';
  if (/余额不足|积分不足|额度不足/u.test(detail)) return '当前余额不足，请充值后重试。';
  if (/文本|音色|音频|格式|长度|参数/u.test(detail) && /无效|缺少|错误|过长|不支持/u.test(detail)) {
    return '当前输入未通过检查，请调整后重试。';
  }
  if (/API|HTTP|provider|供应商|上游|渠道|密钥|后台|数据库|迁移|作业键|预占|终态|落库/iu.test(detail)) return fallback;
  return detail || fallback;
}

const SYNTHESIS_ACTION_LABELS = {
  single: '开始合成',
  dual: '开始双人合成',
  'long-text': '开始长文本合成',
  mix: '开始混音合成',
  'audio-gen': '生成音频',
} as const;

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

let pricingRequest: { revision: number; promise: Promise<string[]> } | null = null;
function loadEnabledPricingModels(revision: number) {
  if (pricingRequest?.revision === revision) return pricingRequest.promise;
  const promise = fetch('/api/voice/pricing', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    .then(async response => {
      const data = await response.json();
      if (!response.ok || data.success !== true || !Array.isArray(data.data)) throw new Error('MODEL_LIST_UNAVAILABLE');
      return data.data.flatMap((item: { modelId?: unknown }) => typeof item.modelId === 'string' ? [item.modelId] : []);
    })
    .catch(error => {
      if (pricingRequest?.promise === promise) pricingRequest = null;
      throw error;
    });
  pricingRequest = { revision, promise };
  return promise;
}

function shouldReleaseVoiceAttempt(response: Response, payload: Record<string, any>): boolean {
  if (response.ok && payload.success === true) return true;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const terminal = String(data.terminalStatus || data.state || '').toLowerCase();
  if (['completed', 'failed', 'refunded'].includes(terminal)) return true;
  if (data.provider_call_started === false || payload.provider_call_started === false) return true;
  const hasDurableRequest = Boolean(data.requestId || data.request_id);
  return !hasDurableRequest
    && response.status >= 400
    && response.status < 500
    && ![408, 409, 425, 429].includes(response.status);
}

interface VoiceCatalogSourceStatus {
  id: 'official' | 'user';
  label: string;
  loading: boolean;
  error: string;
  onRetry: () => void;
}

interface VoicePickerCardProps {
  title: string;
  icon: React.ReactNode;
  searchVal: string;
  onSearch: (value: string) => void;
  catVal: string;
  onCat: (value: string) => void;
  categories: string[];
  filtered: Voice[];
  selected: Voice | null;
  onSelect: (voice: Voice) => void;
  favorites: Set<string>;
  onToggleFavorite: (speakerId: string) => void;
  onPreview: (speakerId: string, category: string) => void;
  previewingSpeaker: string | null;
  previewLoading: string | null;
  previewError: string | null;
  catalogSources: VoiceCatalogSourceStatus[];
  h?: string;
}

function VoicePickerCard({
  title,
  icon,
  searchVal,
  onSearch,
  catVal,
  onCat,
  categories,
  filtered,
  selected,
  onSelect,
  favorites,
  onToggleFavorite,
  onPreview,
  previewingSpeaker,
  previewLoading,
  previewError,
  catalogSources,
  h = 'h-[360px]',
}: VoicePickerCardProps) {
  const VOICE_BATCH_SIZE = 24;
  const [visibleCount, setVisibleCount] = useState(VOICE_BATCH_SIZE);
  useEffect(() => { setVisibleCount(VOICE_BATCH_SIZE); }, [searchVal, catVal]);
  const visibleVoices = filtered.slice(0, visibleCount);
  const selectedInFilter = selected && filtered.some(voice => voice.speakerId === selected.speakerId);
  const catalogPending = catalogSources.some(source => source.loading);
  const catalogFailed = catalogSources.some(source => source.error);
  const hasFilters = Boolean(searchVal.trim()) || catVal !== '全部';
  const renderedVoices = selectedInFilter && !visibleVoices.some(voice => voice.speakerId === selected.speakerId)
    ? [selected, ...visibleVoices]
    : visibleVoices;

  return (
    <div data-voice-picker={title} aria-busy={catalogPending} className={`vs-voice-picker bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl overflow-hidden flex flex-col ${h}`}>
      <div className="vs-voice-picker-heading px-5 py-3.5 flex items-center gap-2.5 border-b border-[var(--vs-border)] shrink-0 bg-[var(--vs-surface)]/30">
        {icon}
        <span className="font-semibold text-[var(--vs-text)] text-base leading-6">{title}</span>
      </div>
      <div className="vs-voice-filters p-4 space-y-3.5 shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-medium text-[var(--vs-text)] shrink-0">搜索音色</span>
          <input
            aria-label={`${title}搜索`}
            className="h-9 min-w-0 flex-1 px-3 py-1 rounded-lg bg-[var(--vs-surface)] border border-[var(--vs-border)] text-[var(--vs-text)] placeholder-[var(--vs-text-secondary)] text-sm leading-5 focus:outline-none focus:border-[var(--vs-primary)]/50 focus-visible:ring-2 focus-visible:ring-[var(--vs-primary)]/20"
            placeholder="名称或ID..."
            value={searchVal}
            onChange={event => onSearch(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-medium text-[var(--vs-text)] shrink-0">音色分类</span>
          <select
            aria-label={`${title}分类`}
            className="h-9 min-w-0 flex-1 px-3 py-1 rounded-lg bg-[var(--vs-surface)] border border-[var(--vs-border)] text-[var(--vs-text)] text-sm leading-5 focus:outline-none focus:border-[var(--vs-primary)]/50 focus-visible:ring-2 focus-visible:ring-[var(--vs-primary)]/20 cursor-pointer"
            value={catVal}
            onChange={event => onCat(event.target.value)}
          >
            {categories.map(category => (
              <option key={category} value={category}>
                {category === '全部' ? '全部音色' : category === '我的收藏' ? '★ 我的收藏' : category}
              </option>
            ))}
          </select>
        </div>
        {hasFilters && <button
          type="button"
          aria-label={`${title}清除筛选`}
          className="text-sm text-[var(--vs-primary)] underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vs-primary)]"
          onClick={() => { onSearch(''); onCat('全部'); }}
        >清除筛选</button>}
        {selected && <p title={`已选：${selected.name}`} className="vs-selected-voice text-xs text-[var(--vs-text-secondary)]">
          已选：{selected.name}{!selectedInFilter && '（未显示在当前列表中）'}
        </p>}
        {catalogSources.map(source => source.loading ? (
          <p key={source.id} role="status" data-voice-catalog-source={source.id} data-catalog-state="loading" className="text-sm text-[var(--vs-text-secondary)]">
            正在读取{source.label}…
          </p>
        ) : source.error ? (
          <div key={source.id} role="alert" data-voice-catalog-source={source.id} data-catalog-state="error" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--vs-border)] bg-[var(--vs-surface)] px-3 py-2 text-sm text-[var(--vs-text)]">
            <span>{source.error}</span>
            <button type="button" onClick={source.onRetry} className="text-[var(--vs-primary)] underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--vs-primary)]">
              重新读取{source.label}
            </button>
          </div>
        ) : null)}
      </div>
      <div className="vs-voice-scroll flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        <div className="vs-voice-grid">
          {renderedVoices.map(voice => {
            const isFav = favorites.has(voice.speakerId);
            const isSelected = selected?.speakerId === voice.speakerId;
            const gradient = getGradient(voice.gender);
            const isThisPlaying = previewingSpeaker === voice.speakerId;
            const isThisLoading = previewLoading === voice.speakerId;

            return (
              <div
                key={voice.speakerId}
                role="button"
                tabIndex={0}
                data-workbench-control="choice"
                data-voice-option={voice.speakerId}
                aria-pressed={isSelected}
                onClick={() => onSelect(voice)}
                onKeyDown={(event) => {
                  if (event.currentTarget !== event.target) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(voice);
                  }
                }}
                className={`vs-voice-option group relative flex items-center gap-3 px-2.5 py-2 rounded-xl cursor-pointer transition-all border ${
                  isSelected
                    ? 'brand-action'
                    : 'border-transparent hover:border-[var(--vs-border)] hover:bg-[var(--vs-surface)]/50'
                }`}
              >
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onPreview(voice.speakerId, voice.category);
                  }}
                  aria-label={`${isThisPlaying ? '停止试听' : isThisLoading ? '取消加载' : '试听'} ${voice.name}`}
                  className={`relative w-9 h-9 rounded-lg overflow-hidden bg-gradient-to-br ${gradient} shrink-0 flex items-center justify-center text-white text-xs font-bold ring-1 ring-white/10 active:scale-[0.92] transition-transform cursor-pointer`}
                  title={isThisPlaying ? '停止试听' : '点击试听'}
                >
                  <VoicePortrait speakerId={voice.speakerId} name={voice.name} gender={voice.gender} />
                  <span className={`absolute inset-0 flex items-center justify-center transition-opacity ${isThisPlaying || isThisLoading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} bg-black/50`}>
                    {isThisLoading ? (
                      <span className="w-3 h-3 border-2 border-white/60 border-t-white rounded-full animate-spin" />
                    ) : isThisPlaying ? (
                      <Square className="w-3.5 h-3.5 text-white fill-white" />
                    ) : (
                      <Play className="w-3.5 h-3.5 text-white fill-white ml-0.5" />
                    )}
                  </span>
                </button>

                <div className="flex-1 min-w-0">
                  <div className="vs-voice-option-name flex items-center gap-2">
                    <span className={`text-sm font-semibold truncate ${isSelected ? 'text-[var(--brand-action-fg)]' : 'text-[var(--vs-text)]'}`}>
                      {voice.name}
                    </span>
                    {voice.tags?.[0] && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-cyan-400/10 text-cyan-300 font-medium shrink-0 border border-cyan-400/15">
                        {voice.tags[0]}
                      </span>
                    )}
                  </div>
                  <div className={`text-[11px] truncate mt-0.5 leading-tight ${isSelected ? "text-[var(--brand-action-fg)]" : "text-[var(--vs-text-muted)]"}`}>
                    {voice.description}
                  </div>
                </div>

                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFavorite(voice.speakerId);
                  }}
                  aria-label={`${isFav ? '取消收藏' : '收藏'} ${voice.name}`}
                  aria-pressed={isFav}
                  className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all shrink-0 ${
                    isFav
                      ? 'text-rose-400 bg-rose-400/10 hover:bg-rose-400/20'
                      : 'text-[var(--vs-text-muted)] hover:text-rose-400 hover:bg-rose-400/10'
                  }`}
                  title={isFav ? '取消收藏' : '收藏'}
                >
                  <Heart className={`w-3.5 h-3.5 ${isFav ? 'fill-current' : ''}`} />
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && !catalogPending && !catalogFailed && (
            <div className="py-12 text-center text-sm text-[var(--vs-text-muted)]">
              {hasFilters ? '没有匹配的音色' : '暂无音色'}
            </div>
          )}
          {filtered.length > visibleCount && (
            <button
              type="button"
              className="w-full rounded-lg border border-[var(--vs-border)] px-3 py-2 text-xs text-[var(--vs-text-muted)] hover:border-[var(--vs-primary)]/40 hover:text-[var(--vs-text)]"
              aria-label={`${title}显示更多音色，当前显示 ${Math.min(visibleCount, filtered.length)} 个，共 ${filtered.length} 个`}
              onClick={() => setVisibleCount(count => Math.min(filtered.length, count + VOICE_BATCH_SIZE))}
            >
              显示更多音色 · {Math.min(visibleCount, filtered.length)} / {filtered.length}
            </button>
          )}
          {filtered.length > VOICE_BATCH_SIZE && visibleCount >= filtered.length && (
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-xs text-[var(--vs-text-muted)] hover:text-[var(--vs-text)]"
              aria-label={`${title}收起音色列表`}
              onClick={() => setVisibleCount(VOICE_BATCH_SIZE)}
            >
              收起音色列表
            </button>
          )}
        </div>
        {previewError && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 text-center">
            {previewError}
          </div>
        )}
      </div>
    </div>
  );
}

interface TextInputCardProps {
  title: string;
  icon: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  maxLen: number;
  h?: string;
  placeholder?: string;
  actionBtn?: React.ReactNode;
  children?: React.ReactNode;
}

function TextInputCard({
  title,
  icon,
  value,
  onChange,
  maxLen,
  h = 'min-h-[200px]',
  placeholder = '输入要合成的文本内容...',
  actionBtn,
  children,
}: TextInputCardProps) {
  return (
    <div data-voice-input-card={title} className={`vs-text-input-card bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl overflow-hidden flex flex-col ${h}`}>
      <div className="px-5 py-3 flex items-center justify-between border-b border-[var(--vs-border)] shrink-0">
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium text-[var(--vs-text)] text-[15px]">{title}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--vs-text-secondary)]">{value.length} / {maxLen.toLocaleString()} 字</span>
          {actionBtn}
        </div>
      </div>
      <div className="flex-1 min-h-0 p-4 flex flex-col">
        {children && <div className="mb-3">{children}</div>}
        <textarea
          aria-label={title}
          className="vs-text-input-control flex-1 w-full resize-none bg-[var(--vs-surface)] border border-[var(--vs-border)] rounded-xl p-4 text-[var(--vs-text)] placeholder-[var(--vs-text-secondary)] text-sm leading-relaxed focus:outline-none focus:border-[var(--vs-primary)]/50"
          placeholder={placeholder}
          value={value}
          maxLength={maxLen}
          onChange={event => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

function WorkspaceContent() {
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <div className="min-h-screen p-8 text-center text-[var(--vs-text)]"><p role="status">请登录后使用智音工坊</p><a href="/" className="mt-4 inline-block underline">返回主页登录</a></div>;
  return <UserVoiceWorkspace key={identity.userId} identity={identity} />;
}

function UserVoiceWorkspace({ identity }: { identity: WorkbenchIdentity }) {
  const auth = { token: identity.token };
  const referenceAudioGate = useReferenceAudioRuntimeGate(identity.token);
  const hasAuthToken = !!auth?.token;
  const authHeaders: Record<string, string> = hasAuthToken ? { Authorization: `Bearer ${auth.token}` } : {};
  const [enabledPricingModels, setEnabledPricingModels] = useState<string[] | null>(null);
  const [pricingError, setPricingError] = useState('');
  const [pricingReload, setPricingReload] = useState(0);
  const [advancedSettingsExpanded, setAdvancedSettingsExpanded] = useState(true);
  useEffect(() => {
    setAdvancedSettingsExpanded(!window.matchMedia('(min-width: 1024px) and (max-height: 820px)').matches);
  }, []);

  useEffect(() => {
    let active = true;
    setPricingError('');
    void loadEnabledPricingModels(pricingReload)
      .then(models => { if (active) setEnabledPricingModels(models); })
      .catch(() => { if (active) { setEnabledPricingModels(null); setPricingError('模型列表暂时无法读取'); } });
    return () => { active = false; };
  }, [pricingReload]);
  const isModeAvailable = (value: string) => enabledPricingModels?.includes(value === 'mix' ? 'seed-tts-1.0' : value === 'audio-gen' || value === 'seed-audio' ? 'seed-audio-1.0' : 'seed-tts-2.0') === true;
  const searchParams = useSearchParams();
  const preloadSpeaker = searchParams.get('speaker');
  const preloadHandledRef = useRef<string | null>(null);
  const [officialVoices, setOfficialVoices] = useState<Voice[]>([]);
  const [userVoices, setUserVoices] = useState<Voice[]>([]);
  const voices = useMemo(() => [...officialVoices, ...userVoices], [officialVoices, userVoices]);
  const [officialLoading, setOfficialLoading] = useState(true);
  const [userVoicesLoading, setUserVoicesLoading] = useState(true);
  const [officialError, setOfficialError] = useState('');
  const [userVoicesError, setUserVoicesError] = useState('');
  const [officialReload, setOfficialReload] = useState(0);
  const [userVoicesReload, setUserVoicesReload] = useState(0);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [selectedVoice2, setSelectedVoice2] = useState<Voice | null>(null);
  const selectPrimaryVoice = (voice: Voice) => {
    preloadHandledRef.current = preloadSpeaker;
    setSelectedVoice(voice);
  };
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部');
  const [search2, setSearch2] = useState('');
  const [category2, setCategory2] = useState('全部');
  const [voiceFilter2, setVoiceFilter2] = useState<'all' | 'favorites' | 'cloned' | 'designed'>('all');
  const { favorites, favoriteError, toggleFavorite: saveFavorite } = useVoiceFavorites(identity.userId,auth?.token);
  const [previewingSpeaker, setPreviewingSpeaker] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewSequenceRef = useRef(0);
  const [voiceFilter, setVoiceFilter] = useState<'all' | 'favorites' | 'cloned' | 'designed'>('all');
  const [text, setText] = useState('');
  const [text2, setText2] = useState('');
  const [ssml, setSsml] = useState('');
  const [useSsml] = useState(false);

  const [pitch, setPitch] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [volume, setVolume] = useState(0);
  const [synthesizing, setSynthesizing] = useState(false);
  const [result, setResult] = useState<VoiceResult | null>(null);
  const [error, setError] = useState('');
  const [historyRestoreNotice, setHistoryRestoreNotice] = useState('');
  const [historyRefreshRevision, setHistoryRefreshRevision] = useState(0);
  useEffect(() => { if(favoriteError)setError(favoriteError); },[favoriteError]);
  const [model, setModel] = useState<'tts' | 'audio'>('tts');
  const [mode, setMode] = useState<'single' | 'dual' | 'long-text' | 'mix' | 'audio-gen'>('single');

  const [longTextStatus, setLongTextStatus] = useState<'idle' | 'submitted' | 'processing' | 'success' | 'failed'>('idle');
  const [longTextAudioUrl, setLongTextAudioUrl] = useState<string | null>(null);

  const [mixVoices, setMixVoices] = useState<Array<{ voice: Voice | null; factor: number }>>([
    { voice: null, factor: 0.5 },
    { voice: null, factor: 0.5 },
  ]);

  const [audioGenText, setAudioGenText] = useState('');
  const [audioGenLinks, setAudioGenLinks] = useState<AudioGenReference[]>([]);
  const [audioGenLinkInput, setAudioGenLinkInput] = useState('');

  // 添加/删除音频生成参考链接
  const [extractingAudio, setExtractingAudio] = useState(false);
  const [showAudioGenChargeConfirm, setShowAudioGenChargeConfirm] = useState(false);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 上传本地参考音频
  const handleUploadAudio = async (file: File) => {
    if (file.size > MAX_REFERENCE_AUDIO_BYTES) {
      setError('参考音频不能超过 15MB，请压缩或截短后重试。');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (audioGenLinks.length >= MAX_SEED_AUDIO_REFERENCES) {
      setError(`最多添加 ${MAX_SEED_AUDIO_REFERENCES} 条参考音频。`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    try {
      setUploadingAudio(true);
      setError('');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', file.name.replace(/\.[^/.]+$/, '') || '参考音频');
      const resp = await fetch('/api/voice/upload', {
        method: 'POST',
        headers: authHeaders,
        body: fd,
      });
      const data = await resp.json();
      if (resp.ok && data.success && data.voice?.id && data.voice?.url) {
        setAudioGenLinks(previous => previous.some(item => item.assetId === String(data.voice.id))
          ? previous
          : [...previous, {
            assetId: String(data.voice.id),
            url: String(data.voice.url),
            name: String(data.voice.name || file.name),
            source: 'upload' as const,
          }]);
      } else {
        setError(data.error || '音频上传失败');
      }
    } catch (e) {
      console.error('[audioGen] 上传失败:', e);
      setError('音频上传失败');
    } finally {
      setUploadingAudio(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };
  const requestAudioGenLink = () => {
    const url = audioGenLinkInput.trim();
    if (!url || extractingAudio) return;
    if (audioGenLinks.length >= MAX_SEED_AUDIO_REFERENCES) {
      setError(`最多添加 ${MAX_SEED_AUDIO_REFERENCES} 条参考音频。`);
      return;
    }
    if (!/douyin\.com|xiaohongshu\.com|iesdouyin\.com|v\.douyin\.com/i.test(url)) {
      setError('仅支持抖音或小红书分享链接；直接音频请使用“上传音频”。');
      return;
    }
    if (!referenceAudioGate.ready) {
      setError('视频解析通道或价格尚未就绪，暂不能提交链接提取。');
      return;
    }
    setError('');
    setShowAudioGenChargeConfirm(true);
  };
  const addAudioGenLink = async () => {
    const url = audioGenLinkInput.trim();
    if (!url) return;
    if (audioGenLinks.length >= MAX_SEED_AUDIO_REFERENCES) {
      setError(`最多添加 ${MAX_SEED_AUDIO_REFERENCES} 条参考音频。`);
      return;
    }
    const isVideoLink = /douyin\.com|xiaohongshu\.com|iesdouyin\.com|v\.douyin\.com/i.test(url);
    if (!isVideoLink) {
      setError('仅支持抖音或小红书分享链接；直接音频请使用“上传音频”。');
      return;
    }
    try {
      setExtractingAudio(true);
      setShowAudioGenChargeConfirm(false);
      setError('');
      const extracted = await extractReferenceAudioFromShareLink({
        shareText: url,
        duration: REFERENCE_AUDIO_DEFAULT_DURATION_SECONDS,
        userId: identity.userId,
        token: identity.token,
      });
      setAudioGenLinks(previous => previous.some(item => item.assetId === extracted.assetId)
        ? previous
        : [...previous, {
          assetId: extracted.assetId,
          url: extracted.url,
          name: extracted.name,
          source: 'link' as const,
        }]);
      setAudioGenLinkInput('');
    } catch (e) {
      console.error('[audioGen] 提取失败:', e);
      setError(e instanceof Error ? e.message : '链接音频提取失败');
    } finally {
      setExtractingAudio(false);
    }
  };
  const removeAudioGenLink = (idx: number) => {
    setAudioGenLinks(audioGenLinks.filter((_, i) => i !== idx));
  };
  const [modelVersion, setModelVersion] = useState<typeof MODEL_VERSIONS[number]['value']>('seed-tts-2.0-expressive');
  const [voiceQuote, setVoiceQuote] = useState<{ key: string; credits: number; retailPrice: number; adminExempt: boolean; reservationSeconds?: number } | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [quoteRetry, setQuoteRetry] = useState(0);
  const quoteSpeaker = selectedVoice?.speakerId || selectedVoice?.id || '';
  const quoteModel = modelVersion === 'auto' ? 'seed-tts-2.0-expressive' : modelVersion;
  const quoteSpeaker2 = selectedVoice2?.speakerId || selectedVoice2?.id || '';
  const canonicalSingleInput = useSsml ? ssml.trim() : text.trim();
  const quotePayload = mode === 'audio-gen' ? { textPrompt: audioGenText.trim(), references: audioGenLinks.map(item => ({ assetId: item.assetId })), model: 'seed-audio-1.0' }
    : mode === 'dual' ? { mode: 'dual', text: text.trim(), text2: text2.trim(), speaker: quoteSpeaker, speaker2: quoteSpeaker2, model: quoteModel }
    : mode === 'mix' ? { text: text.trim(), mixSpeakers: mixVoices.map(item => ({ speaker: item.voice?.speakerId || item.voice?.id || '', factor: item.factor })), model: 'seed-tts-1.0' }
    : mode === 'single' && useSsml
      ? { mode, ssml: canonicalSingleInput, speaker: quoteSpeaker, model: quoteModel }
      : { mode, text: text.trim(), speaker: quoteSpeaker, model: quoteModel };
  const missingInputs: string[] = [];
  if (mode === 'audio-gen') {
    if (!audioGenLinks.length) missingInputs.push('添加参考音频');
    if (!audioGenText.trim()) missingInputs.push('输入提示词');
  } else if (mode === 'dual') {
    if (!quoteSpeaker || !quoteSpeaker2) missingInputs.push('为两个角色选择音色');
    if (!text.trim() || !text2.trim()) missingInputs.push('填写两个角色的台词');
  } else if (mode === 'mix') {
    if (mixVoices.length < 2 || mixVoices.some(item => !item.voice)) missingInputs.push('选齐混音音色');
    if (!text.trim()) missingInputs.push('输入文案');
  } else {
    if (!quoteSpeaker) missingInputs.push('选择音色');
    if (!canonicalSingleInput) missingInputs.push('输入文案');
  }
  const quoteInputsReady = missingInputs.length === 0;
  const quoteInputKey = JSON.stringify(quotePayload);
  const quoteReady = voiceQuote?.key === quoteInputKey;
  useEffect(() => {
    setVoiceQuote(null);
    setQuoteError('');
    if (!quoteInputsReady || !identity.token || !isModeAvailable(mode)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch('/api/voice/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
        body: JSON.stringify({ ...JSON.parse(quoteInputKey), operation: 'quote' }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      }).then(async response => {
        const result = await response.json();
        if (!response.ok || !result.success || result.data?.quoteOnly !== true) throw new Error(result.message || '费用暂时无法读取');
        if (!controller.signal.aborted) setVoiceQuote({ key: quoteInputKey, credits: Number(result.data.quotedCredits), retailPrice: Number(result.data.retailPrice), adminExempt: result.data.adminExempt === true, reservationSeconds: result.data.reservationSeconds });
      }).catch(error => { if (!controller.signal.aborted) setQuoteError(error instanceof Error ? error.message : '费用暂时无法读取'); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mode, quoteInputsReady, quoteInputKey, identity.token, quoteRetry, enabledPricingModels]);
  const [emotion, setEmotion] = useState('none');
  const [emotionIntensity, setEmotionIntensity] = useState(0.5);
  const [silenceFinal, setSilenceFinal] = useState(0);
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'wav' | 'ogg_opus'>('mp3');
  const [sampleRate, setSampleRate] = useState<typeof SAMPLE_RATES[number]>(24000);
  const [language, setLanguage] = useState('auto');
  const [dialect, setDialect] = useState('mandarin');

  const [subtitle, setSubtitle] = useState(false);
  const [subtitleTimestamp, setSubtitleTimestamp] = useState(false);
  const [useCache, setUseCache] = useState(false);
  const [silenceSeg, setSilenceSeg] = useState(false);
  const [langDetect, setLangDetect] = useState(false);
  const [filterMd, setFilterMd] = useState(false);
  const [filterEmoji, setFilterEmoji] = useState(false);
  const [latex, setLatex] = useState(false);
  const [aigcTag, setAigcTag] = useState(false);

  const [voiceInstruction, setVoiceInstruction] = useState('');
  const [activeTab, setActiveTab] = useState<'role1' | 'role2'>('role1');

  const categories = useMemo(() => {
    const cats = new Set(voices.map(v => v.category));
    for (const selectedCategory of [category, category2]) {
      if (selectedCategory !== '全部' && selectedCategory !== '我的收藏') cats.add(selectedCategory);
    }
    // 把"模拟真人"置顶（高优先级分类），其他按字母序
    const list = Array.from(cats);
    const priorityOrder = ['模拟真人', '角色动漫', '情感治愈', '短视频配音', '克隆', '设计', '其他'];
    list.sort((a, b) => {
      const ai = priorityOrder.indexOf(a);
      const bi = priorityOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return ['全部', '我的收藏', ...list];
  }, [voices, category, category2]);

  const filteredVoices = useMemo(() => {
    return voices.filter(v => {
      const matchSearch = v.name.toLowerCase().includes(search.toLowerCase()) ||
        v.speakerId.toLowerCase().includes(search.toLowerCase());
      const matchCategory = category === '全部' || category === '我的收藏'
        ? true
        : v.category === category;
      const matchFav = category === '我的收藏' ? favorites.has(v.speakerId) : true;
      return matchSearch && matchCategory && matchFav;
    });
  }, [voices, search, category, favorites]);

  const filteredVoices2 = useMemo(() => {
    return voices.filter(v => {
      const matchSearch = v.name.toLowerCase().includes(search2.toLowerCase()) ||
        v.speakerId.toLowerCase().includes(search2.toLowerCase());
      const matchCategory = category2 === '全部' || category2 === '我的收藏'
        ? true
        : v.category === category2;
      const matchCategoryFavorite = category2 === '我的收藏' ? favorites.has(v.speakerId) : true;
      let matchFilter = true;
      if (voiceFilter2 === 'favorites') matchFilter = favorites.has(v.speakerId);
      else if (voiceFilter2 === 'cloned') matchFilter = v.category === '克隆';
      else if (voiceFilter2 === 'designed') matchFilter = v.category === '设计';
      return matchSearch && matchCategory && matchCategoryFavorite && matchFilter;
    });
  }, [voices, search2, category2, voiceFilter2, favorites]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setOfficialLoading(true);
    setOfficialError('');
    void (async () => {
      try {
        const response = await fetch('/api/voice/list?page=1&limit=500', {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        const result = await response.json();
        if (!response.ok || result.success !== true || !Array.isArray(result.data?.voices)) throw new Error('VOICE_CATALOG_UNAVAILABLE');
        const official = result.data.voices.map((voice: Voice) => ({ ...voice, id: voice.speakerId, tags: voice.tags || [] }));
        if (active) setOfficialVoices(official);
      } catch {
        if (active) setOfficialError('官方音色暂时无法读取。');
      } finally {
        if (active) setOfficialLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [officialReload]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setUserVoicesLoading(true);
    setUserVoicesError('');
    void (async () => {
      try {
        const response = await fetch('/api/voice/user-voices', {
          headers: { Authorization: `Bearer ${identity.token}` }, cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        const result = await response.json();
        if (!response.ok || result.success !== true || !Array.isArray(result.voices)) throw new Error('USER_VOICE_CATALOG_UNAVAILABLE');
        if (active) setUserVoices(result.voices as UserVoiceDto[]);
      } catch {
        if (active) setUserVoicesError('我的定制音色暂时无法读取。');
      } finally {
        if (active) setUserVoicesLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [identity.token, userVoicesReload]);

  useEffect(() => {
    if (!preloadSpeaker) { preloadHandledRef.current = null; return; }
    if (preloadHandledRef.current === preloadSpeaker) return;
    const voice = voices.find(item => item.speakerId === preloadSpeaker);
    if (voice) {
      preloadHandledRef.current = preloadSpeaker;
      setSelectedVoice(voice);
    }
  }, [preloadSpeaker, voices]);

  const catalogSources: VoiceCatalogSourceStatus[] = [
    { id: 'official', label: '官方音色', loading: officialLoading, error: officialError, onRetry: () => setOfficialReload(value => value + 1) },
    { id: 'user', label: '我的定制音色', loading: userVoicesLoading, error: userVoicesError, onRetry: () => setUserVoicesReload(value => value + 1) },
  ];

  const toggleFavorite = (speakerId:string) => { const voice=voices.find(v=>v.speakerId===speakerId); if(voice)void saveFavorite(voice); };

  // -------- 音色试听：点击头像播放/停止；快速切换时取消旧结果 --------
  const handlePreviewVoice = async (speakerId: string, category: string) => {
    setPreviewError(null);
    const stopCurrent = () => {
      const current = previewAudioRef.current;
      if (!current) return;
      current.pause();
      current.onended = null;
      current.onerror = null;
      if (current.src.startsWith('blob:')) URL.revokeObjectURL(current.src);
      current.src = '';
      previewAudioRef.current = null;
    };
    const wasCurrent = previewingSpeaker === speakerId || previewLoading === speakerId;
    previewSequenceRef.current += 1;
    stopCurrent();
    setPreviewingSpeaker(null);
    setPreviewLoading(null);
    if (wasCurrent) return;

    const ticket = ++previewSequenceRef.current;
    setPreviewLoading(speakerId);

    try {
      const { audioUrl } = await loadPreview(speakerId, category);
      if (ticket !== previewSequenceRef.current) {
        if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl);
        return;
      }
      const audio = new Audio();
      let settled = false;

      audio.onended = () => {
        if (settled || ticket !== previewSequenceRef.current) return;
        settled = true;
        if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
        audio.src = '';
        setPreviewingSpeaker(null);
        previewAudioRef.current = null;
      };
      audio.onerror = () => {
        if (settled || ticket !== previewSequenceRef.current) return;
        settled = true;
        console.error('[Workspace Preview] audio.onerror:', { speakerId, src: audio.src.slice(0, 80), errorCode: audio.error?.code });
        if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
        audio.src = '';
        previewAudioRef.current = null;
        setPreviewingSpeaker(null);
        setPreviewError('音频加载失败，请稍后重试');
        setTimeout(() => setPreviewError(null), 3000);
      };

      previewAudioRef.current = audio;
      audio.src = audioUrl;
      audio.load();

      // 等待 canplaythrough 确保浏览器解码完成后再播放
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), 10000);
        audio.oncanplaythrough = () => { clearTimeout(timeout); resolve(); };
        const origError = audio.onerror;
        audio.onerror = (e) => {
          clearTimeout(timeout);
          if (origError) origError.call(audio, e);
          reject(new Error('音频加载失败'));
        };
      });

      await audio.play();
      if (!settled && ticket === previewSequenceRef.current) {
        setPreviewingSpeaker(speakerId);
      }
    } catch (err: unknown) {
      if (ticket !== previewSequenceRef.current) return;
      stopCurrent();
      setPreviewingSpeaker(null);
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Workspace Preview] error:', { speakerId, error: msg, errorName: err instanceof Error ? err.name : 'Unknown' });
      if (msg.includes('API Key') || msg.includes('引擎') || msg.includes('配置')) {
        setPreviewError('试听服务暂时不可用，请稍后重试');
      } else if (msg.includes('429')) {
        setPreviewError('试听请求过于频繁，请稍后再试');
      } else if (msg.includes('not granted') || msg.includes('mismatch')) {
        setPreviewError('该音色暂不支持试听');
      } else if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPreviewError('浏览器拦截了自动播放，请再次点击试听');
      } else {
        setPreviewError('试听加载失败，请稍后重试');
      }
      setTimeout(() => setPreviewError(null), 3000);
    } finally {
      if (ticket === previewSequenceRef.current) setPreviewLoading(null);
    }
  };

  // 组件卸载时清理音频
  useEffect(() => {
    return () => {
      previewSequenceRef.current += 1;
      const audio = previewAudioRef.current;
      if (!audio) return;
      audio.pause();
      if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
      audio.src = '';
      previewAudioRef.current = null;
    };
  }, []);

  // -------- 合成处理器：5个模式（对齐火山引擎官方 API）--------

  // 通用合成参数构造器（让5个模式共享参数配置）
  const buildBaseParams = () => ({
    model: modelVersion === 'auto' ? 'seed-tts-2.0-expressive' : modelVersion,
    speechRate: speed,
    pitchRate: pitch,
    loudnessRate: volume,
    format: audioFormat,
    sampleRate,
    emotion,
    emotionIntensity,
    silenceFinal,
    language,
    dialect,
    voiceInstruction: voiceInstruction || undefined,
    subtitle,
    subtitleTimestamp,
    aigcTag,
    useCache,
    silenceSeg,
    latex,
    langDetect,
    filterMd,
    filterEmoji,
  });

  // 单人模式：TTS流式合成
  const acceptVoiceResult = (data: Record<string, any>) => {
    setResult({
      audioUrl: String(data.audioUrl || ''),
      duration: Number(data.duration || 0),
      subtitles: data.subtitles,
      logId: data.logId,
      generationId: data.generationId,
      providerTaskId: data.providerTaskId,
      cost: Number(data.cost || 0),
      quotedCredits: Number(data.quotedCredits || 0),
      retailPrice: Number(data.retailPrice || 0),
      warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
      asset: data.asset || null,
    });
  };

  const restoreHistoryGeneration = (item: VoiceGeneration) => {
    preloadHandledRef.current = preloadSpeaker;
    if (item.status === 'success') {
      setResult({
        audioUrl: item.outputAudioUrl || '', duration: item.outputDuration || 0,
        generationId: item.id, cost: item.cost,
        asset: item.outputAssetId ? { id: item.outputAssetId, contentType: item.outputContentType, size: item.outputFileSize } : null,
      });
      setHistoryRestoreNotice('已读取历史结果，可继续试听或下载。');
      return;
    }

    if (!canLoadVoiceHistoryForRetry(item)) {
      setHistoryRestoreNotice(`${voiceHistoryRetryUnavailableReason(item)}；不会自动提交。`);
      return;
    }

    const restoredVoice = voices.find(voice => (
      voice.name === item.voiceModelName
      || voice.speakerId === item.voiceModelName
      || voice.id === item.voiceModelName
    )) || null;
    setResult(null);
    setModel('tts');
    setMode('single');
    setText(item.inputText || '');
    setSelectedVoice(restoredVoice);
    const restoredSpeed = Number(item.speedRatio);
    if (Number.isFinite(restoredSpeed)) setSpeed(Math.min(100, Math.max(-50, restoredSpeed)));
    if (['mp3', 'wav', 'ogg_opus'].includes(item.outputFormat)) setAudioFormat(item.outputFormat as 'mp3' | 'wav' | 'ogg_opus');
    if (['', 'happy', 'sad', 'angry', 'surprised', 'neutral'].includes(item.emotion || '')) setEmotion(item.emotion || '');
    setError('');
    setHistoryRestoreNotice(restoredVoice
      ? '已载入失败记录的原文、音色和可确认参数；请核对当前价格后再点击合成，本次会创建新任务。'
      : '已载入失败记录的原文和可确认参数；原音色当前不在目录中，请重新选择音色并核对价格后再合成。');
    window.requestAnimationFrame(() => document.getElementById('voice-synthesis-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const submitVoiceRequest = async (scope: string, payload: Record<string, unknown>) => {
    setHistoryRestoreNotice('');
    if (!isModeAvailable(scope)) throw new Error('当前模式暂不可用，请选择其他模式');
    if (!quoteReady) throw new Error('请等待本次费用确认后再合成');
    const fingerprint = await buildClientRequestFingerprint(payload);
    const storageKey = workbenchUserStorageKey(`voice-workspace:${scope}`, identity.userId);
    const attempt = resolveBrowserClientAttempt({
      storageKey,
      fingerprint,
      prefix: `voice-${scope}`,
    });
    const res = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': attempt.clientRequestId,
        ...authHeaders,
      },
      body: JSON.stringify({
        ...payload,
        client_request_id: attempt.clientRequestId,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (shouldReleaseVoiceAttempt(res, json)) {
      clearBrowserClientAttempt(storageKey, attempt.clientRequestId);
    }
    setHistoryRefreshRevision(value => value + 1);
    return { res, json };
  };

  const handleSynthesize = async () => {
    if (!selectedVoice || !canonicalSingleInput) {
      setError('请先选择音色并输入文本');
      return;
    }
    if (!quoteReady) { setError('请等待本次费用确认后再合成'); return; }
    setSynthesizing(true);
    setError('');
    setResult(null);
    try {
      const { res, json } = await submitVoiceRequest('single', {
        ...(useSsml ? { ssml: canonicalSingleInput } : { text: canonicalSingleInput }),
        speaker: selectedVoice.speakerId || selectedVoice.id,
        ...buildBaseParams(),
      });
      if (!res.ok || !json.success) throw new Error(customerVoiceError(json.message, '合成暂未完成，请稍后重试'));
      const data = json.data || {};
      acceptVoiceResult(data);
    } catch (e: any) {
      setError(customerVoiceError(e?.message, '合成暂未完成，请稍后重试'));
    } finally {
      setSynthesizing(false);
    }
  };

  // 双人模式：双路TTS流式并发
  const handleDualSynthesize = async () => {
    if (!selectedVoice || !selectedVoice2 || !text.trim() || !text2.trim()) {
      setError('请为两个角色分别选择音色并输入台词');
      return;
    }
    setSynthesizing(true);
    setError('');
    setResult(null);
    try {
      const { res, json } = await submitVoiceRequest('dual', {
        mode: 'dual',
        text: text.trim(),
        text2: text2.trim(),
        speaker: selectedVoice.speakerId || selectedVoice.id,
        speaker2: selectedVoice2.speakerId || selectedVoice2.id,
        ...buildBaseParams(),
      });
      if (!res.ok || !json.success) throw new Error(customerVoiceError(json.message, '双人合成暂未完成，请稍后重试'));
      const data = json.data || {};
      acceptVoiceResult(data);
    } catch (e: any) {
      setError(customerVoiceError(e?.message, '双人合成暂未完成，请稍后重试'));
    } finally {
      setSynthesizing(false);
    }
  };

  // Current long-text delivery is synchronous and shares the API's 5,000-character limit.
  const handleLongTextSynthesize = async () => {
    if (!selectedVoice || !text.trim()) {
      setError('请先选择音色并输入长文本');
      return;
    }
    if (text.length > 5000) {
      setError('长文本单次不超过 5000 字符');
      return;
    }
    setSynthesizing(true);
    setError('');
    setResult(null);
    setLongTextStatus('processing');
    setLongTextAudioUrl(null);
    try {
      const { res, json } = await submitVoiceRequest('long-text', {
        mode: 'long-text',
        text: text.trim(),
        speaker: selectedVoice.speakerId || selectedVoice.id,
        ...buildBaseParams(),
      });
      if (!res.ok || !json.success) throw new Error(customerVoiceError(json.message, '长文本合成暂未完成，请稍后重试'));
      const data = json.data || {};
      setLongTextStatus('success');
      setLongTextAudioUrl(data.audioUrl);
      acceptVoiceResult(data);
    } catch (e: any) {
      setError(customerVoiceError(e?.message, '长文本合成暂未完成，请稍后重试'));
      setLongTextStatus('failed');
    } finally {
      setSynthesizing(false);
    }
  };

  // 混音模式：多音色混合
  const handleMixSynthesize = async () => {
    if (!text.trim()) {
      setError('请输入要混音合成的文本');
      return;
    }
    if (mixVoices.length < 2 || mixVoices.length > 3) {
      setError('混音支持 2–3 个音色，请先移除多余音色；现有选择已保留');
      return;
    }
    if (mixVoices.some(item => !item.voice || !(item.voice.speakerId || item.voice.id))) {
      setError('请为每个混音位置选择有效音色');
      return;
    }
    if (mixVoices.some(item => !MIX_VOICES.some(voice => voice.speakerId === (item.voice!.speakerId || item.voice!.id)))) {
      setError('现有混音音色选择已保留，请在下拉框选择官方支持 MIX 的 TTS 1.0 音色');
      return;
    }
    if (mixVoices.some(item => !Number.isFinite(item.factor) || item.factor <= 0 || item.factor > 1)
      || Math.abs(mixVoices.reduce((sum, item) => sum + item.factor, 0) - 1) > 0.000001) {
      setError('每个音色比例必须大于 0，且比例总和需要等于 1.00');
      return;
    }
    setSynthesizing(true);
    setError('');
    setResult(null);
    try {
      const { res, json } = await submitVoiceRequest('mix', {
        text: text.trim(),
        mixSpeakers: mixVoices.map((m) => ({
          speaker: m.voice!.speakerId || m.voice!.id,
          factor: m.factor,
        })),
        ...buildBaseParams(),
        model: 'seed-tts-1.0',
        speed,
        volume,
      });
      if (!res.ok || !json.success) throw new Error(customerVoiceError(json.message, '混音合成暂未完成，请稍后重试'));
      const data = json.data || {};
      acceptVoiceResult(data);
    } catch (e: any) {
      setError(customerVoiceError(e?.message, '混音合成暂未完成，请稍后重试'));
    } finally {
      setSynthesizing(false);
    }
  };

  // 音频生成模式：Seed-Audio 1.0（参考音频 + 提示词）
  const handleAudioGen = async () => {
    if (!audioGenText.trim()) {
      setError('请输入提示词文案');
      return;
    }
    if (audioGenLinks.length === 0) {
      setError('请添加至少一个参考音频链接');
      return;
    }
    setSynthesizing(true);
    setError('');
    setResult(null);
    try {
      const { res, json } = await submitVoiceRequest('seed-audio', {
        textPrompt: audioGenText.trim(),
        references: audioGenLinks.map((item) => ({ assetId: item.assetId })),
        model: 'seed-audio-1.0',
        format: audioFormat,
        sampleRate,
      });
      if (!res.ok || !json.success) throw new Error(customerVoiceError(json.message, '音频生成暂未完成，请稍后重试'));
      const data = json.data || {};
      acceptVoiceResult(data);
    } catch (e: any) {
      setError(customerVoiceError(e?.message, '音频生成暂未完成，请稍后重试'));
    } finally {
      setSynthesizing(false);
    }
  };

  // One visible model selection owns the actual request branch. Selecting a
  // mode never submits; the explicit generate button remains the only submit.
  const handleSynthesisModelChange = (nextModel: 'tts' | 'audio') => {
    if (synthesizing || !isModeAvailable(nextModel === 'audio' ? 'audio-gen' : 'single')) return;
    setError('');
    setModel(nextModel);
    setMode(nextModel === 'audio' ? 'audio-gen' : mode === 'audio-gen' ? 'single' : mode);
  };
  const handleSynthesisModeChange = (nextMode: typeof mode) => {
    if (synthesizing || !isModeAvailable(nextMode)) return;
    setError('');
    setMode(nextMode);
    setModel(nextMode === 'audio-gen' ? 'audio' : 'tts');
  };

  const basicVoiceControls = mode !== 'audio-gen' ? (
    <div data-voice-basic-controls className={`grid gap-4 rounded-lg border border-[var(--vs-border)] bg-[var(--vs-surface)] px-3 py-2 ${mode === 'mix' ? 'grid-cols-2' : 'grid-cols-3'}`}>
      <Slider label="语速" value={speed} onChange={setSpeed} min={-50} max={100} />
      {mode !== 'mix' && <Slider label="音调" value={pitch} onChange={setPitch} min={-12} max={12} />}
      <Slider label="音量" value={volume} onChange={setVolume} min={-50} max={100} />
    </div>
  ) : null;

  // -------- 主渲染 --------

  return (
    <div data-voice-workspace="synthesis" className="secondary-workbench voice-studio-root bg-[var(--vs-bg)] text-[var(--vs-text)]">
      <ReferenceAudioChargeConfirm
        open={showAudioGenChargeConfirm}
        priceLabel={referenceAudioGate.priceLabel}
        busy={extractingAudio}
        onCancel={() => setShowAudioGenChargeConfirm(false)}
        onConfirm={() => void addAudioGenLink()}
      />
      <div className="vs-page-container">
        <div data-voice-workspace-intro className="vs-page-intro">
          {/* Hero 徽章 + 标题 + 描述 */}
          <div className="vs-page-hero">
            <div className="vs-page-kicker">VOICE STUDIO</div>
            <h1 className="vs-page-title">语音合成工作台</h1>
            <p className="vs-page-description">
              基于火山引擎 <span className="text-[var(--vs-primary)] font-semibold">Seed-TTS 2.0</span> / <span className="text-[var(--vs-primary)] font-semibold">Seed-Audio 1.0</span> · 高保真智能语音合成
            </p>
          </div>
          <div className="vs-history-flyout" title="生成历史">
            <span className="vs-history-flyout-icon" aria-hidden="true"><History /></span>
            <VoiceGenerationHistory token={auth?.token} refreshKey={`${result?.generationId || ''}:${historyRefreshRevision}`} onRestore={restoreHistoryGeneration} />
          </div>
        </div>

        {historyRestoreNotice && (
          <p role="status" data-history-restore-notice className="mb-4 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-200">
            {historyRestoreNotice}
          </p>
        )}

        <div className="vs-pricing-status mb-3 flex min-h-5 items-center text-sm">
          {pricingError && <p role="alert">{pricingError} <button type="button" className="underline" onClick={() => setPricingReload(value => value + 1)}>重新读取</button></p>}
          {!pricingError && enabledPricingModels === null && <p role="status">正在读取可用模型…</p>}
          {enabledPricingModels !== null && !isModeAvailable(mode) && <p role="status">当前模式暂不可用，请选择其他模式；已有历史仍可查看。</p>}
        </div>
        {/* 左侧集中声音配置，右侧设置与文案共享一列。 */}
        <div id="voice-synthesis-editor" data-voice-editor className="vs-synthesis-editor grid scroll-mt-6 grid-cols-1 gap-4">
          <aside data-voice-configuration className="vs-configuration-panel">
        {/* 模型、模式和音色共用配置面板。 */}
        <div className="vs-model-toolbar bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl px-3 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2.5">
              <span className="text-sm font-medium text-[var(--vs-text-muted)]">模型</span>
              <div className="flex bg-[var(--vs-surface)]/80 rounded-xl p-1 border border-[var(--vs-border)]">
                <button
                  data-workbench-control="choice"
                  aria-pressed={model === 'tts'}
                  className={`px-4 py-2 rounded-lg text-[15px] font-medium transition-all ${model === 'tts' ? 'brand-action' : 'text-[var(--vs-text-muted)] hover:text-[var(--vs-text)]'}`}
                  onClick={() => handleSynthesisModelChange('tts')}
                  disabled={synthesizing || !isModeAvailable('single')}
                >
                  {mode === 'mix' ? 'Doubao-TTS 1.0' : 'Doubao-TTS 2.0'}
                </button>
                <button
                  data-workbench-control="choice"
                  aria-pressed={model === 'audio'}
                  className={`px-4 py-2 rounded-lg text-[15px] font-medium transition-all ${model === 'audio' ? 'brand-action' : 'text-[var(--vs-text-muted)] hover:text-[var(--vs-text)]'}`}
                  onClick={() => handleSynthesisModelChange('audio')}
                  disabled={synthesizing || !isModeAvailable('audio-gen')}
                >
                  seed-audio 1.0
                </button>
              </div>
            </div>
          </div>
        </div>

          <div className="vs-compact-controls">
            <div className={`bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl vs-mode-section${mode === 'audio-gen' ? ' flex-1' : ''}`}>
            <div data-voice-mode-picker className="vs-mode-options">
              <span className="vs-control-label text-sm font-semibold text-[var(--vs-text)]">模式</span>
              {[
                  { v: 'single', icon: <Mic2 className="h-4 w-4" />, label: '单人模式' },
                  { v: 'dual', icon: <MessagesSquare className="h-4 w-4" />, label: '双人对话' },
                  { v: 'long-text', icon: <FileText className="h-4 w-4" />, label: '长文本合成' },
                  { v: 'mix', icon: <Music2 className="h-4 w-4" />, label: '混音合成' },
                  { v: 'audio-gen', icon: <Clapperboard className="h-4 w-4" />, label: '音频生成' },
                ].filter(m => isModeAvailable(m.v)).map(m => (
                  <button
                    key={m.v}
                    data-workbench-control="choice"
                    className={`flex shrink-0 items-center justify-center gap-2 px-3 py-2 whitespace-nowrap rounded-xl text-[15px] font-medium transition-all ${mode === m.v ? 'brand-action border' : 'bg-[var(--vs-surface)]/60 border border-[var(--vs-border)] text-[var(--vs-text-muted)] hover:text-[var(--vs-text)] hover:border-[var(--vs-primary)]/25 hover:bg-[var(--vs-surface-hover)]'}`}
                    onClick={() => handleSynthesisModeChange(m.v as typeof mode)}
                    disabled={synthesizing}
                    aria-pressed={mode === m.v}
                  >
                    <span aria-hidden="true">{m.icon}</span>
                    <span>{m.label}</span>
                    {mode === m.v && <span className="ml-1 text-xs">✓</span>}
                  </button>
                ))}
            </div>
            </div>
            {mode !== 'audio-gen' && (
              <div className="vs-basic-section">
                {basicVoiceControls}
              </div>
            )}
          </div>

          {/* 主要输入：音色选择 */}
          {mode === 'single' && (
            <VoicePickerCard
              title="选择音色"
              icon={<Music2 className="h-5 w-5" />}
              searchVal={search}
              onSearch={setSearch}
              catVal={category}
              onCat={setCategory}
              categories={categories}
              filtered={filteredVoices}
              selected={selectedVoice}
              onSelect={selectPrimaryVoice}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onPreview={handlePreviewVoice}
              previewingSpeaker={previewingSpeaker}
              previewLoading={previewLoading}
              previewError={previewError}
              catalogSources={catalogSources}
              h="vs-voice-catalog"
            />
          )}
          {mode === 'dual' && (
            <div className="vs-dual-catalogs flex flex-col gap-3 min-h-0">
              <VoicePickerCard
                title="角色一 音色"
                icon={<Mic2 className="h-5 w-5" />}
                searchVal={search}
                onSearch={setSearch}
                catVal={category}
                onCat={setCategory}
                categories={categories}
                filtered={filteredVoices}
                selected={selectedVoice}
                onSelect={selectPrimaryVoice}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
                onPreview={handlePreviewVoice}
                previewingSpeaker={previewingSpeaker}
                previewLoading={previewLoading}
                previewError={previewError}
                catalogSources={catalogSources}
                h="vs-voice-catalog"
              />
              <VoicePickerCard
                title="角色二 音色"
                icon={<AudioLines className="h-5 w-5" />}
                searchVal={search2}
                onSearch={setSearch2}
                catVal={category2}
                onCat={setCategory2}
                categories={categories}
                filtered={filteredVoices2}
                selected={selectedVoice2}
                onSelect={setSelectedVoice2}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
                onPreview={handlePreviewVoice}
                previewingSpeaker={previewingSpeaker}
                previewLoading={previewLoading}
                previewError={previewError}
                catalogSources={catalogSources}
                h="vs-voice-catalog"
              />
            </div>
          )}
          {mode === 'long-text' && (
            <VoicePickerCard
              title="选择音色"
              icon={<Music2 className="h-5 w-5" />}
              searchVal={search}
              onSearch={setSearch}
              catVal={category}
              onCat={setCategory}
              categories={categories}
              filtered={filteredVoices}
              selected={selectedVoice}
              onSelect={selectPrimaryVoice}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onPreview={handlePreviewVoice}
              previewingSpeaker={previewingSpeaker}
              previewLoading={previewLoading}
              previewError={previewError}
              catalogSources={catalogSources}
              h="vs-voice-catalog"
            />
          )}
          </aside>
          <div className="vs-writing-column flex flex-col gap-4 min-w-0">
          <div id="voice-advanced-settings" data-voice-advanced-panel className="flex flex-col gap-4 min-w-0">
            <div className="bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl overflow-hidden flex-1 flex flex-col min-h-0">
              <button
                type="button"
                aria-expanded={advancedSettingsExpanded}
                aria-controls="voice-advanced-content"
                className="vs-advanced-toggle w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left bg-[var(--vs-surface)]/50 border-b border-[var(--vs-border)]"
                onClick={() => setAdvancedSettingsExpanded(expanded => !expanded)}
              >
                <span className="flex flex-wrap items-center gap-2.5">
                  <Settings2 className="h-5 w-5 text-[var(--vs-primary)]" aria-hidden="true" />
                  <span className="text-base font-semibold text-[var(--vs-text)]">高级设置</span>
                  <span className="text-sm text-[var(--vs-text-muted)]">
                    当前：{mode === 'mix' ? 'TTS 1.0（混音）' : mode === 'audio-gen' ? 'Seed-Audio 1.0' : MODEL_VERSION_LABELS[modelVersion]} · {sampleRate >= 1000 ? `${sampleRate / 1000}kHz` : `${sampleRate}Hz`} {audioFormat.toUpperCase()}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-sm text-[var(--vs-text-secondary)]">
                  {advancedSettingsExpanded ? '收起' : '展开'}
                  <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${advancedSettingsExpanded ? 'rotate-180' : ''}`} />
                </span>
              </button>

                <div id="voice-advanced-content" hidden={!advancedSettingsExpanded} className={`p-4 space-y-3.5 flex-1 overflow-auto min-h-0 ${advancedSettingsExpanded ? '' : 'hidden'}`}>
                  <div className={mode === 'audio-gen' || mode === 'mix' ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4'}>
                    <div>
                      <div className="text-sm text-[var(--vs-text-muted)] mb-1.5">模型版本</div>
                      <select
                        aria-label="模型版本"
                        className="w-full px-3 py-2 rounded-lg bg-[var(--vs-surface)]/80 border border-[var(--vs-border)] text-[var(--vs-text)] text-[15px] focus:outline-none focus:border-[var(--vs-primary)]/50"
                        value={mode === 'mix' ? 'seed-tts-1.0' : mode === 'audio-gen' ? 'seed-audio-1.0' : modelVersion}
                        disabled={synthesizing || mode === 'mix' || mode === 'audio-gen'}
                        onChange={e => setModelVersion(e.target.value as typeof modelVersion)}
                      >
                        {mode === 'mix' ? <option value="seed-tts-1.0">TTS 1.0（混音）</option> : mode === 'audio-gen' ? <option value="seed-audio-1.0">Seed-Audio 1.0</option> : MODEL_VERSIONS.map(v => (
                          <option key={v.value} value={v.value}>{MODEL_VERSION_LABELS[v.value]}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-sm text-[var(--vs-text-muted)] mb-1.5">音频格式</div>
                      <select
                        aria-label="音频格式"
                        className="w-full px-3 py-2 rounded-lg bg-[var(--vs-surface)]/80 border border-[var(--vs-border)] text-[var(--vs-text)] text-[15px] focus:outline-none focus:border-[var(--vs-primary)]/50"
                        value={audioFormat}
                        onChange={e => { const next = e.target.value as typeof audioFormat; setAudioFormat(next); if (next === 'ogg_opus' && ![8000,16000,24000,48000].includes(sampleRate)) setSampleRate(24000); }}
                      >
                        {FILE_AUDIO_FORMATS.map(f => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-sm text-[var(--vs-text-muted)] mb-1.5">采样率</div>
                      <select
                        aria-label="采样率"
                        className="w-full px-3 py-2 rounded-lg bg-[var(--vs-surface)]/80 border border-[var(--vs-border)] text-[var(--vs-text)] text-[15px] focus:outline-none focus:border-[var(--vs-primary)]/50"
                        value={sampleRate}
                        onChange={e => setSampleRate(Number(e.target.value) as typeof sampleRate)}
                      >
                        {SAMPLE_RATES.filter(r => audioFormat !== 'ogg_opus' || [8000,16000,24000,48000].includes(r)).map(r => (
                          <option key={r} value={r}>{r}Hz</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {mode !== 'audio-gen' && mode !== 'mix' && <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm text-[var(--vs-text-secondary)] mb-1.5">情绪强度</div>
                      <Slider value={emotionIntensity * 100 - 50} onChange={v => setEmotionIntensity((v + 50) / 100)} min={-50} max={50} />
                    </div>
                    <div>
                      <div className="text-sm text-[var(--vs-text-secondary)] mb-1.5">句尾静音</div>
                      <Slider value={silenceFinal / 20 - 10} onChange={v => setSilenceFinal((v + 10) * 20)} min={-10} max={40} />
                    </div>
                  </div>}


                  {mode !== 'audio-gen' && mode !== 'mix' && <><div className="flex flex-wrap items-center gap-x-4 gap-y-3 text-xs text-[var(--vs-text-secondary)]">
                    <div className="flex shrink-0 items-center gap-2">
                    <span className="shrink-0">语种</span>
                    <div className="w-44">
                      <select
                        aria-label="语种"
                        className="w-full px-2 py-1.5 rounded-lg bg-[var(--vs-surface)] border border-[var(--vs-border)] text-[var(--vs-text)] text-xs"
                        value={language}
                        onChange={e => setLanguage(e.target.value)}
                      >
                        <option value="auto">自动</option>
                        {EXPLICIT_LANGUAGES.map(l => (
                          <option key={l.value} value={l.value}>{l.label}</option>
                        ))}
                      </select>
                    </div>
                    </div>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={subtitle} onChange={e => setSubtitle(e.target.checked)} className="w-3.5 h-3.5" />
                      字幕
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={subtitleTimestamp} onChange={e => setSubtitleTimestamp(e.target.checked)} className="w-3.5 h-3.5" />
                      时间戳
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={useCache} onChange={e => setUseCache(e.target.checked)} className="w-3.5 h-3.5" />
                      缓存
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={silenceSeg} onChange={e => setSilenceSeg(e.target.checked)} className="w-3.5 h-3.5" />
                      自动切分
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={langDetect} onChange={e => setLangDetect(e.target.checked)} className="w-3.5 h-3.5" />
                      自动识别语种
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={filterMd} onChange={e => setFilterMd(e.target.checked)} className="w-3.5 h-3.5" />
                      无Markdown过滤
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={filterEmoji} onChange={e => setFilterEmoji(e.target.checked)} className="w-3.5 h-3.5" />
                      无Emoji过滤
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={latex} onChange={e => setLatex(e.target.checked)} className="w-3.5 h-3.5" />
                      LaTeX公式
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-pointer">
                      <input type="checkbox" checked={aigcTag} onChange={e => setAigcTag(e.target.checked)} className="w-3.5 h-3.5" />
                      AIGC水印
                    </label>
                    <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap cursor-not-allowed text-[var(--vs-text-muted)]" title="当前公开的 TTS 2.0 模型不支持 SSML">
                      <input type="checkbox" checked={false} disabled className="w-3.5 h-3.5" />
                      <span>SSML <span className="text-xs">当前模型未开放</span></span>
                    </label>
                  </div>

                  {/* 情感预设：一键应用常用参数组合（固定 8 个） */}
                  <div className="pt-3 border-t border-[var(--vs-border)]/40">
                    <div className="flex items-center justify-between mb-2.5 gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="flex items-center gap-1.5 text-sm text-[var(--vs-text-muted)] font-medium"><Heart className="h-4 w-4" aria-hidden="true" />情感预设</span>
                        <span className="text-xs text-[var(--vs-text-muted)] opacity-70 truncate">固定 8 个，一键应用语速/音调/音量/情感</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {SYNTHESIS_PRESETS.map(preset => {
                        const isActive = modelVersion === preset.config.modelVersion &&
                          speed === preset.config.speed &&
                          pitch === preset.config.pitch &&
                          volume === preset.config.volume &&
                          emotion === (preset.config.emotion || 'none') &&
                          subtitle === preset.config.subtitle &&
                          aigcTag === preset.config.aigcTag;
                        return (
                          <button
                            key={preset.key}
                            type="button"
                            data-workbench-control="choice"
                            aria-pressed={isActive}
                            onClick={() => {
                              setModelVersion(preset.config.modelVersion);
                              setSpeed(preset.config.speed);
                              setPitch(preset.config.pitch);
                              setVolume(preset.config.volume);
                              setEmotion(preset.config.emotion || 'none');
                              setEmotionIntensity(preset.config.emotionIntensity ?? 0.5);
                              setSubtitle(preset.config.subtitle);
                              setAigcTag(preset.config.aigcTag);
                            }}
                            className={`flex flex-col items-start gap-1 px-3 py-2.5 rounded-lg text-left transition-all ${
                              isActive
                                ? 'brand-action border'
                                : 'bg-[var(--vs-surface)]/50 border border-[var(--vs-border)]/50 hover:border-[var(--vs-primary)]/40 hover:bg-[var(--vs-surface)]'
                            }`}
                            title={preset.desc}
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="text-base leading-none">{preset.icon}</span>
                              <span className={`text-[13px] font-semibold leading-none ${isActive ? 'text-[var(--brand-action-fg)]' : 'text-[var(--vs-text)]'}`}>
                                {preset.name}
                              </span>
                            </div>
                            <span className={`text-[11px] leading-tight line-clamp-1 ${isActive ? "text-[var(--brand-action-fg)]" : "text-[var(--vs-text-muted)]"}`}>{preset.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div></>}
                </div>
            </div>
          </div>

          {/* 主要输入：合成文案与参考音频 */}
          <div className="vs-compose-panel">
          <div className="vs-composition-inputs">
            {/* 单人模式文本输入 */}
            {mode === 'single' && (
              <TextInputCard
                title="输入文本"
                icon={<PencilLine className="h-5 w-5" />}
                value={useSsml ? ssml : text}
                onChange={useSsml ? setSsml : setText}
                maxLen={5000}
                h="h-[400px]"
                placeholder={useSsml ? '<speak>输入 SSML 内容...</speak>' : '输入要合成的文本内容...'}
              ></TextInputCard>
            )}

            {/* 双人模式文本输入 */}
            {mode === 'dual' && (
              <div className="flex flex-col gap-4 flex-1 min-h-0">
                <TextInputCard
                  title="角色一 台词"
                  icon={<Mic2 className="h-5 w-5" />}
                  value={text}
                  onChange={setText}
                  maxLen={5000}
                  h="flex-1 min-h-0"
                  placeholder="输入角色一的台词..."
                ></TextInputCard>
                <TextInputCard
                  title="角色二 台词"
                  icon={<AudioLines className="h-5 w-5" />}
                  value={text2}
                  onChange={setText2}
                  maxLen={5000}
                  h="flex-1 min-h-0"
                  placeholder="输入角色二的台词..."
                >
                  <div className="flex gap-2 flex-wrap">
                    {DUAL_SAMPLE_TEXTS.map(s => (
                      <button
                        key={s.label}
                        data-workbench-action="secondary"
                        className="px-3 py-1.5 text-xs rounded-lg bg-[var(--vs-surface)] border border-[var(--vs-border)] text-[var(--vs-text-secondary)] hover:text-[var(--vs-text)] transition-all"
                        onClick={() => { setText(s.text1); setText2(s.text2); }}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </TextInputCard>
              </div>
            )}

            {/* 长文本同步输入 */}
            {mode === 'long-text' && (
              <TextInputCard
                title="长文本输入（同步合成）"
                icon={<FileText className="h-5 w-5" />}
                value={text}
                onChange={setText}
                maxLen={5000}
                h="h-[400px]"
                placeholder="单次最多 5000 字符，提交后请在当前页面等待合成结果。更长内容请拆分后分次合成。&#10;请在此处粘贴或输入长文本内容..."
              ></TextInputCard>
            )}

            {/* 混音合成配置 + 文本输入 */}
            {mode === 'mix' && (
              <div className="flex flex-col gap-5 flex-1 min-h-0">
                <div className="bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl overflow-hidden">
                  <div className="px-5 py-3 flex items-center gap-2 border-b border-[var(--vs-border)]">
                    <Music2 className="h-5 w-5" />
                    <span className="font-medium text-[var(--vs-text)]">混音音色配置</span>
                    <span className="text-xs text-[var(--vs-text-secondary)]">2–3 个音色 · 比例之和 = 1.00（仅 TTS 1.0）</span>
                  </div>
                  <div className="p-5 space-y-4">
                    {mixVoices.length > 3 && <p role="alert" className="text-sm text-amber-400">旧配置包含超过 3 个音色，已完整保留。请手动移除多余音色，并重新确认比例。</p>}
                    <div className="grid grid-cols-2 gap-3">
                      {mixVoices.map((m, idx) => (
                        <div
                          key={idx}
                          className="bg-[var(--vs-surface)]/50 border border-[var(--vs-border)]/60 rounded-xl px-4 py-2.5 h-[100px] flex flex-col gap-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-[var(--vs-primary)]">
                              音色 {idx + 1}
                            </span>
                            {mixVoices.length > 2 && <button type="button" aria-label={`移除混音音色 ${idx + 1}`} disabled={synthesizing} onClick={() => setMixVoices(prev => prev.filter((_, index) => index !== idx))} className="text-xs text-[var(--vs-text-secondary)]">移除</button>}
                          </div>
                          <select
                            aria-label={`混音音色 ${idx + 1}`}
                            disabled={synthesizing}
                            className="w-full px-3 py-1.5 rounded-md bg-[var(--vs-surface)] border border-[var(--vs-border)] text-[var(--vs-text)] text-sm focus:outline-none"
                            value={m.voice?.id || ''}
                            onChange={e => {
                              const v = MIX_VOICES.find(x => x.id === e.target.value) || null;
                              setMixVoices(prev => prev.map((x, i) => i === idx ? { ...x, voice: v } : x));
                            }}
                          >
                            <option value="">— 选择音色 —</option>
                            {m.voice && !MIX_VOICES.some(v => v.id === m.voice!.id) && <option value={m.voice.id} disabled>{m.voice.name}（原选择，请重新确认 MIX 支持）</option>}
                            {MIX_VOICES.map(v => (
                              <option key={v.id} value={v.id}>{v.name}</option>
                            ))}
                          </select>
                          <div className="flex items-center gap-2 mt-auto">
                            <span className="text-xs text-[var(--vs-text-secondary)] shrink-0">比例</span>
                            <input
                              type="range"
                              aria-label={`混音音色 ${idx + 1} 比例`}
                              disabled={synthesizing}
                              className="flex-1 accent-[var(--vs-primary)]"
                              min={0} max={1} step={0.05}
                              value={m.factor}
                              onChange={e => {
                                setMixVoices(prev => prev.map((x, i) => i === idx ? { ...x, factor: parseFloat(e.target.value) } : x));
                              }}
                            />
                            <span className="text-sm font-medium text-[var(--vs-primary)] w-10 text-right shrink-0">
                              {(m.factor * 100).toFixed(0)}%
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {mixVoices.length < 3 && <button type="button" data-workbench-action="secondary" disabled={synthesizing} onClick={() => setMixVoices(prev => prev.length < 3 ? [...prev, { voice: null, factor: 0 }] : prev)} className="text-sm text-[var(--vs-primary)]">添加第三个音色</button>}
                    <div className="flex items-center justify-end pt-1">
                      <div className="text-sm">
                        比例总和：
                        <span className={Math.abs(mixVoices.reduce((s, x) => s + x.factor, 0) - 1) <= 0.000001 ? 'text-emerald-400' : 'text-rose-400'}>
                          {mixVoices.reduce((s, x) => s + x.factor, 0).toFixed(2)} / 1.00
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <TextInputCard
                  title="输入文本"
                  icon={<PencilLine className="h-5 w-5" />}
                  value={text}
                  onChange={setText}
                  maxLen={5000}
                  h="flex-1 min-h-[160px]"
                  placeholder="输入要混音合成的文本内容..."
                ></TextInputCard>
              </div>
            )}

            {/* 音频生成模式 */}
            {mode === 'audio-gen' && (
              <div className="flex flex-col gap-5 flex-1 min-h-0">
                <div className="bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl overflow-hidden">
                  <div className="px-5 py-3 flex items-center gap-2 border-b border-[var(--vs-border)]">
                    <Clapperboard className="h-5 w-5" />
                    <span className="font-medium text-[var(--vs-text)]">参考音频来源</span>
                    <span className="text-xs text-[var(--vs-text-secondary)]">粘贴抖音/小红书链接自动提取</span>
                  </div>
                  <div className="p-5 space-y-3">
                    <div className="flex gap-3">
                      <input
                        className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--vs-surface)] border border-[var(--vs-border)] text-[var(--vs-text)] placeholder-[var(--vs-text-secondary)] text-sm focus:outline-none"
                        placeholder="粘贴抖音或小红书分享链接..."
                        aria-describedby="voice-audio-reference-help"
                        value={audioGenLinkInput}
                        onChange={e => setAudioGenLinkInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') requestAudioGenLink(); }}
                      />
                      <Button variant="primary" data-workbench-action="secondary" size="md" onClick={requestAudioGenLink} disabled={extractingAudio || !referenceAudioGate.ready || !audioGenLinkInput.trim()}>
                        {extractingAudio ? '提取中...' : '添加'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingAudio}
                      >
                        {uploadingAudio ? '上传中...' : '上传音频'}
                      </Button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/x-wav"
                        className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadAudio(f); }}
                      />
                    </div>
                    <ReferenceAudioRuntimeStatus gate={referenceAudioGate} />
                    {audioGenLinks.length === 0 && <p id="voice-audio-reference-help" className="text-sm text-[var(--vs-text-muted)]">请先添加参考音频，再输入提示词生成音频。</p>}
                    {audioGenLinks.length > 0 && (
                      <div className="grid gap-3 md:grid-cols-2">
                        {audioGenLinks.map((reference, i) => (
                          <div key={reference.assetId} className="rounded-xl border border-[var(--vs-primary)]/25 bg-[var(--vs-primary)]/5 p-3 text-sm">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-[var(--vs-text)]" title={reference.name}>{reference.name}</p>
                                <p className="text-xs text-[var(--vs-text-muted)]">参考音频 {i + 1} · 已保存 · 可试听</p>
                              </div>
                            <button
                              type="button"
                              onClick={() => removeAudioGenLink(i)}
                                aria-label={`移除参考音频 ${i + 1}`}
                                className="rounded-lg px-2 py-1 text-[var(--vs-text-secondary)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                            >
                                移除
                            </button>
                            </div>
                            <AudioPlayer audioUrl={reference.url} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <TextInputCard
                  title="提示词 / 文案"
                  icon={<PencilLine className="h-5 w-5" />}
                  value={audioGenText}
                  onChange={setAudioGenText}
                  maxLen={3000}
                  h="flex-1 min-h-[220px]"
                  placeholder="@音频1 请用参考音频中的音色和情感风格，说出以下文案：&#10;&#10;今天的天气很好，我们一起出去走走吧。"
                />
              </div>
            )}
          </div>

          <div data-voice-output-region className="vs-synthesis-actions">
            <div className="vs-action-status">
            <div id="voice-synthesis-fee" data-voice-fee-state={pricingError ? 'model-error' : enabledPricingModels === null ? 'model-loading' : !isModeAvailable(mode) ? 'mode-unavailable' : !quoteInputsReady ? 'incomplete' : quoteError ? 'quote-error' : !quoteReady ? 'quoting' : 'ready'} aria-live="polite">
              {pricingError ? <span role="alert">模型信息暂时无法读取，恢复后再核算本次费用。 <button type="button" className="text-[var(--vs-primary)] underline" onClick={() => setPricingReload(value => value + 1)}>重新读取模型</button></span>
                : enabledPricingModels === null ? '正在读取可用模型，读取后核算本次费用…'
                : !isModeAvailable(mode) ? '当前模式暂不可用，暂不核算费用；已填写的文案和音色会保留。'
                : !quoteInputsReady ? `请${missingInputs.join('并')}。` : quoteError ? <span role="alert">{quoteError} <button type="button" className="underline" onClick={() => setQuoteRetry(value => value + 1)}>重新读取费用</button></span> : !quoteReady ? '正在核算本次费用…' : <><strong className="text-[var(--vs-text)]">{`${voiceQuote!.reservationSeconds ? '本次预留' : '本次预计'} ${voiceQuote!.credits} 积分（¥${voiceQuote!.retailPrice.toFixed(2)}）`}</strong><p>{voiceQuote!.reservationSeconds ? '先按最长120秒预留积分，完成后按实际音频时长结算，多余积分自动退回。' : mode === 'dual' ? '按两个角色各自的文案计费，失败角色费用自动退回。' : '按本次文案计费，合成失败自动退回积分。'}</p></>}
            </div>
              {error && <p className="vs-action-error" role="alert">{error}</p>}
              {result && <a className="vs-result-link" href="#voice-synthesis-result">查看合成结果</a>}
            </div>
              <button
                type="button"
                className="vs-synthesis-submit"
                aria-describedby="voice-synthesis-fee"
                aria-busy={synthesizing}
                onClick={
                  mode === 'single' ? handleSynthesize :
                  mode === 'dual' ? handleDualSynthesize :
                  mode === 'long-text' ? handleLongTextSynthesize :
                  mode === 'mix' ? handleMixSynthesize :
                  handleAudioGen
                }
                disabled={synthesizing || !quoteReady || !isModeAvailable(mode) || (!selectedVoice && mode !== 'mix' && mode !== 'audio-gen') || (mode === 'audio-gen' && (!audioGenText.trim() || audioGenLinks.length === 0))}
              >
                {synthesizing
                  ? <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <Play size={18} fill="currentColor" aria-hidden="true" />}
                {synthesizing ? '正在生成…' : SYNTHESIS_ACTION_LABELS[mode]}
              </button>
            </div>
          </div>
          </div>

            {result && (
              <div id="voice-synthesis-result" data-voice-output-card="ready" className="vs-output-card vs-output-panel scroll-mt-16 bg-[var(--vs-card)] border border-[var(--vs-border)] rounded-2xl p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Headphones className="h-5 w-5" />
                  <span className="font-medium text-[var(--vs-text)]">合成结果</span>
                  {result.duration > 0 && (
                    <span className="text-xs text-[var(--vs-text-secondary)] ml-auto">
                      时长 {result.duration.toFixed(1)}s
                    </span>
                  )}
                </div>
                {result.warnings?.map(warning => <p key={warning} role="status" className="text-sm text-amber-400">{warning}</p>)}
                <AudioPlayer audioUrl={result.audioUrl} />
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--vs-text-secondary)]">
                  {result.generationId && (
                    <span className="max-w-full truncate" title={result.generationId}>任务 ID：{result.generationId}</span>
                  )}
                  {result.asset?.id && (
                    <span className="max-w-full truncate" title={result.asset.id}>资产 ID：{result.asset.id}</span>
                  )}
                  <span>实扣 {Number(result.cost || 0)} 积分</span>
                  {Number(result.quotedCredits || 0) !== Number(result.cost || 0) && (
                    <span>应付 {Number(result.quotedCredits || 0)} 积分</span>
                  )}
                  {Number(result.retailPrice || 0) > 0 && <span>公开价 ¥{Number(result.retailPrice).toFixed(2)}</span>}
                  {result.asset?.size ? <span>资产 {(result.asset.size / 1024).toFixed(1)} KB</span> : null}
                  <AudioDownloadButton
                    audioUrl={result.audioUrl} assetId={result.asset?.id} token={auth.token}
                    filename={`voice-${result.generationId || 'audio'}.${result.asset?.contentType?.includes('wav') ? 'wav' : result.asset?.contentType?.includes('ogg') ? 'ogg' : 'mp3'}`}
                    className="rounded-lg border border-[var(--vs-border)] px-3 py-1.5 font-medium text-[var(--vs-text)] hover:bg-[var(--vs-surface)]"
                  >
                    下载音频
                  </AudioDownloadButton>
                  <a
                    href="/assets?category=audio"
                    className="rounded-lg border border-[var(--vs-border)] px-3 py-1.5 font-medium text-[var(--vs-text)] hover:bg-[var(--vs-surface)]"
                  >
                    打开个人资产
                  </a>
                </div>

                {/* 字幕列表（开启字幕时显示） */}
                {result.subtitles && result.subtitles.length > 0 && (
                  <div className="bg-[var(--vs-surface)]/40 rounded-xl p-4 max-h-[200px] overflow-y-auto">
                    <div className="text-xs text-[var(--vs-text-secondary)] mb-2 flex items-center gap-2">
                      <span>📝</span>
                      <span>字幕（{result.subtitles.length} 句）</span>
                    </div>
                    <div className="space-y-1.5">
                      {result.subtitles.map((s, i) => (
                        <div key={i} className="flex items-baseline gap-3 text-sm">
                          <span className="text-xs text-[var(--vs-text-secondary)] font-mono w-24 shrink-0">
                            {s.startMs != null ? `${(s.startMs / 1000).toFixed(1)}s` : ''}
                          </span>
                          <span className="text-[var(--vs-text)]">{s.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* AIGC 水印提示 */}
                {aigcTag && (
                  <div className="text-xs text-[var(--vs-text-secondary)] bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                    🎨 已启用 AIGC 数字水印（音频中含 AI 生成标识）
                  </div>
                )}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[var(--vs-bg)]" />}>
      <WorkspaceContent />
    </Suspense>
  );
}
