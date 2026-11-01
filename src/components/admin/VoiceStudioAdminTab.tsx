'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { VOICE_PRICING_SERVICES, voicePricingService, voicePricingSupport, voicePricingUnitMultiplier } from '@/lib/vs/model-config';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ===== 类型定义 =====
interface DashboardData {
  totalUsers: number;
  totalVoices: number;
  todayJobs: number;
  activeApiKeys: number;
  providerConfig?: {
    configured: boolean;
    source: 'plugins' | 'environment' | 'none';
  };
  activeLicenses: number;
  todayRevenue: string;
}

interface ModelConfig {
  id: string;
  name: string;
  modelId: string;
  resourceId: string;
  totalPrice: number;
  totalChars: number;
  costPrice: number;
  unit: string;
  profitMargin: number;
  isActive: boolean;
  sort: number;
  runtimeSupported?: boolean;
  serviceDescription?: string;
}


const API = '/api/admin/voice-studio';

// ===== 主组件 =====
export function VoiceStudioAdminTab() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [modelSaving, setModelSaving] = useState(false);

  const adminFetch = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }, []);

  const adminMutation = async (url: string, init: RequestInit) => {
    const response = await adminFetch(url, init);
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true) throw new Error(data?.message || '操作失败，请稍后重试');
    return data;
  };

  // 音色管理
  const [voices, setVoices] = useState<any[]>([]);
  const [voicePage, setVoicePage] = useState(1);
  const [voiceTotal, setVoiceTotal] = useState(0);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);

  // 模型编辑弹窗
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null);
  const [modelForm, setModelForm] = useState({
    name: '', modelId: '', resourceId: '',
    totalPrice: '', totalChars: '', unit: '千字符', profitMargin: '100', isActive: false,
  });
  const availableServices = VOICE_PRICING_SERVICES.filter(service => !models.some(model => model.modelId === service.modelId));

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [dashRes, modelRes] = await Promise.all([
        adminFetch(`${API}/dashboard`),
        adminFetch(`${API}/models`),
      ]);
      if (!dashRes.ok || !modelRes.ok) {
        throw new Error('管理员会话无效或语音后台暂时不可用');
      }
      const dashData = await dashRes.json();
      const modelData = await modelRes.json();

      if (dashData.success) setDashboard(dashData.data);
      if (modelData.success) setModels(modelData.data);
    } catch (e) {
      console.error('voice-studio admin fetch error:', e);
      setLoadError(e instanceof Error ? e.message : '语音后台加载失败');
    } finally {
      setLoading(false);
    }
  }, [adminFetch]);

  // 音色列表加载
  const fetchVoices = useCallback(async () => {
    try {
      const res = await adminFetch(`${API}/voices?page=${voicePage}&limit=20&search=${encodeURIComponent(voiceSearch)}`);
      if (!res.ok) throw new Error('音色列表加载失败');
      const data = await res.json();
      if (data.success) { setVoices(data.data.voices); setVoiceTotal(data.data.total); }
    } catch {
      setLoadError('音色列表加载失败，请重新登录后重试');
    }
  }, [adminFetch, voicePage, voiceSearch]);

  // 搜索时重置到第一页
  const handleVoiceSearch = (val: string) => {
    setVoiceSearch(val);
    setVoicePage(1);
  };

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => { fetchVoices(); }, 300);
    return () => clearTimeout(timer);
  }, [fetchVoices]);

  const handleSyncVoices = async () => {
    setSyncing(true);
    try {
      setActionError('');
      const data = await adminMutation(`${API}/voices/sync`, { method: 'POST' });
      if (data.success) {
        setSyncResult(data.data);
        setSyncDialogOpen(true);
        fetchVoices();
        fetchAll();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '同步失败');
    } finally {
      setSyncing(false);
    }
  };

  const handleToggleVoice = async (voiceId: string, field: string, value: boolean) => {
    setActionError('');
    try {
      await adminMutation(API + '/voices/' + encodeURIComponent(voiceId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }),
      });
      await fetchVoices();
    } catch (error) { setActionError(error instanceof Error ? error.message : '音色更新失败'); }
  };

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ===== 模型 CRUD =====
  const openAddModel = () => {
    setActionError('');
    setEditingModel(null);
    setModelForm({ name: '', modelId: '', resourceId: '', totalPrice: '', totalChars: '', unit: '千字符', profitMargin: '100', isActive: false });
    setModelDialogOpen(true);
  };

  const openEditModel = (m: ModelConfig) => {
    setActionError('');
    setEditingModel(m);
    setModelForm({
      name: m.name, modelId: m.modelId, resourceId: m.resourceId || '',
      totalPrice: String(m.totalPrice), totalChars: String(m.totalChars),
      unit: m.unit || '千字符', profitMargin: String(m.profitMargin), isActive: !!m.isActive,
    });
    setModelDialogOpen(true);
  };

  const saveModel = async () => {
    if (modelSaving) return;
    setModelSaving(true); setActionError('');
    const body = { ...modelForm, totalPrice: Number(modelForm.totalPrice), totalChars: Number(modelForm.totalChars), profitMargin: Number(modelForm.profitMargin) };
    try {
      await adminMutation(API + '/models', { method: editingModel ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editingModel ? { id: editingModel.id, ...body } : body) });
      setModelDialogOpen(false); await fetchAll();
    } catch (error) { setActionError(error instanceof Error ? error.message : '模型保存失败'); }
    finally { setModelSaving(false); }
  };
  const deleteModel = async (id: string) => {
    if (!confirm('确认删除此模型配置？')) return;
    setActionError('');
    try { await adminMutation(API + '/models?id=' + encodeURIComponent(id), { method: 'DELETE' }); await fetchAll(); }
    catch (error) { setActionError(error instanceof Error ? error.message : '删除失败'); }
  };
  const toggleModelActive = async (m: ModelConfig) => {
    setActionError('');
    try { await adminMutation(API + '/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id, isActive: !m.isActive }) }); await fetchAll(); }
    catch (error) { setActionError(error instanceof Error ? error.message : '模型更新失败'); }
  };

  // ===== 渲染 =====
  if (loading) {
    return <div className="flex items-center justify-center py-20 text-muted-foreground">加载中...</div>;
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center" role="alert">
        <p className="text-sm font-semibold text-destructive">{loadError}</p>
        <Button type="button" variant="outline" onClick={() => void fetchAll()}>重新加载</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {actionError && !modelDialogOpen && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      {/* ===== 1. 仪表盘统计 ===== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="本站用户数" value={dashboard?.totalUsers ?? 0} color="bg-blue-500/10 text-blue-400" />
        <StatCard label="总音色数" value={dashboard?.totalVoices ?? 0} color="bg-emerald-500/10 text-emerald-400" />
        <StatCard label="今日完成合成" value={dashboard?.todayJobs ?? 0} color="bg-amber-500/10 text-amber-400" />
        <StatCard label="供应商配置" value={dashboard?.activeApiKeys ?? 0} color="bg-purple-500/10 text-purple-400" />
      </div>

      {/* ===== 2. 模型配置 ===== */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">语音服务计价</CardTitle>
            <CardDescription className="text-xs mt-1">
              为已接入的语音服务配置价格；添加计价项不会接入新的供应商或模型版本。供应商密钥由主站统一配置中心管理。
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={fetchAll}>刷新</Button>
            <Button size="sm" onClick={openAddModel} disabled={availableServices.length === 0} title={availableServices.length === 0 ? '已支持的计价服务均已配置，请编辑现有项' : undefined}>添加计价服务</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {models.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">暂无计价服务，请先选择已接入服务并填写确认后的价格</p>
          ) : models.map(m => {
            const costPrice = m.costPrice;
            const sellPrice = costPrice * (1 + m.profitMargin / 100);
            const quantity = Number(m.totalChars).toLocaleString('zh-CN');
            const twStr = `¥${m.totalPrice}/${quantity}${m.unit === '千字符' ? '字符' : m.unit}`;
            return (
              <div key={m.id} className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                {/* 模型名 & 状态 */}
                <div className="flex items-center gap-2 min-w-[160px]">
                  <span className="font-mono text-sm font-semibold">{m.modelId}</span>
                  <Badge variant={m.isActive ? 'default' : 'secondary'} className="text-[10px] px-1.5">
                    {m.isActive ? '计价已启用' : '计价已停用'}
                  </Badge>
                  {!voicePricingService(m.modelId) && <Badge variant="outline" className="text-[10px] px-1.5">{voicePricingSupport(m.modelId).status === 'retired' ? '历史服务已退役' : '服务未接入'}</Badge>}
                </div>
                {/* 定价信息 */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground flex-1">
                  <span>官价: <b className="text-foreground">{twStr}</b></span>
                  <span>成本: <b className="text-foreground">¥{costPrice.toFixed(4)}/{m.unit}</b></span>
                  <span>加价率: <b className="text-foreground">{m.profitMargin}%</b></span>
                  <span>售价: <b className="text-emerald-400">¥{sellPrice.toFixed(2)}/{m.unit}</b></span>
                </div>
                {/* 操作 */}
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => toggleModelActive(m)} disabled={!m.isActive && !voicePricingService(m.modelId)}>
                    {m.isActive ? '禁用' : '启用'}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => openEditModel(m)}>编辑</Button>
                  <Button size="sm" variant="ghost" className="text-xs h-7 text-destructive hover:text-destructive" onClick={() => deleteModel(m.id)}>删除</Button>
                </div>
                <p className="w-full text-xs text-muted-foreground">{m.serviceDescription || voicePricingSupport(m.modelId).description}</p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ===== 5. 扣费说明 ===== */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">扣费说明</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>• 扣费逻辑跟随主站余额体系，子站不单独充值。</p>
          <p>• 各服务售价 = 成本价 × (1 + 加价率%)，在“语音服务计价”卡片中自动计算展示。</p>
          <p>• 如需调整扣费策略或对接自有余额系统，请在主站后台管理。</p>
          <a href="/admin" className="inline-block mt-2 text-primary hover:underline text-sm">→ 前往主站后台</a>
        </CardContent>
      </Card>

      {/* ===== 音色管理 ===== */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">音色管理</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">共 {voiceTotal} 个音色</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索音色名称或ID..."
                value={voiceSearch}
                onChange={(e) => handleVoiceSearch(e.target.value)}
                className="h-8 w-[200px] pl-8 text-sm"
              />
            </div>
            <Button variant="outline" size="sm" onClick={fetchVoices}>
              <RefreshCw className="h-3 w-3 mr-1" /> 刷新
            </Button>
            <Button variant="outline" size="sm" onClick={handleSyncVoices} disabled={syncing}>
              <RefreshCw className={`h-3 w-3 mr-1 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? '同步中...' : '同步已核对中文音色'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">名称</TableHead>
                <TableHead className="w-[200px]">Speaker ID</TableHead>
                <TableHead>分类</TableHead>
                <TableHead className="w-[60px]">性别</TableHead>
                <TableHead className="w-[60px]">推荐</TableHead>
                <TableHead className="w-[60px]">启用</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {voices.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {voiceSearch ? '未找到匹配的音色' : '暂无音色数据'}
                  </TableCell>
                </TableRow>
              ) : voices.map((v: any) => (
                <TableRow key={v.id}>
                  <TableCell className="font-medium text-sm">{v.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">{v.speakerId}</TableCell>
                  <TableCell><Badge variant="secondary" className="text-xs">{v.category || '—'}</Badge></TableCell>
                  <TableCell className="text-xs">{v.gender === 'female' ? '女' : v.gender === 'male' ? '男' : '—'}</TableCell>
                  <TableCell>
                    <Switch
                      checked={!!v.isRecommended}
                      onCheckedChange={() => handleToggleVoice(v.id, 'isRecommended', !v.isRecommended)}
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={!!v.isActive}
                      onCheckedChange={() => handleToggleVoice(v.id, 'isActive', !v.isActive)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {/* 分页 */}
          {voiceTotal > 0 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-muted-foreground">
                第 {(voicePage - 1) * 20 + 1}-{Math.min(voicePage * 20, voiceTotal)} 条，共 {voiceTotal} 条
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={voicePage <= 1}
                  onClick={() => setVoicePage(p => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                {Array.from({ length: Math.ceil(voiceTotal / 20) }, (_, i) => i + 1)
                  .filter(p => {
                    const total = Math.ceil(voiceTotal / 20);
                    if (total <= 7) return true;
                    if (p === 1 || p === total) return true;
                    if (Math.abs(p - voicePage) <= 1) return true;
                    return false;
                  })
                  .map((p, idx, arr) => {
                    const prev = arr[idx - 1];
                    const showEllipsis = prev && p - prev > 1;
                    return (
                      <span key={p} className="flex items-center">
                        {showEllipsis && <span className="px-1 text-muted-foreground text-xs">...</span>}
                        <Button
                          variant={p === voicePage ? 'default' : 'outline'}
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setVoicePage(p)}
                        >
                          {p}
                        </Button>
                      </span>
                    );
                  })}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={voicePage >= Math.ceil(voiceTotal / 20)}
                  onClick={() => setVoicePage(p => Math.min(Math.ceil(voiceTotal / 20), p + 1))}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 模型编辑弹窗 ===== */}
      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editingModel ? '编辑计价服务' : '添加计价服务'}</DialogTitle>
            <DialogDescription>此处配置已接入服务的计价，不新增供应商。标准版、表现力增强版等具体合成版本在前台选择；供应商密钥由主站统一配置中心管理，不在此页面回显或保存。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>显示名称</Label>
                <Input placeholder="如: 语音合成 2.0" value={modelForm.name} onChange={e => setModelForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="voice-pricing-service">计价服务</Label>
                <Select value={modelForm.modelId} onValueChange={value => {
                  const service = voicePricingService(value);
                  if (service) setModelForm(form => ({ ...form, modelId: value, name: service.name, resourceId: service.resourceId, unit: service.unit }));
                }} disabled={!!editingModel}>
                  <SelectTrigger id="voice-pricing-service"><SelectValue placeholder="选择已接入服务" /></SelectTrigger>
                  <SelectContent>
                    {editingModel && !voicePricingService(editingModel.modelId) && <SelectItem value={editingModel.modelId}>历史未接入项：{editingModel.modelId}</SelectItem>}
                    {VOICE_PRICING_SERVICES.map(service => <SelectItem key={service.modelId} value={service.modelId} disabled={!editingModel && models.some(model => model.modelId === service.modelId)}>{service.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {modelForm.modelId && <p className="text-[11px] text-muted-foreground">计价标识：{modelForm.modelId}</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>资源标识</Label>
                <Input placeholder="所选服务的资源标识" value={modelForm.resourceId} onChange={e => setModelForm(f => ({ ...f, resourceId: e.target.value }))} />
                <p className="text-[11px] text-muted-foreground">用于计价配置说明，不改变供应商连接或前台模型版本。</p>
              </div>
              <div className="space-y-2">
                <Label>计费单位</Label>
                <Select value={modelForm.unit} onValueChange={v => setModelForm(f => ({ ...f, unit: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="千字符">千字符</SelectItem>
                    <SelectItem value="分钟">分钟</SelectItem>
                    <SelectItem value="次">次</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="rounded-lg border border-border/50 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
              供应商配置：{dashboard?.providerConfig?.configured
                ? `已配置（${dashboard.providerConfig.source === 'plugins' ? '主站配置中心' : '服务器环境'}）；实际可用性仍需生成验证`
                : '未连接；请在主站统一配置中心完成供应商密钥配置'}
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>确认后的套餐成本 (¥)</Label>
                <Input type="number" value={modelForm.totalPrice} onChange={e => setModelForm(f => ({ ...f, totalPrice: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>套餐计费数量</Label>
                <Input type="number" value={modelForm.totalChars} onChange={e => setModelForm(f => ({ ...f, totalChars: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>加价率 (%)</Label>
                <Input type="number" value={modelForm.profitMargin} onChange={e => setModelForm(f => ({ ...f, profitMargin: e.target.value }))} />
              </div>
            </div>
            {/* 预览计算 */}
            {(() => {
              const tw = Number(modelForm.totalPrice) || 0;
              const tc = Number(modelForm.totalChars) || 1;
              if (!modelForm.totalPrice.trim() || !modelForm.totalChars.trim() || tw <= 0 || tc <= 0) return <p className="text-xs text-muted-foreground">填写确认后的套餐成本和计费数量后显示预览。</p>;
              const cp = tw / tc * voicePricingUnitMultiplier(modelForm.unit);
              const sp = cp * (1 + (Number(modelForm.profitMargin) || 0) / 100);
              return (
                <div className="rounded-lg bg-muted/50 px-4 py-3 text-xs text-muted-foreground space-y-1">
                  <p>成本价 = {tw} ÷ {tc} × {voicePricingUnitMultiplier(modelForm.unit)} = <b className="text-foreground">¥{cp.toFixed(4)}/{modelForm.unit}</b></p>
                  <p>售价 = {cp.toFixed(4)} × (1 + {modelForm.profitMargin}%) = <b className="text-emerald-400">¥{sp.toFixed(2)}/{modelForm.unit}</b></p>
                </div>
              );
            })()}
            <div className="flex items-center gap-2">
              <Switch checked={modelForm.isActive} onCheckedChange={v => setModelForm(f => ({ ...f, isActive: v }))} disabled={!voicePricingService(modelForm.modelId) && !modelForm.isActive} />
              <Label>启用此计价服务</Label>
            </div>
          </div>
          {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setModelDialogOpen(false)}>取消</Button>
            <Button onClick={saveModel} disabled={modelSaving || !modelForm.name || !modelForm.modelId || !modelForm.totalPrice.trim() || !modelForm.totalChars.trim()}>{modelSaving ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 同步结果 Dialog */}
      <Dialog open={syncDialogOpen} onOpenChange={setSyncDialogOpen}>
        <DialogContent className="max-w-2xl bg-[var(--card)] border-[var(--border)] text-[var(--card-foreground)]">
          <DialogHeader>
            <DialogTitle className="text-foreground">同步结果</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              火山引擎官方音色 · 接近真人 · 中文/中英混合
            </DialogDescription>
          </DialogHeader>
          {syncResult && (
            <div className="space-y-4">
              {/* 总览卡片 */}
              <div className="grid grid-cols-4 gap-3">
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-center">
                  <div className="text-2xl font-bold text-foreground">{syncResult.matched ?? 0}</div>
                  <div className="text-xs text-muted-foreground mt-1">匹配</div>
                </div>
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-center">
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{syncResult.added ?? 0}</div>
                  <div className="text-xs text-muted-foreground mt-1">新增</div>
                </div>
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-center">
                  <div className="text-2xl font-bold text-sky-600 dark:text-sky-400">{syncResult.updated ?? 0}</div>
                  <div className="text-xs text-muted-foreground mt-1">更新</div>
                </div>
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-center">
                  <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{syncResult.skipped ?? 0}</div>
                  <div className="text-xs text-muted-foreground mt-1">跳过</div>
                </div>
              </div>

              {/* 跳过原因分布 */}
              {syncResult.skippedDetails && (
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="text-xs font-semibold text-muted-foreground mb-2">跳过原因分布</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="flex items-center justify-between px-2 py-1 rounded bg-background">
                      <span className="text-muted-foreground">非中文</span>
                      <span className="font-semibold text-foreground">{syncResult.skippedDetails.nonChinese ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between px-2 py-1 rounded bg-background">
                      <span className="text-muted-foreground">非接近真人</span>
                      <span className="font-semibold text-foreground">{syncResult.skippedDetails.nonRealistic ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between px-2 py-1 rounded bg-background">
                      <span className="text-muted-foreground">其他</span>
                      <span className="font-semibold text-foreground">{syncResult.skippedDetails.other ?? 0}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* 新增音色列表 */}
              {syncResult.addedVoices && syncResult.addedVoices.length > 0 && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 mb-2">
                    ✅ 新增 {syncResult.addedVoices.length} 个中文音色
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1.5">
                    {syncResult.addedVoices.map((v: any) => (
                      <div key={v.speakerId} className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-background">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">{v.name}</span>
                          <span className="text-muted-foreground">· {v.speakerId}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{v.gender}</span>
                          <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{v.scene}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 更新音色列表 */}
              {syncResult.updatedVoices && syncResult.updatedVoices.length > 0 && (
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
                  <div className="text-xs font-semibold text-sky-700 dark:text-sky-300 mb-2">
                    🔄 更新 {syncResult.updatedVoices.length} 个音色
                  </div>
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {syncResult.updatedVoices.map((v: any) => (
                      <div key={v.speakerId} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-background">
                        <span className="font-semibold text-foreground">{v.name}</span>
                        <span className="text-muted-foreground">{v.speakerId}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 官方音色总数提示 */}
              <div className="text-xs text-muted-foreground text-center pt-2 border-t border-border">
                已核对目录音色总数：{syncResult.official ?? 0} 个 · 本次匹配：{syncResult.matched ?? 0} 个
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSyncDialogOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ===== 子组件 =====
function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-lg border border-border/40 px-4 py-3 ${color}`}>
      <p className="text-xs opacity-70 mb-1">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

