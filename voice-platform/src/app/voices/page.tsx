'use client';

import React, { useState, useEffect, useCallback } from 'react';
import VoiceCard from '@/components/VoiceCard';
import FeaturedVoiceCard from '@/components/FeaturedVoiceCard';
import { RECOMMENDED_VOICES, WEEKLY_HOT_VOICES } from '@/lib/recommended-voices';

interface Voice {
  id: string;
  speakerId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  gender: string;
  type?: string;
  userId?: string;
}

// ===== 分类定义 =====
// 将「我的定制」(克隆+设计) 融入主分类栏
const CATEGORIES = [
  { value: '全部', label: '全部', icon: '⊙', color: 'slate' },
  { value: '🔥推荐', label: '推荐音色', icon: '🔥', color: 'amber' },
  { value: '⚡热门', label: '热门音色', icon: '⚡', color: 'emerald' },
  { value: '影视解说', label: '影视解说', icon: '🎬', color: 'rose' },
  { value: '角色动漫', label: '角色动漫', icon: '🎭', color: 'violet' },
  { value: '情感治愈', label: '情感治愈', icon: '💝', color: 'pink' },
  { value: '短视频配音', label: '短视频配音', icon: '📱', color: 'cyan' },
  { value: '商业播报', label: '商业播报', icon: '💼', color: 'emerald' },
  { value: '我的定制', label: '我的定制', icon: '🎤', color: 'indigo' },
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
  const [activeCategory, setActiveCategory] = useState<CategoryValue>('全部');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [gender, setGender] = useState('全部');
  const [voiceType, setVoiceType] = useState('全部');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const pageSize = 60;

  // 从 localStorage 加载收藏
  useEffect(() => {
    try {
      const stored = localStorage.getItem('voice_favorites');
      if (stored) setFavorites(new Set(JSON.parse(stored)));
    } catch { /* silent */ }
  }, []);

  // 检查登录状态
  useEffect(() => {
    setIsLoggedIn(!!localStorage.getItem('token'));
  }, []);

  // 监听分类/筛选变化
  useEffect(() => {
    fetchVoices();
  }, [activeCategory, page, gender, voiceType]);

  const fetchVoices = async () => {
    setLoading(true);
    try {
      // 推荐/热门：直接使用本地RECOMMENDED_VOICES/WEEKLY_HOT_VOICES
      if (activeCategory === '🔥推荐') {
        setVoices(RECOMMENDED_VOICES as any);
        setTotal(RECOMMENDED_VOICES.length);
        setLoading(false);
        return;
      }
      if (activeCategory === '⚡热门') {
        setVoices(WEEKLY_HOT_VOICES as any);
        setTotal(WEEKLY_HOT_VOICES.length);
        setLoading(false);
        return;
      }

      let url = `/voice-platform/api/voices?page=${page}&limit=${pageSize}`;

      if (activeCategory === '我的定制') {
        // 我的定制：拉取克隆+设计音色
        const token = localStorage.getItem('token');
        if (!token) {
          setVoices([]);
          setTotal(0);
          setLoading(false);
          return;
        }

        // 同时拉取克隆和设计音色
        const [cloneRes, designRes] = await Promise.all([
          fetch(`/voice-platform/api/voices?type=cloned&mine=true&limit=50`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }).then(r => r.json()),
          fetch(`/voice-platform/api/voices?type=designed&mine=true&limit=50`, {
            headers: { 'Authorization': `Bearer ${token}` }
          }).then(r => r.json()),
        ]);

        let list: Voice[] = [];
        if (cloneRes.success) list = list.concat(cloneRes.data.voices || []);
        if (designRes.success) list = list.concat(designRes.data.voices || []);

        setVoices(list);
        setTotal(list.length);
      } else {
        // 普通分类
        if (activeCategory !== '全部') url += `&category=${encodeURIComponent(activeCategory)}`;
        if (gender !== '全部') url += `&gender=${gender}`;
        if (voiceType !== '全部') url += `&type=${voiceType}`;

        const res = await fetch(url);
        const data = await res.json();
        if (data.success) {
          setVoices(data.data.voices || []);
          setTotal(data.data.total || 0);
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchVoices();
  };

  const toggleFavorite = (voiceId: string) => {
    const isFav = favorites.has(voiceId);
    const next = new Set(favorites);
    if (isFav) next.delete(voiceId);
    else next.add(voiceId);
    setFavorites(next);
    try {
      localStorage.setItem('voice_favorites', JSON.stringify([...next]));
    } catch { /* silent */ }
  };

  // 根据搜索词 + 收藏筛选
  const filteredVoices = voices.filter((v) => {
    if (search && !v.name.includes(search) && !v.speakerId.includes(search)) return false;
    return true;
  });

  // 收藏列表
  const favoriteVoices = voices.filter(v => favorites.has(v.speakerId)); // 修复：用 speakerId 而不是 id

  const totalPages = Math.ceil(total / pageSize);

  const [showFavorites, setShowFavorites] = useState(false);

  const displayVoices = showFavorites ? favoriteVoices : filteredVoices;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* 标题区 */}
      <div className="mb-6 flex items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.9)]" />
            <span className="text-[11px] uppercase tracking-[0.28em] text-vp-primary/80">Audio Voice Lab</span>
          </div>
          <h1 className="text-3xl font-semibold text-vp-foreground tracking-tight">音色库</h1>
          <p className="mt-2 text-sm text-vp-muted-foreground">火山引擎豆包语音合成 2.0 · {total} 个音色 · 支持试听、收藏与语音指令 COT</p>
        </div>
        <div className="hidden md:flex items-center gap-3 text-xs text-vp-muted-foreground">
          <div className="glass-card rounded-xl px-4 py-3">
            <div className="text-vp-muted-foreground uppercase tracking-[0.18em]">分类</div>
            <div className="mt-1 text-vp-foreground">{activeCategory}</div>
          </div>
          <div className="glass-card rounded-xl px-4 py-3">
            <div className="text-vp-muted-foreground uppercase tracking-[0.18em]">筛选</div>
            <div className="mt-1 text-vp-foreground">{gender} · {voiceType}</div>
          </div>
          <div className="glass-card rounded-xl px-4 py-3">
            <div className="text-vp-muted-foreground uppercase tracking-[0.18em]">收藏</div>
            <div className="mt-1 text-vp-foreground">{favorites.size} 个</div>
          </div>
        </div>
      </div>

      {/* ===== 场景分类 - 置顶主分类栏 ===== */}
      <div className="mb-4 rounded-2xl border border-cyan-300/15 bg-gradient-to-br from-vp-background/60 to-vp-card/50 p-4 backdrop-blur-sm">
        <div className="mb-3 flex items-center gap-3">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-cyan-300/15 text-vp-primary">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M3 3h4v4H3V3zm0 7h4v4H3v-4zm7-7h4v4h-4V3zm0 7h4v4h-4v-4zm7-7h4v4h-4V3zm0 7h4v4h-4v-4z" />
            </svg>
          </span>
          <span className="text-xs uppercase tracking-[0.22em] text-vp-primary/80">场景分类</span>
          <span className="text-[10px] text-vp-muted-foreground ml-auto">{CATEGORIES.length} 个分类</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-2">
          {CATEGORIES.map((c) => {
            const isActive = activeCategory === c.value;
            const borderColor = isActive
              ? 'border-cyan-300/70'
              : 'border-vp-border';
            const bgColor = isActive
              ? 'bg-cyan-300/12'
              : 'bg-slate-950/20';
            const textColor = isActive
              ? 'text-cyan-100'
              : 'text-vp-muted-foreground';

            return (
              <button
                key={c.value}
                onClick={() => { setActiveCategory(c.value); setPage(1); setShowFavorites(false); }}
                className={`group rounded-xl border ${borderColor} ${bgColor} ${textColor} px-3 py-3 text-left transition-all duration-200 hover:border-cyan-300/40 hover:text-vp-foreground hover:bg-vp-background/30 active:scale-[0.98]`}
              >
                <div className="text-lg mb-1">{c.icon}</div>
                <div className="text-sm font-medium">{c.label}</div>
                {c.value === '我的定制' && !isLoggedIn && (
                  <div className="text-[10px] text-vp-muted-foreground mt-1">需登录</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 搜索框 + 收藏切换 + 筛选 */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <form onSubmit={handleSearch} className="flex-1 min-w-[200px] max-w-md">
          <div className="relative">
            <div className="absolute left-4 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-cyan-400/80" />
            <input
              type="text"
              placeholder="搜索音色名称或 speaker_id..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl pl-10 pr-4 py-2.5 text-sm outline-none border border-vp-border bg-vp-card/50 text-vp-foreground placeholder:text-vp-muted-foreground focus:border-cyan-300/60 transition-colors"
            />
          </div>
        </form>

        {/* 收藏切换按钮 */}
        <button
          onClick={() => setShowFavorites(!showFavorites)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border transition-all ${
            showFavorites
              ? 'bg-rose-300/15 text-rose-200 border-rose-300/50 shadow-[0_0_16px_rgba(251,113,133,0.15)]'
              : 'border-vp-border text-vp-muted-foreground hover:text-slate-200 hover:border-slate-500'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill={showFavorites ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
          我的收藏
          {favorites.size > 0 && (
            <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] rounded-full text-[10px] font-bold bg-rose-400/30 text-rose-200 px-1">{favorites.size}</span>
          )}
        </button>

        {/* 性别筛选 */}
        <div className="flex items-center gap-1">
          {GENDERS.map((g) => (
            <button
              key={g.value}
              onClick={() => { setGender(g.value); setPage(1); }}
              className={`px-2.5 py-1.5 text-xs rounded-lg border transition-all ${
                gender === g.value
                  ? 'bg-slate-100 text-slate-950 border-slate-200'
                  : 'border-vp-border text-vp-muted-foreground hover:border-slate-500 hover:text-vp-foreground bg-vp-card/30'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* ===== 推荐音色（仅在'全部'分类且非收藏模式下显示） ===== */}
      {(activeCategory === '🔥推荐' || activeCategory === '全部') && (
        <>
          <div className="mb-5 rounded-2xl border border-amber-300/15 bg-gradient-to-br from-vp-background/50 to-vp-card/40 p-5 backdrop-blur-sm">
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
                <h2 className="mt-2 text-lg font-semibold text-vp-foreground">推荐音色</h2>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-2 gap-2.5">
              {RECOMMENDED_VOICES.map((voice) => (
                <FeaturedVoiceCard
                  key={voice.speakerId}
                  voice={voice}
                  isFavorite={favorites.has(voice.speakerId)}
                  onToggleFavorite={() => toggleFavorite(voice.speakerId)}
                  onUseInWorkspace={() => window.open(`/workspace?speaker=${encodeURIComponent(voice.speakerId)}&preload=true`, '_self')}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {(activeCategory === '⚡热门' || activeCategory === '全部') && (
        <>
          <div className="mb-5 rounded-2xl border border-emerald-300/15 bg-gradient-to-br from-emerald-300/5 to-vp-card/40 p-5 backdrop-blur-sm">
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
                <h2 className="mt-2 text-lg font-semibold text-vp-foreground">热门音色 · {WEEKLY_HOT_VOICES.length}个</h2>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-2 gap-2.5">
              {WEEKLY_HOT_VOICES.map((voice) => (
                <FeaturedVoiceCard key={voice.speakerId} voice={voice} isFavorite={favorites.has(voice.speakerId)} onToggleFavorite={() => toggleFavorite(voice.speakerId)} onUseInWorkspace={() => window.open(`/workspace?speaker=${encodeURIComponent(voice.speakerId)}&preload=true`, '_self')} />
              ))}
            </div>
          </div>
        </>
      )}

      {/* 分类音色标题 */}
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-lg font-semibold text-vp-foreground">
          {showFavorites ? '我的收藏' : activeCategory}
        </h2>
        <span className="text-xs text-vp-muted-foreground">
          {showFavorites ? favoriteVoices.length : total} 个音色
        </span>
      </div>

      {/* 音色网格 */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i} className="skeleton h-16 rounded-2xl" />
          ))}
        </div>
      ) : displayVoices.length === 0 ? (
        <div className="text-center py-20">
          <svg className="w-16 h-16 mx-auto text-vp-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={showFavorites ? "M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" : "M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"} />
          </svg>
          <p className="mt-4 text-vp-muted-foreground">
            {showFavorites ? '还没有收藏的音色' :
             activeCategory === '我的定制' ? (isLoggedIn ? '还没有克隆或设计的音色' : '请先登录后查看') :
             '没有找到匹配的音色'}
          </p>
          <p className="mt-1 text-xs text-vp-muted-foreground">
            {showFavorites ? '点击音色卡片的心形图标即可收藏' :
             activeCategory === '我的定制' && !isLoggedIn ? '登录后克隆或设计音色即可在此处查看' : ''}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
            {displayVoices.map((voice) => (
              <VoiceCard
                key={voice.id}
                id={voice.id}
                speakerId={voice.speakerId}
                name={voice.name}
                description={voice.description}
                category={voice.category}
                tags={voice.tags}
                gender={voice.gender}
                type={voice.type || 'official'}
                isFavorite={favorites.has(voice.speakerId)}
                onSelect={() => window.open(`/workspace?voice=${voice.speakerId}`, '_self')}
                onToggleFavorite={() => toggleFavorite(voice.id)}
                onUseInWorkspace={() => window.open(`/workspace?speaker=${encodeURIComponent(voice.speakerId)}&preload=true`, '_self')}
              />
            ))}
          </div>

          {/* 分页 */}
          {totalPages > 1 && activeCategory !== '我的定制' && (
            <div className="flex items-center justify-center gap-2 mt-6">
              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  onClick={() => setPage(i + 1)}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-all ${
                    page === i + 1
                      ? 'bg-cyan-300/15 text-cyan-100 border-cyan-300/60'
                      : 'border-vp-border text-vp-muted-foreground hover:text-slate-200 hover:border-slate-500'
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
