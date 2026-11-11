'use client';

import React, { useState, useEffect, useRef } from 'react';
import { AppScopedLink as Link } from '@/components/app-scoped-link';
import { useApp } from '@/contexts/app-context';
import { resolveWorkbenchIdentity } from '@/lib/workbench-user-storage';
import { useVoiceFavorites } from '@/hooks/use-voice-favorites';
import {RECOMMENDED_VOICE_IDS,WEEKLY_VOICE_IDS,VOICE_CURATION_DATE} from '@/lib/vs/voice-curation';
import FeaturedVoiceCard from '@/components/vs/FeaturedVoiceCard';
import type { UserVoiceDto } from '@/lib/vs/user-voice-dto';
import { AudioWaveform, BadgeCheck, Drama, Grid2X2, Heart, Mic2, Sparkles, UserRound, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface Voice {
  id: string;
  speakerId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  styleTags?: string[];
  gender: string;
  type?: string;
  userId?: string;
  engine?: string;
  language?: string;
}

let sharedPublicCatalog: { expiresAt: number; promise: Promise<{ voices: Voice[]; total: number }> } | null = null;
function readPublicCatalog() {
  if (!sharedPublicCatalog || sharedPublicCatalog.expiresAt <= Date.now()) {
    const promise = fetch('/api/voice/list?page=1&limit=500', { cache: 'no-store' })
      .then(async response => {
        const result = await response.json();
        if (!response.ok || !result?.success || !Array.isArray(result.data?.voices)) throw new Error('音色暂时无法读取，请重试');
        return { voices: result.data.voices as Voice[], total: Number(result.data.total || result.data.voices.length) };
      })
      .catch(error => {
        if (sharedPublicCatalog?.promise === promise) sharedPublicCatalog = null;
        throw error;
      });
    sharedPublicCatalog = { expiresAt: Date.now() + 30_000, promise };
  }
  return sharedPublicCatalog.promise;
}

function invalidatePublicCatalog() {
  sharedPublicCatalog = null;
}

// ===== 分类定义（按使用频率排序）=====
// 1. 全部（不过滤）2. 我的收藏（个性化高频）
// 3. 模拟真人/角色动漫/情感治愈/短视频配音（按用户场景频率）4. 我的定制（自建音色）
// 注：🔥推荐 / ⚡热门 仅在页面顶部区块展示，不作为分类标签（避免重复）
const CATEGORIES = [
  { value: '全部', label: '全部', icon: Grid2X2, color: 'slate' },
  { value: '⭐我的收藏', label: '我的收藏', icon: Heart, color: 'rose' },
  { value: '最佳音色', label: 'TTS 2.0 最佳音色', icon: BadgeCheck, color: 'cyan' },
  { value: '多情感', label: '丰富的多情感音色', icon: AudioWaveform, color: 'violet' },
  { value: '模拟真人', label: '模拟真人', icon: UserRound, color: 'amber' },
  { value: '角色动漫', label: '角色动漫', icon: Drama, color: 'violet' },
  { value: '情感治愈', label: '情感治愈', icon: Sparkles, color: 'pink' },
  { value: '短视频配音', label: '短视频配音', icon: Video, color: 'cyan' },
  { value: '我的定制', label: '我的定制', icon: Mic2, color: 'indigo' },
] as const;

type CategoryValue = typeof CATEGORIES[number]['value'];

const GENDERS = [
  { value: '全部', label: '全部' },
  { value: 'female', label: '女声' },
  { value: 'male', label: '男声' },
];

const VOICE_TYPES = [
  { value: '全部', label: '全部' },
  { value: 'official', label: '官方' },
  { value: 'icl', label: '真人' },
  { value: 'cloned', label: '克隆' },
  { value: 'designed', label: '设计' },
];

export default function VoicesPage() {
 const { state } = useApp(); const identity=resolveWorkbenchIdentity(state.auth);
 return <VoicesLibrary key={identity?.userId || 'guest'} userId={identity?.userId || ''} token={state.auth.token} />;
}
function VoicesLibrary({userId,token}:{userId:string;token?:string|null}) {
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<CategoryValue>('全部');
  const [voices, setVoices] = useState<Voice[]>([]);
  const { favorites, favoriteVoices, favoriteError, toggleFavorite: saveFavorite } = useVoiceFavorites(userId,token);
  const [search, setSearch] = useState('');
  const [gender, setGender] = useState('全部');
  const [voiceType, setVoiceType] = useState('全部');
  const [loading, setLoading] = useState(true);
  const [listError,setListError]=useState('');
  const [listRevision, setListRevision] = useState(0);
  const [searchQuery,setSearchQuery]=useState('');
  useEffect(()=>{const timer=setTimeout(()=>{setSearchQuery(search.trim());setPage(1);},250);return()=>clearTimeout(timer);},[search]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const pageSize = 60;
  // Favorite hydration changes Set/array identities several times during mount.
  // The ordinary catalog does not depend on those values, so only make them an
  // effect dependency while the user is actually viewing the favorites tab.
  const favoriteDataKey = activeCategory === '⭐我的收藏'
    ? `${[...favorites].sort().join('|')}::${favoriteVoices.map(voice => voice.speakerId).sort().join('|')}`
    : '';
  const favoritesRef = useRef(favorites);
  const favoriteVoicesRef = useRef(favoriteVoices);
  const tokenRef = useRef(token);
  favoritesRef.current = favorites;
  favoriteVoicesRef.current = favoriteVoices;
  tokenRef.current = token;
  const privateAuthKey = activeCategory === '我的定制' ? String(token || '') : '';

  // 顶部"🔥推荐"+"⚡热门"区块专用：从目录按明确音色 ID 匹配
  // 与官方页面的推荐及热门名单对齐
  const [topVoices, setTopVoices] = useState<any[]>([]);
  const [topLoading, setTopLoading] = useState(true);
  const [topError, setTopError] = useState('');

  // 顶部"🎭 模拟真人"区块专用：拉取 category='模拟真人' 的所有情感级真人音色
  // 数据源：sync API 写入数据库的 emotionSupport=true + language=zh 的音色


  // 检查登录状态
  useEffect(() => {
    setIsLoggedIn(Boolean(userId));
  }, [userId]);

  // 推荐与热门共享同一份目录，重试时一并恢复。
  useEffect(() => {
    let cancelled = false;
    setTopLoading(true);
    setTopError('');
    (async () => {
      try {
        const data = await readPublicCatalog();
        if (!cancelled) setTopVoices(data.voices.map((v: Voice) => ({ ...v, tags: v.styleTags || v.tags || [] })));
      } catch {
        if (!cancelled) setTopError('推荐音色暂时无法读取');
      } finally {
        if (!cancelled) setTopLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // readPublicCatalog is deliberately shared by the two catalog consumers.
    // listRevision is the single explicit invalidation key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRevision]);

  useEffect(() => {
    const controller=new AbortController();
    setLoading(true);setListError('');
    (async()=>{
      try {
        let list:Voice[]=[];let count=0;
        const read=async(url:string,privateData=false)=>{const activeToken=tokenRef.current;const response=await fetch(url,{signal:controller.signal,cache:'no-store',headers:privateData&&activeToken?{Authorization:'Bearer '+activeToken}:{}});const result=await response.json();if(!response.ok||!result.success)throw new Error('音色暂时无法读取，请重试');return result.data;};
        if(activeCategory==='⭐我的收藏'){
          const favoriteIds = favoritesRef.current;
          const savedVoices = favoriteVoicesRef.current;
          if(favoriteIds.size){const data=await readPublicCatalog();list=[...favoriteIds].map(id=>data.voices.find((v:Voice)=>v.speakerId===id)||(()=>{const saved=savedVoices.find(v=>v.speakerId===id);return saved?{...saved,id,category:'我的收藏',tags:[],description:'已保存的音色',gender:saved.gender||''}:null;})()).filter(Boolean) as Voice[];}
          if(searchQuery)list=list.filter(v=>(v.name+' '+v.speakerId).toLowerCase().includes(searchQuery.toLowerCase()));
          if(gender!=='全部')list=list.filter(v=>v.gender===gender);count=list.length;
        } else if(activeCategory==='我的定制'){
          if(tokenRef.current){const activeToken=tokenRef.current;const response=await fetch('/api/voice/user-voices',{signal:controller.signal,cache:'no-store',headers:{Authorization:'Bearer '+activeToken}});const result=await response.json();if(!response.ok||result?.success!==true||!Array.isArray(result.voices))throw new Error('我的定制音色暂时无法读取，请重试');list=(result.voices as UserVoiceDto[]);if(searchQuery)list=list.filter(v=>(v.name+' '+v.speakerId).toLowerCase().includes(searchQuery.toLowerCase()));}count=list.length;
        }else{
          const isDefaultFirstPage=activeCategory==='全部'&&page===1&&!searchQuery&&gender==='全部'&&voiceType==='全部';
          if(isDefaultFirstPage){const data=await readPublicCatalog();list=data.voices.slice(0,pageSize);count=data.total;}
          else {const query=new URLSearchParams({page:String(page),limit:String(pageSize)});
            if(activeCategory==='最佳音色')query.set('collection','best');else if(activeCategory==='多情感')query.set('collection','emotional');else if(activeCategory!=='全部')query.set('category',activeCategory);
            if(searchQuery)query.set('keyword',searchQuery);if(gender!=='全部')query.set('gender',gender);if(voiceType!=='全部')query.set('type',voiceType);
            const data=await read('/api/voice/list?'+query);list=data.voices||[];count=data.total||0;}
        }
        if(!controller.signal.aborted){setVoices(list);setTotal(count);}
      }catch(error){if(!controller.signal.aborted){setVoices([]);setTotal(0);setListError(error instanceof Error?error.message:'音色暂时无法读取，请重试');}}
      finally{if(!controller.signal.aborted)setLoading(false);}
    })();return()=>controller.abort();
    // readPublicCatalog is shared with the recommendation effect and is
    // invalidated only by listRevision; privateAuthKey changes for private data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[activeCategory,page,gender,voiceType,favoriteDataKey,searchQuery,privateAuthKey,listRevision]);
  const handleSearch=(event:React.FormEvent)=>{event.preventDefault();setSearchQuery(search.trim());setPage(1);};

  const toggleFavorite = (voiceId:string) => {
    const voice=[...voices,...topVoices,...favoriteVoices].find(v=>v.speakerId===voiceId);
    if(voice)void saveFavorite({ ...voice, name:voice.name || voiceId });
  };

  const filteredVoices=voices;

  const totalPages = Math.ceil(total / pageSize);
  const recommended=[...RECOMMENDED_VOICE_IDS.map(id=>topVoices.find(v=>v.speakerId===id&&v.isRecommended!==false)).filter(Boolean),...topVoices.filter(v=>v.isRecommended&&!RECOMMENDED_VOICE_IDS.includes(v.speakerId))];
  const weekly=WEEKLY_VOICE_IDS.map(id=>topVoices.find(v=>v.speakerId===id)).filter(Boolean);

  return (
    <div className="vs-page-container">
      {favoriteError && <p role="alert" className="mb-4 rounded-lg border border-amber-400/40 p-3 text-amber-200">{favoriteError}</p>}
      {/* 标题区 */}
      <div className="vs-page-hero">
        <div className="vs-page-kicker">VOICE LIBRARY</div>
        <h1 className="vs-page-title">音色管理</h1>
        <p className="vs-page-description">
          火山引擎豆包语音合成 2.0 · 中文音色 · 支持试听与收藏
        </p>
      </div>

      {/* ===== 场景分类 - 置顶主分类栏 ===== */}
      <div data-workbench-surface="toolbar" className="mb-5 rounded-2xl border border-[var(--vs-border)] bg-[var(--vs-surface)] p-5">
        <div className="mb-3.5 flex items-center gap-3">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--vs-control-hover)] text-[var(--vs-primary)]">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M3 3h4v4H3V3zm0 7h4v4H3v-4zm7-7h4v4h-4V3zm0 7h4v4h-4v-4zm7-7h4v4h-4V3zm0 7h4v4h-4v-4z" />
            </svg>
          </span>
          <span className="text-sm font-semibold tracking-[0.12em] text-[var(--vs-primary)]">场景分类</span>
          <span className="text-xs text-[var(--vs-text-muted)] ml-auto font-medium">{CATEGORIES.length} 个分类</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
          {CATEGORIES.map((c) => {
            const CategoryIcon = c.icon;
            const isActive = activeCategory === c.value;
            const borderColor = isActive
              ? 'border-[var(--brand-action-border)]'
              : 'border-[var(--vs-border)]';
            const bgColor = isActive
              ? 'brand-action'
              : 'bg-[var(--vs-control-bg)]';
            const textColor = isActive
              ? 'text-[var(--brand-action-fg)]'
              : 'text-[var(--vs-text-secondary)]';

            return (
              <button
                key={c.value}
                data-workbench-control="choice"
                onClick={() => { setActiveCategory(c.value); setPage(1); }}
                aria-pressed={isActive}
                className={`group rounded-xl border ${borderColor} ${bgColor} ${textColor} px-3 py-3.5 text-left transition-all duration-200 hover:border-[var(--vs-primary)] active:scale-[0.98]`}
              >
                <CategoryIcon className="mb-2 h-5 w-5" aria-hidden="true" />
                <div className="text-base font-semibold leading-tight">{c.label}</div>
                {c.value === '我的定制' && !isLoggedIn && (
                  <div className="text-[11px] text-[var(--vs-text-muted)] mt-1.5 font-medium">需登录</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 搜索框 + 收藏切换 + 筛选 */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <form onSubmit={handleSearch} className="flex-1 min-w-[260px] max-w-md">
          <div className="relative">
            <div className="absolute left-4 top-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full bg-[var(--vs-primary)]" />
            <input
              type="text"
              aria-label="搜索音色"
              placeholder="搜索音色名称或 speaker_id..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl pl-12 pr-4 py-3.5 text-base outline-none border border-[var(--vs-border)] bg-[var(--vs-control-bg)] text-[var(--vs-text)] placeholder:text-[var(--vs-text-muted)] focus:border-[var(--vs-primary)] transition-colors"
            />
          </div>
        </form>

        {/* 收藏切换按钮 - 跳转到"我的收藏"分类 */}
        <button
          onClick={() => { setActiveCategory('⭐我的收藏'); setPage(1); }}
          className={`flex items-center gap-2 px-4 py-3.5 text-sm font-semibold rounded-xl border transition-all ${
            activeCategory === '⭐我的收藏'
              ? 'bg-gradient-to-r from-rose-300/20 to-pink-300/20 text-rose-800 dark:text-rose-100 border-rose-300/60 shadow-[0_0_20px_rgba(251,113,133,0.25)]'
              : 'border-[var(--vs-border)] text-[var(--vs-text-muted)] hover:text-rose-700 dark:hover:text-rose-200 hover:border-rose-300/40 hover:bg-rose-300/5'
          }`}
        >
          <svg className="w-4 h-4" fill={activeCategory === '⭐我的收藏' ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
          我的收藏
          {favorites.size > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] rounded-full text-xs font-bold bg-rose-400/40 text-rose-900 dark:text-rose-100 px-1.5 shadow-[0_0_8px_rgba(251,113,133,0.4)]">
              {favorites.size}
            </span>
          )}
        </button>

        {/* 性别筛选 */}
        <div className="flex items-center gap-1.5">
          {GENDERS.map((g) => (
            <button
              key={g.value}
              data-workbench-control="choice"
              aria-pressed={gender === g.value}
              onClick={() => { setGender(g.value); setPage(1); }}
              className={`px-3.5 py-2.5 text-sm font-medium rounded-lg border transition-all ${
                gender === g.value
                  ? 'brand-action'
                  : 'border-[var(--vs-border)] text-[var(--vs-text-muted)] hover:border-[var(--vs-border)] hover:text-[var(--vs-text)] hover:bg-[var(--vs-surface)]/30'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* ===== 推荐音色（仅在'全部'分类下显示，分类标签已移除避免重复） ===== */}
      {activeCategory === '全部' && (
        <>
          <div data-workbench-surface="card" className="mb-5 rounded-2xl border border-amber-300/15 bg-gradient-to-br from-[var(--vs-surface)]/50 to-[var(--vs-surface)]/40 p-5 backdrop-blur-sm">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-amber-300/15 text-amber-300">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                  </span>
                  <span className="text-xs uppercase tracking-[0.24em] text-amber-300/80">Editor's Pick</span>
                </div>
                <h2 className="mt-2 text-lg font-semibold text-[var(--vs-text)]">推荐音色</h2>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {topLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={`rec-skel-${i}`} className="h-[110px] rounded-2xl border border-[var(--vs-border)] bg-[var(--vs-surface)]/30 animate-pulse" />
                ))
              ) : topError ? (
                <div role="alert" className="col-span-full py-8 text-center text-sm text-[var(--vs-text-muted)]">
                  <p>{topError}</p>
                  <button type="button" onClick={() => { invalidatePublicCatalog(); setListRevision(value => value + 1); }} className="mt-3 rounded-lg border border-[var(--vs-border)] px-4 py-2 hover:text-[var(--vs-primary)]">重新加载推荐</button>
                </div>
              ) : (
                recommended.map((voice) => (
                  <FeaturedVoiceCard
                    key={voice.speakerId}
                    voice={{
                      speakerId: voice.speakerId,
                      name: voice.name,
                      tags: voice.tags,
                      description: voice.description,
                      gender: voice.gender,
                    }}
                    isFavorite={favorites.has(voice.speakerId)}
                    onToggleFavorite={() => toggleFavorite(voice.speakerId)}
                    onUseInWorkspace={() => router.push(`/voice-studio/workspace?speaker=${encodeURIComponent(voice.speakerId)}&preload=true`)}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}

      {activeCategory === '全部' && (
        <>
          <section className="mb-6" aria-label="精选合集音色">
            <h2 className="mb-3 text-lg font-semibold">精选合集音色</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { key: '最佳音色', title: 'TTS 2.0 最佳音色', description: '中文音色，细腻控制与自然表达', icon: BadgeCheck },
                { key: '多情感', title: '丰富的多情感音色', description: '2.0 音色，支持自然的情绪表达', icon: AudioWaveform },
              ].map(item => {
                const CollectionIcon = item.icon;
                return <button key={item.key} className="flex items-center gap-4 rounded-2xl border border-[var(--vs-border)] bg-[var(--vs-surface)] p-5 text-left hover:border-[var(--vs-primary)]" onClick={() => { setActiveCategory(item.key as CategoryValue); setPage(1); }}>
                  <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-[var(--vs-control-hover)] text-[var(--vs-primary)]"><CollectionIcon className="h-7 w-7" aria-hidden="true" /></span>
                  <span><strong className="block text-base">{item.title}</strong><small className="mt-2 block text-sm text-[var(--vs-text-muted)]">{item.description}</small></span>
                  <span className="ml-auto" aria-hidden="true">→</span>
                </button>;
              })}
            </div>
            <p className="mt-2 text-sm text-[var(--vs-text-muted)]">中文目录 · {VOICE_CURATION_DATE} 按官方页面对齐</p>
          </section>
          <div data-workbench-surface="card" className="mb-5 rounded-2xl border border-emerald-300/15 bg-gradient-to-br from-emerald-300/5 to-[var(--vs-surface)]/40 p-5 backdrop-blur-sm">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-emerald-300/15 text-emerald-300">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                  </span>
                  <span className="text-xs uppercase tracking-[0.24em] text-emerald-300/80">Weekly Hot</span>
                </div>
                <h2 className="mt-2 text-lg font-semibold text-[var(--vs-text)]">上周热门音色{!topLoading && !topError ? ` · ${weekly.length}个` : ''}</h2>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-2 gap-2.5">
              {topLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={`hot-skel-${i}`} className="h-[110px] rounded-2xl border border-[var(--vs-border)] bg-[var(--vs-surface)]/30 animate-pulse" />
                ))
              ) : topError ? (
                <p className="col-span-full py-4 text-sm text-[var(--vs-text-muted)]">热门音色暂时无法读取，请重新加载推荐。</p>
              ) : (
                weekly.map((voice) => (
                  <FeaturedVoiceCard key={voice.speakerId} voice={{ speakerId: voice.speakerId, name: voice.name, tags: voice.tags, description: voice.description, gender: voice.gender }} isFavorite={favorites.has(voice.speakerId)} onToggleFavorite={() => toggleFavorite(voice.speakerId)} onUseInWorkspace={() => router.push(`/voice-studio/workspace?speaker=${encodeURIComponent(voice.speakerId)}&preload=true`)} compact />
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* 分类音色标题 */}
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-2xl font-bold text-[var(--vs-text)] tracking-tight">
          {activeCategory}
        </h2>
        <span className="inline-flex items-center px-2.5 py-1 text-sm font-semibold text-[var(--vs-primary)] bg-[var(--vs-control-hover)] border border-[var(--vs-border)] rounded-full">
          {loading ? "加载中" : listError ? "暂不可用" : `${total} 个音色`}
        </span>
      </div>

      {/* 音色网格 */}
      {loading ? (
        <div role="status" aria-label="音色列表加载中" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
      ) : listError ? (
        <div role="alert" className="rounded-2xl border border-amber-400/40 p-6 text-center">
          <p>{listError}</p>
          <button type="button" className="mt-4 rounded-lg border border-[var(--vs-border)] px-4 py-2" onClick={() => { invalidatePublicCatalog(); setListRevision(value => value + 1); }}>重新加载音色</button>
        </div>
      ) : filteredVoices.length === 0 ? (
        <div className="text-center py-20 rounded-2xl border border-[var(--vs-border)] bg-[var(--vs-surface)]/30">
          <svg className="w-20 h-20 mx-auto text-[var(--vs-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="mt-5 text-base font-medium text-[var(--vs-text)]">
            {activeCategory === '⭐我的收藏' ? '还没有收藏的音色' :
             activeCategory === '我的定制' ? (isLoggedIn ? '还没有保存的个人音色' : '请先登录后查看') :
             '没有找到匹配的音色'}
          </p>
          <p className="mt-2 text-sm text-[var(--vs-text-muted)]">
            {activeCategory === '⭐我的收藏' ? '点击音色卡片的心形图标即可收藏' :
             activeCategory === '我的定制' && !isLoggedIn ? '登录后可查看已有的个人音色' : ''}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredVoices.map((voice) => (
              <FeaturedVoiceCard
                key={voice.speakerId}
                voice={{
                  speakerId: voice.speakerId,
                  name: voice.name,
                  tags: voice.tags,
                  description: voice.description,
                  gender: voice.gender,
                }}
                isFavorite={favorites.has(voice.speakerId)}
                onToggleFavorite={() => toggleFavorite(voice.speakerId)}
                onUseInWorkspace={() => router.push(`/voice-studio/workspace?speaker=${encodeURIComponent(voice.speakerId)}&preload=true`)}
                actionLabel="合成"
                compact
              />
            ))}
          </div>

          {/* 分页 */}
          {totalPages > 1 && activeCategory !== '我的定制' && (
            <div className="flex items-center justify-center gap-2 mt-7">
              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  data-workbench-control="choice"
                  aria-pressed={page === i + 1}
                  onClick={() => setPage(i + 1)}
                  className={`min-w-[40px] px-3.5 py-2.5 text-sm font-semibold rounded-lg border transition-all ${
                    page === i + 1
                      ? 'brand-action'
                      : 'border-[var(--vs-border)] text-[var(--vs-text-muted)] hover:text-[var(--vs-text)] hover:border-[var(--vs-border)] hover:bg-[var(--vs-surface)]/30'
                  }`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
