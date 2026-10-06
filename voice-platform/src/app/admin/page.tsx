'use client';

import React, { useState, useEffect } from 'react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Badge from '@/components/ui/Badge';
import Modal from '@/components/ui/Modal';
import { RESOURCE_IDS } from '@/lib/voices-data';

interface DashboardData {
  totalUsers: number;
  totalVoices: number;
  todayJobs: number;
  activeApiKeys: number;
}

interface ApiConfigItem {
  id: string;
  name: string;
  apiKey: string;
  resourceId: string;
  isActive: boolean;
}

interface VoiceItem {
  id: string;
  speakerId: string;
  name: string;
  type: string;
  category: string;
  isActive: boolean;
  isRecommended: boolean;
}

export default function AdminPage() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [configs, setConfigs] = useState<ApiConfigItem[]>([]);
  const [voices, setVoices] = useState<VoiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddConfig, setShowAddConfig] = useState(false);
  const [newConfig, setNewConfig] = useState({ name: '', apiKey: '', resourceId: 'seed-tts-2.0', isActive: true });

  // 同步官方音色状态
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ beforeCount: number; afterCount: number; upserted: number; skipped: number; fetchedFromApi: number } | null>(null);
  const [licenses, setLicenses] = useState<any[]>([]);
  // 模型卡片
  const [models, setModels] = useState<any[]>([]);
  const [editingModel, setEditingModel] = useState<any | null>(null);
  const [showModelForm, setShowModelForm] = useState(false);
  // 音色分页
  const [voicePage, setVoicePage] = useState(1);
  const [pricing, setPricing] = useState({ costPerKChar: 0.5, markupRate: 100, freeQuota: 0 });
  const [pricingSaving, setPricingSaving] = useState(false);
  const voicePageSize = 50;

  const headers = { 'Content-Type': 'application/json' };

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [dashRes, configRes, voiceRes, licRes, modelRes] = await Promise.all([
        fetch('/voice-platform/api/admin/dashboard', { headers }),
        fetch('/voice-platform/api/admin/configs', { headers }),
        fetch('/voice-platform/api/admin/voices?limit=500', { headers }),
        fetch('/voice-platform/api/admin/licenses', { headers }),
        fetch('/voice-platform/api/admin/models', { headers }),
      ]);
      const dash = await dashRes.json();
      const conf = await configRes.json();
      const voic = await voiceRes.json();
      const lic = await licRes.json();
      const mod = await modelRes.json();
      if (dash.success) setDashboard(dash.data);
      if (conf.success) setConfigs(conf.data.configs || conf.data || []);
      if (voic.success) setVoices(voic.data.voices || []);
      if (lic.success) setLicenses(lic.data.licenses || []);
      if (mod.success) setModels(mod.data || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  const addConfig = async () => {
    try {
      const res = await fetch('/voice-platform/api/admin/configs', {
        method: 'POST',
        headers,
        body: JSON.stringify(newConfig),
      });
      if (res.ok) {
        setShowAddConfig(false);
        setNewConfig({ name: '', apiKey: '', resourceId: 'seed-tts-2.0', isActive: true });
        fetchAll();
      }
    } catch {
      // silent
    }
  };

  const deleteConfig = async (id: string) => {
    if (!confirm('确定删除此配置？删除后不可恢复')) return;
    await fetch(`/voice-platform/api/admin/configs/${id}`, { method: 'DELETE', headers });
    fetchAll();
  };

  // 模型卡片操作
  const toggleModelActive = async (id: string, current: boolean) => {
    await fetch('/voice-platform/api/admin/models', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, isActive: !current }),
    });
    fetchAll();
  };

  const deleteModel = async (id: string) => {
    if (!confirm('确定删除此模型配置？')) return;
    await fetch(`/voice-platform/api/admin/models?id=${id}`, { method: 'DELETE', headers });
    fetchAll();
  };

  const saveModel = async (data: any) => {
    await fetch('/voice-platform/api/admin/models', {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });
    setShowModelForm(false);
    setEditingModel(null);
    fetchAll();
  };

  const toggleConfig = async (id: string, isActive: boolean) => {
    await fetch(`/voice-platform/api/admin/configs/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ isActive: !isActive }),
    });
    fetchAll();
  };

  const copyApiKey = async (apiKey: string, name: string) => {
    try {
      await navigator.clipboard.writeText(apiKey);
      alert(`已复制「${name}」的完整 API Key`);
    } catch {
      // 兜底：用 prompt 展示
      window.prompt('请手动复制：', apiKey);
    }
  };

  const [revealKeys, setRevealKeys] = useState<Set<string>>(new Set());
  const toggleReveal = (id: string) => {
    setRevealKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVoice = async (id: string, isActive: boolean) => {
    await fetch(`/voice-platform/api/admin/voices/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ isActive: !isActive }),
    });
    fetchAll();
  };

  const toggleRecommend = async (id: string, recommend: boolean) => {
    await fetch(`/voice-platform/api/admin/voices/${id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ isRecommended: recommend }),
    });
    fetchAll();
  };

  const savePricing = async () => {
    setPricingSaving(true);
    await fetch('/voice-platform/api/admin/pricing', {
      method: 'POST',
      headers,
      body: JSON.stringify(pricing),
    });
    setPricingSaving(false);
  };

  const generateLicenseKey = async () => {
    const res = await fetch('/voice-platform/api/admin/licenses', {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 1 }),
    });
    const d = await res.json();
    if (d.success) {
      alert(`密钥已生成: ${(d.data.keys as string[])[0]}`);
      fetchAll();
    }
  };

  // 从火山引擎官方 API 同步全量音色
  const syncOfficialVoices = async () => {
    if (!confirm('将从火山引擎官方 API 拉取全量音色并同步到数据库。此操作会更新已有音色信息，但不会删除。确认继续？')) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/voice-platform/api/admin/sync-voices', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        setSyncResult(data.data);
        fetchAll(); // 刷新音色列表
      } else {
        alert(`同步失败: ${data.message || '未知错误'}`);
      }
    } catch {
      alert('同步失败：网络错误');
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="animate-pulse space-y-6">
          <div className="skeleton h-8 w-48" />
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-vp-foreground">管理后台</h1>
      </div>

      {/* Dashboard Stats */}
      {dashboard && (
        <div className="mb-8 space-y-4">
          <div className="flex items-center gap-3">
            <a
              href="https://zyuani8.com/admin"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500/20 text-indigo-200 border border-indigo-400/30 hover:bg-indigo-500/30 transition-colors text-sm font-medium"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              主站管理后台
            </a>
            <span className="text-xs text-vp-muted-foreground">zyuani8.com · 用户管理/订单/语音克隆入口</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: '总用户数', value: dashboard.totalUsers, color: 'bg-blue-50 text-blue-700' },
            { label: '总音色数', value: dashboard.totalVoices, color: 'bg-emerald-50 text-emerald-700' },
            { label: '今日合成', value: dashboard.todayJobs, color: 'bg-amber-50 text-amber-700' },
            { label: '活跃密钥', value: dashboard.activeApiKeys, color: 'bg-purple-50 text-purple-700' },
          ].map((stat) => (
            <div key={stat.label} className={`rounded-2xl p-5 ${stat.color}`}>
              <p className="text-sm opacity-75">{stat.label}</p>
              <p className="text-3xl font-bold mt-1">{stat.value}</p>
            </div>
          ))}
        </div>
        </div>
      )}

      {/* Model Cards — 每个模型独立配置 */}
      <div className="bg-vp-background/60 rounded-2xl border border-vp-border p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-vp-foreground">模型配置</h2>
            <p className="text-xs text-vp-muted-foreground mt-1">每个模型独立配置 API密钥 · 成本价 · 利润率 · 自动计算售价</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowModelForm(true)}>添加模型</Button>
            <Button size="sm" variant="ghost" onClick={() => fetchAll()}>刷新</Button>
          </div>
        </div>

        {/* 模型卡片 — 单列布局 */}
        {models.length === 0 ? (
          <div className="text-center py-8 text-vp-muted-foreground text-sm">暂无模型配置，点击"添加模型"创建</div>
        ) : (
          <div className="space-y-3">
            {models.map((m: any) => {
              const perUnitPrice = (m.totalPrice && m.totalChars) ? (m.totalPrice / m.totalChars) : 0;
              const unitMultiplier = m.unit === '千字符' ? 1000 : 1;
              const costPerUnit = perUnitPrice * unitMultiplier;
              const sellPrice = costPerUnit * (1 + m.profitMargin / 100);
              return (
                <div key={m.id} className="flex items-center gap-4 bg-vp-card/80 rounded-xl border border-vp-border p-4 hover:border-sky-300/30 transition-all">
                  {/* 模型信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-semibold text-vp-foreground whitespace-nowrap">{m.modelId}</h3>
                      <Badge variant={m.isActive ? 'success' : 'default'}>{m.isActive ? '启用' : '禁用'}</Badge>
                    </div>
                  </div>
                  {/* 套餐 */}
                  <div className="text-xs text-vp-muted-foreground whitespace-nowrap">
                    <span className="text-vp-muted-foreground">官价 </span>
                    <span className="text-slate-200">¥{m.totalPrice}/{m.totalChars}{m.unit === '千字符' ? '万字' : m.unit}</span>
                  </div>
                  {/* 成本价 */}
                  <div className="text-xs text-vp-muted-foreground whitespace-nowrap">
                    <span className="text-vp-muted-foreground">成本 </span>
                    <span className="text-slate-200">¥{costPerUnit.toFixed(4)}/{m.unit}</span>
                  </div>
                  {/* 利润率 */}
                  <div className="text-xs whitespace-nowrap">
                    <span className="text-vp-muted-foreground">利润 </span>
                    <span className="text-amber-300">{m.profitMargin}%</span>
                  </div>
                  {/* 售价 */}
                  <div className="text-xs whitespace-nowrap">
                    <span className="text-vp-muted-foreground">售价 </span>
                    <span className="text-emerald-300 font-semibold">¥{sellPrice.toFixed(2)}/{m.unit}</span>
                  </div>
                  {/* 操作 */}
                  <div className="flex gap-2 text-xs whitespace-nowrap">
                    <button onClick={() => { setEditingModel(m); setShowModelForm(true); }} className="text-vp-primary hover:text-vp-primary">编辑</button>
                    <button onClick={() => toggleModelActive(m.id, m.isActive)} className="text-amber-300 hover:text-amber-200">{m.isActive ? '禁用' : '启用'}</button>
                    <button onClick={() => deleteModel(m.id)} className="text-red-400 hover:text-red-300">删除</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 套餐定价 */}
      <div className="bg-vp-background/60 rounded-2xl border border-amber-400/15 p-6 mb-8">
        <h2 className="text-lg font-semibold text-vp-foreground mb-3">套餐定价</h2>
        <p className="text-xs text-vp-muted-foreground mb-4">声音复刻和声音设计为独立套餐产品，通过授权密钥管控，不计入模型扣费系统。</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-vp-card/80 rounded-xl border border-vp-border p-5">
            <span className="text-lg">🎤</span>
            <h3 className="text-sm font-semibold text-vp-foreground mt-1">声音复刻套餐</h3>
            <div className="space-y-1 mt-2 text-xs text-vp-muted-foreground">
              <p>1个音色槽位 · 15次训练</p>
              <p className="text-amber-300 font-semibold text-sm pt-1">¥138.00</p>
            </div>
          </div>
          <div className="bg-vp-card/80 rounded-xl border border-vp-border p-5">
            <span className="text-lg">🎨</span>
            <h3 className="text-sm font-semibold text-vp-foreground mt-1">声音设计套餐</h3>
            <div className="space-y-1 mt-2 text-xs text-vp-muted-foreground">
              <p>1个音色槽位 · 15次训练</p>
              <p className="text-amber-300 font-semibold text-sm pt-1">¥138.00</p>
            </div>
          </div>
        </div>
      </div>

      {/* 扣费说明 — 对接主站 */}
      <div className="bg-vp-background/60 rounded-2xl border border-vp-border p-6 mb-8">
        <h2 className="text-lg font-semibold text-vp-foreground mb-3">扣费说明</h2>
        <div className="space-y-2 text-xs text-vp-muted-foreground">
          <p>· 扣费逻辑跟随主站（zyuani8.com）余额体系，子站不单独充值。</p>
          <p>· 各模型售价 = 成本价 × (1 + 利润率%)，在"模型配置"卡片中自动计算展示。</p>
          <p>· 如需调整扣费策略或对接自有余额系统，请在主站后台管理。</p>
          <a href="https://zyuani8.com/admin" target="_blank" rel="noopener noreferrer" className="inline-block mt-2 text-vp-primary hover:text-vp-primary underline">→ 前往主站后台</a>
        </div>
      </div>

      <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-vp-foreground">克隆授权密钥</h2>
            <p className="text-xs text-vp-muted-foreground mt-1">生成密钥授权学员进行声音复刻/声音设计（138元/音槽）</p>
          </div>
          <Button variant="primary" size="sm" onClick={generateLicenseKey}>
            生成新密钥
          </Button>
        </div>
        {licenses.length === 0 ? (
          <p className="text-xs text-vp-muted-foreground text-center py-4">暂无密钥，点击上方按钮生成</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-vp-border">
                  <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">密钥</th>
                  <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">状态</th>
                  <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">训练次数</th>
                  <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">使用者</th>
                  <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {licenses.map((lic: any) => (
                  <tr key={lic.id} className="border-b border-slate-700/30">
                    <td className="py-3 px-2 font-mono text-xs text-vp-primary">{lic.licenseKey}</td>
                    <td className="py-3 px-2">
                      <Badge variant={lic.status === 'active' ? 'success' : 'default'}>
                        {lic.status === 'active' ? '可用' : lic.status === 'exhausted' ? '已用完' : '已过期'}
                      </Badge>
                    </td>
                    <td className="py-3 px-2 text-xs">
                      <span className={lic.usedTrainings >= lic.maxTrainings ? 'text-red-400' : 'text-emerald-300'}>
                        {lic.usedTrainings || 0} / {lic.maxTrainings || 15}
                      </span>
                    </td>
                    <td className="py-3 px-2 text-xs text-vp-muted-foreground">{lic.assignedTo || '-'}</td>
                    <td className="py-3 px-2">
                      <button
                        onClick={() => { navigator.clipboard.writeText(lic.licenseKey); alert('已复制密钥'); }}
                        className="text-xs text-vp-primary hover:text-vp-primary"
                      >
                        复制
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Voice Management */}
      <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-vp-foreground">音色管理</h2>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              loading={syncing}
              onClick={syncOfficialVoices}
            >
              {syncing ? '同步中...' : '🔄 同步官方音色'}
            </Button>
          </div>
        </div>

        {/* 同步结果 */}
        {syncResult && (
          <div className="mb-4 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
            <p className="text-sm font-semibold text-emerald-700">✅ 同步完成</p>
            <div className="mt-2 grid grid-cols-4 gap-3 text-xs">
              <div>
                <span className="text-vp-muted-foreground">同步前</span>
                <span className="ml-1 font-bold text-slate-700">{syncResult.beforeCount}</span>
              </div>
              <div>
                <span className="text-vp-muted-foreground">同步后</span>
                <span className="ml-1 font-bold text-emerald-600">{syncResult.afterCount}</span>
              </div>
              <div>
                <span className="text-vp-muted-foreground">新增/更新</span>
                <span className="ml-1 font-bold text-sky-600">{syncResult.upserted}</span>
              </div>
              <div>
                <span className="text-vp-muted-foreground">跳过</span>
                <span className="ml-1 font-bold text-vp-muted-foreground">{syncResult.skipped}</span>
              </div>
            </div>
            <p className="text-xs text-vp-muted-foreground mt-2">
              从火山引擎 API 拉取 {syncResult.fetchedFromApi} 个音色，已自动 upsert 到数据库
            </p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-vp-border">
                <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">音色名称</th>
                <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">ID</th>
                <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">类型</th>
                <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">分类</th>
                <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">状态</th>
                <th className="text-left py-3 px-2 text-vp-muted-foreground font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {voices.slice((voicePage - 1) * voicePageSize, voicePage * voicePageSize).map((v) => (
                <tr key={v.id} className="border-b border-gray-50">
                  <td className="py-3 px-2 font-medium">{v.name}</td>
                  <td className="py-3 px-2 font-mono text-xs text-vp-muted-foreground max-w-[120px] truncate">{v.speakerId}</td>
                  <td className="py-3 px-2">
                    <Badge variant={v.type === 'official' ? 'info' : 'indigo'}>
                      {v.type === 'official' ? '官方' : v.type === 'cloned' ? '复刻' : '设计'}
                    </Badge>
                  </td>
                  <td className="py-3 px-2 text-vp-muted-foreground">{v.category}</td>
                  <td className="py-3 px-2">
                    <Badge variant={v.isActive ? 'success' : 'default'}>{v.isActive ? '上架' : '下架'}</Badge>
                  </td>
                  <td className="py-3 px-2">
                    <button
                      onClick={() => toggleRecommend(v.id, !v.isRecommended)}
                      className={`text-xs px-2 py-1 rounded-md transition-colors ${v.isRecommended ? 'bg-amber-400/15 text-amber-300 border border-amber-400/30' : 'text-vp-muted-foreground hover:text-amber-400'}`}
                    >
                      {v.isRecommended ? '⭐ 推荐中' : '设为推荐'}
                    </button>
                  </td>
                  <td className="py-3 px-2">
                    <button
                      onClick={() => toggleVoice(v.id, v.isActive)}
                      className="text-vp-primary hover:text-vp-primary text-xs"
                    >
                      {v.isActive ? '下架' : '上架'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 音色分页 */}
        <div className="mt-4 flex items-center justify-between text-xs text-vp-muted-foreground">
          <span>共 {voices.length} 个音色 · 第 {voicePage}/{Math.ceil(voices.length / voicePageSize)} 页</span>
          <div className="flex gap-2">
            <button
              onClick={() => setVoicePage(Math.max(1, voicePage - 1))}
              disabled={voicePage <= 1}
              className="px-3 py-1 rounded-lg border border-vp-border disabled:opacity-30 hover:border-sky-300/40"
            >
              上一页
            </button>
            <button
              onClick={() => setVoicePage(Math.min(Math.ceil(voices.length / voicePageSize), voicePage + 1))}
              disabled={voicePage >= Math.ceil(voices.length / voicePageSize)}
              className="px-3 py-1 rounded-lg border border-vp-border disabled:opacity-30 hover:border-sky-300/40"
            >
              下一页
            </button>
          </div>
        </div>
      </div>

      {/* Model 编辑弹窗 */}
      <Modal open={showModelForm} onClose={() => { setShowModelForm(false); setEditingModel(null); }} title={editingModel ? '编辑模型' : '添加模型'}>
        <div className="space-y-4">
          {editingModel ? (
            <>
              <Input label="显示名称" value={editingModel.name} onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })} placeholder="如：语音合成 2.0" />
              <Input label="API 模型ID" value={editingModel.modelId} onChange={(e) => setEditingModel({ ...editingModel, modelId: e.target.value })} placeholder="seed-tts-2.0" />
              <Input label="资源ID" value={editingModel.resourceId} onChange={(e) => setEditingModel({ ...editingModel, resourceId: e.target.value })} placeholder="seed-tts-2.0" />
              <Input label="API密钥（留空用 .env 默认）" value={editingModel.apiKey || ''} onChange={(e) => setEditingModel({ ...editingModel, apiKey: e.target.value || null })} placeholder="留空则使用环境变量" />
              <div className="p-3 rounded-lg bg-sky-400/5 border border-sky-400/15">
                <p className="text-xs text-vp-primary mb-2">📐 火山引擎官方套餐定价</p>
                <div className="grid grid-cols-2 gap-3">
                  <Input label="套餐总价（元）" type="number" step="0.01" min="0" value={String(editingModel.totalPrice ?? 28)} onChange={(e) => setEditingModel({ ...editingModel, totalPrice: parseFloat(e.target.value) || 0 })} />
                  <Input label="套餐总字数" type="number" step="1" min="1" value={String(editingModel.totalChars ?? 100000)} onChange={(e) => setEditingModel({ ...editingModel, totalChars: parseInt(e.target.value) || 1000 })} />
                </div>
                <div className="text-[10px] text-vp-muted-foreground mt-2">
                  火山官方刊例价：<span className="text-vp-primary">¥{editingModel.totalPrice || 28}</span> / <span className="text-vp-primary">{(editingModel.totalChars || 100000).toLocaleString()}</span>字
                  {editingModel.unit === '千字符' ? (
                    <span> → 单价 <span className="text-emerald-200">¥{(((editingModel.totalPrice || 28) / (editingModel.totalChars || 100000)) * 1000).toFixed(4)}</span> / 千字符</span>
                  ) : null}
                </div>
                <Input label="计费单位" value={editingModel.unit} onChange={(e) => setEditingModel({ ...editingModel, unit: e.target.value })} placeholder="千字符 / 次" />
              </div>
              <Input label="利润率（%）" type="number" step="1" min="0" value={String(editingModel.profitMargin)} onChange={(e) => setEditingModel({ ...editingModel, profitMargin: parseInt(e.target.value) || 0 })} />
              <div className="text-xs text-emerald-300">
                售价 = ¥{(((editingModel.totalPrice || 28) / (editingModel.totalChars || 100000)) * (editingModel.unit === '千字符' ? 1000 : 1)).toFixed(4)} × (1 + {editingModel.profitMargin}%) = <strong>¥{((((editingModel.totalPrice || 28) / (editingModel.totalChars || 100000)) * (editingModel.unit === '千字符' ? 1000 : 1)) * (1 + editingModel.profitMargin / 100)).toFixed(2)}</strong> / {editingModel.unit}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editingModel.isActive} onChange={(e) => setEditingModel({ ...editingModel, isActive: e.target.checked })} />
                <span>启用</span>
              </label>
              <Button onClick={() => saveModel(editingModel)} className="w-full">保存</Button>
            </>
          ) : (
            <>
              <div className="text-xs text-vp-muted-foreground mb-2">可选择预设模板快速创建</div>
              {[
                { name: '语音合成 2.0', modelId: 'seed-tts-2.0', resourceId: 'seed-tts-2.0', totalPrice: 28, totalChars: 100000, unit: '千字符', profitMargin: 100 },
                { name: '声音复刻 2.0', modelId: 'seed-icl-2.0', resourceId: 'seed-icl-2.0', totalPrice: 28, totalChars: 100000, unit: '千字符', profitMargin: 100 },
                { name: '音频生成 1.0', modelId: 'seed-audio-1.0', resourceId: 'seed-tts-2.0', totalPrice: 28, totalChars: 100000, unit: '次', profitMargin: 100 },
              ].map((preset) => {
                const perChar = preset.totalPrice / preset.totalChars;
                const perUnit = preset.unit === '千字符' ? perChar * 1000 : perChar;
                return (
                  <button
                    key={preset.modelId}
                    onClick={() => {
                      setEditingModel({ ...preset, apiKey: '', isActive: true });
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-vp-border hover:border-sky-300/40 bg-vp-background/40 text-xs text-vp-foreground"
                  >
                    <span className="text-vp-primary font-medium">{preset.name}</span>
                    <span className="text-vp-muted-foreground ml-2">{preset.modelId}</span>
                    <span className="block text-vp-muted-foreground mt-0.5">火山刊例 ¥{preset.totalPrice}/{(preset.totalChars).toLocaleString()}字 · 单价 ¥{perUnit.toFixed(4)}/{preset.unit} · 售价 ¥{(perUnit * (1 + preset.profitMargin/100)).toFixed(2)}/{preset.unit}</span>
                  </button>
                );
              })}
              {editingModel && (
                <div className="pt-3 border-t border-vp-border space-y-3">
                  <Input label="显示名称" value={editingModel.name} onChange={(e) => setEditingModel({ ...editingModel, name: e.target.value })} />
                  <Input label="API 模型ID" value={editingModel.modelId} onChange={(e) => setEditingModel({ ...editingModel, modelId: e.target.value })} />
                  <Input label="资源ID" value={editingModel.resourceId} onChange={(e) => setEditingModel({ ...editingModel, resourceId: e.target.value })} />
                  <Input label="API密钥（留空默认）" value={editingModel.apiKey || ''} onChange={(e) => setEditingModel({ ...editingModel, apiKey: e.target.value || null })} />
                  <div className="p-3 rounded-lg bg-sky-400/5 border border-sky-400/15">
                    <p className="text-xs text-vp-primary mb-2">📐 火山引擎官方套餐定价</p>
                    <div className="grid grid-cols-2 gap-3">
                      <Input label="套餐总价（元）" type="number" step="0.01" min="0" value={String(editingModel.totalPrice ?? 28)} onChange={(e) => setEditingModel({ ...editingModel, totalPrice: parseFloat(e.target.value) || 0 })} />
                      <Input label="套餐总字数" type="number" step="1" min="1" value={String(editingModel.totalChars ?? 100000)} onChange={(e) => setEditingModel({ ...editingModel, totalChars: parseInt(e.target.value) || 1000 })} />
                    </div>
                    <div className="text-[10px] text-vp-muted-foreground mt-1">
                      单价：<span className="text-emerald-200">¥{(((editingModel.totalPrice || 28) / (editingModel.totalChars || 100000)) * (editingModel.unit === '千字符' ? 1000 : 1)).toFixed(4)}</span> / {editingModel.unit}
                    </div>
                    <Input label="计费单位" value={editingModel.unit} onChange={(e) => setEditingModel({ ...editingModel, unit: e.target.value })} placeholder="千字符 / 次" />
                  </div>
                  <Input label="利润率（%）" type="number" step="1" min="0" value={String(editingModel.profitMargin)} onChange={(e) => setEditingModel({ ...editingModel, profitMargin: parseInt(e.target.value) || 0 })} />
                  <div className="text-xs text-emerald-300">
                    售价 = <strong>¥{((((editingModel.totalPrice || 28) / (editingModel.totalChars || 100000)) * (editingModel.unit === '千字符' ? 1000 : 1)) * (1 + editingModel.profitMargin / 100)).toFixed(2)}</strong> / {editingModel.unit}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={editingModel.isActive} onChange={(e) => setEditingModel({ ...editingModel, isActive: e.target.checked })} />
                    <span>启用</span>
                  </label>
                  <Button onClick={() => saveModel(editingModel)} className="w-full">添加</Button>
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
