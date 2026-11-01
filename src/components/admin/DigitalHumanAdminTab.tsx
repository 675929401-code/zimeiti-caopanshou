'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { humanQuote } from '@/features/digital-human/client-state';
import { modelMutationAttempt, type ModelMutationAttempt } from './model-mutation-request';
import { readModelCandidateReceipt, modelCandidateSaveMessage } from './model-candidate-receipt';
import { explicitNonNegativePrice, videoPriceConfigurationError } from '@/lib/model-price-rounding';
import { HUMAN_PRESETS } from '@/features/digital-human/presets';
const ValidationDialog = dynamic(() => import('@/components/admin-video-validation-dialog'), { ssr: false });
type Row = { provider: string; id: string; name: string; model_name: string; protocol_type: string; api_endpoint: string; price_per_use: number; cost_price: number; duration_seconds: number; max_duration: number; is_active: boolean; is_hidden: boolean; api_key_configured?: boolean; supports_image_input: boolean; api_protocol_config: Record<string, unknown> };
type Form = { provider: string; id: string; name: string; model_name: string; protocol_type: string; api_endpoint: string; api_key: string; api_key_configured?: boolean; accessKeyId?: string; secretAccessKey?: string; price: string; cost: string; config: string; max: number; image: boolean };
const newForm = (index = 0): Form => { const preset = HUMAN_PRESETS[index]; return { provider: preset.provider, id: '', name: preset.name, model_name: preset.model, protocol_type: preset.protocol, api_endpoint: preset.endpoint, api_key: '', price: String(preset.price), cost: String(preset.cost), config: JSON.stringify(preset.config, null, 2), max: preset.config.max_duration, image: preset.mode === 'photo' }; };

export function DigitalHumanAdminTab({ token }: { token: string }) {
  const saveAttempt = useRef<ModelMutationAttempt | null>(null);
  const saveLock = useRef(false);
  const [candidateId, setCandidateId] = useState('');
  const [rows, setRows] = useState<Row[]>([]), [form, setForm] = useState<Form | null>(null), [testing, setTesting] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const load = useCallback(async () => { const response = await fetch('/api/admin/video-models', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || '配置读取失败'); setRows((data.models || []).filter((row: Row) => Array.isArray(row.api_protocol_config?.workspace_surfaces) && row.api_protocol_config.workspace_surfaces.includes('digital-human'))); }, [token]);
  useEffect(() => { void load().catch(cause => setError(cause.message)); }, [load]);
  async function save() {
    if (!form || saveLock.current) return; saveLock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (!form.name.trim() || !form.api_endpoint.startsWith('https://')) throw new Error('请填写模型名称与 HTTPS 接口地址');
      const price = explicitNonNegativePrice(form.price), cost = explicitNonNegativePrice(form.cost);
      if (price === null || cost === null) throw new Error('请填写明确的非负售价与成本；未知金额请留待核实');
      const config = JSON.parse(form.config); if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('协议配置须为 JSON 对象');
      config.workspace_surfaces = ['digital-human'];
      if (config.billing_unit === 'output_second') {
        const resolution = String(config.default_resolution || '480p');
        config.resolution_prices = { ...config.resolution_prices, [resolution]: price };
        config.resolution_cost_prices = { ...config.resolution_cost_prices, [resolution]: cost };
      }
      const priceError = videoPriceConfigurationError({ costPrice: cost, sellingPrice: price, protocolConfig: config });
      if (priceError) throw new Error(priceError);
      let apiKey = form.api_key.trim();
      if (form.protocol_type === 'volcengine_digital_human') {
        if (form.accessKeyId || form.secretAccessKey) {
          if (!form.accessKeyId?.trim() || !form.secretAccessKey?.trim()) throw new Error('请同时填写火山 Access Key ID 与 Secret Access Key');
          apiKey = JSON.stringify({ accessKeyId: form.accessKeyId.trim(), secretAccessKey: form.secretAccessKey.trim() });
        }
        if (!form.id && (price <= 0 || cost <= 0)) throw new Error('请按已开通的火山服务填写售价和成本');
      }
      if (!form.provider.trim()) throw new Error('缺少模型渠道标识，请在模型资源池核对配置');
      const body = { provider: form.provider, ...(form.id ? { id: form.id } : {}), name: form.name, model_name: form.model_name, api_endpoint: form.api_endpoint, protocol_type: form.protocol_type,
        ...(apiKey ? { api_key: apiKey } : {}), price_per_use: price, cost_price: cost, duration_seconds: Math.ceil(Number(config.min_duration)) || 4, max_duration: Number(config.max_duration) || form.max,
        supports_image_input: form.image, api_protocol_config: config };
      if (!form.id && !apiKey) throw new Error('新增模型请填写 API Key 或已配置的服务器密钥引用');
      const response = await fetch('/api/admin/video-models', { method: form.id ? 'PUT' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': (saveAttempt.current = modelMutationAttempt(saveAttempt.current, form.id ? 'PUT' : 'POST', body)).id }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '配置保存失败');
      const receipt = readModelCandidateReceipt(data); saveAttempt.current = null;
      setCandidateId(receipt.id); setForm(null); setNotice(modelCandidateSaveMessage(receipt, '已保存为待发布候选。请先校验、预览和发布模型池，再完成真实验证及工作台分配。')); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '配置保存失败'); } finally { saveLock.current = false; setBusy(false); }
  }
  let formConfig: Record<string, any> | null = null;
  try { formConfig = form ? JSON.parse(form.config) : null; } catch { /* Advanced editor validates on save. */ }
  const perSecond = formConfig?.billing_unit === 'output_second';
  const previewModel = { publicPrice: Number(form?.price || 0), capabilities: { ...formConfig, billingUnit: perSecond ? 'output_second' : 'per_use', minDuration: formConfig?.min_duration, maxDuration: formConfig?.max_duration, defaultDuration: formConfig?.min_duration, durationMode: formConfig?.supports_duration ? 'range' : 'fixed', durationStep: formConfig?.duration_step } };
  const field = 'w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-2 text-sm';
  const button = 'rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50';
  return <section className="space-y-5"><header className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">数字人配置</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">照片说话与视频改口型分别配置，验证成功后向前台发布。</p></div><div className="flex gap-3"><Link className={button} href="/digital-human">打开工作台</Link><button className={button} onClick={() => { setForm(newForm()); setError(''); }}>添加数字人模型</button><button className={button} onClick={() => { setForm(newForm(2)); setError(''); }}>接入火山改口型</button></div></header>
    <details className="rounded-xl border border-[var(--border)] p-4 text-sm"><summary className="cursor-pointer font-medium">上游成本与本站售价说明</summary><div className="mt-3 space-y-2 text-[var(--text-secondary)]"><p>本站现金钱包来自用户充值账目，与供应商账户余额分开。数字人视频复用主站现金扣费、任务与历史；智音工坊配音复用主站积分计费。</p><p>火山视觉改口型 Lite / Basic：官方标准成本 ¥0.30/秒，折合 ¥18/分钟。Lite 支持配音大于 1 秒且最长 240 秒、人物视频 3–350 秒。本站售价按成本预填，可调整利润后保存。</p><p>即梦 OmniHuman1.5 照片说话：当前控制台标准成本 ¥1/秒，按生成视频时长结算，不按整分钟进位；单次配音必须小于 60 秒，建议 15 秒以内。支持 720p 快速模式与 1080p 标准模式。</p><p>参考：<a className="text-[var(--primary)] underline" href="https://docs.volcengine.com/docs/85128/1465367?lang=zh" target="_blank" rel="noreferrer">火山改口型官方价格</a> · 核对日期 2026-09-03；以供应商账户实际合同和账单为准。</p><p>阿里 VideoRetalk 标准成本 ¥0.08/秒，万相照片说话 480p ¥0.50/秒、720p ¥0.90/秒。显示给用户的是本站售价，只有此管理员页面展示上游成本。</p></div></details>
    {error && <p role="alert" className="rounded-lg border border-red-400/50 p-3 text-sm text-red-300">{error}</p>}{notice && <div role="status" className="space-y-2 text-sm text-[var(--primary)]"><p>{notice}</p>{candidateId && <Link className="underline" href={`/admin?tab=models&candidateId=${encodeURIComponent(candidateId)}`}>查看本次候选 {candidateId}</Link>}</div>}
    {form && <form className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="flex items-center justify-between"><h3 className="font-semibold">{form.id ? '编辑数字人模型' : '添加数字人模型'}</h3><button type="button" className={button} onClick={() => setForm(null)}>取消</button></div>
      {!form.id && <label className="space-y-1 text-sm">接入方式<select aria-label="接入方式" className={field} value={form.model_name} onChange={event => setForm(newForm(HUMAN_PRESETS.findIndex(preset => preset.model === event.target.value)))}>{HUMAN_PRESETS.map(preset => <option key={preset.model} value={preset.model}>{preset.name}</option>)}</select></label>}
      <div className="grid gap-4 md:grid-cols-2"><label className="space-y-1 text-sm">前台名称<input className={field} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label><label className="space-y-1 text-sm">上游模型标识<input className={field} value={form.model_name} onChange={event => setForm({ ...form, model_name: event.target.value })} /></label></div>
      <label className="space-y-1 text-sm">API 地址<input className={field} type="url" value={form.api_endpoint} onChange={event => setForm({ ...form, api_endpoint: event.target.value })} /></label>
      <p role="status" className={form.api_key_configured ? 'rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-400' : 'rounded-lg border border-amber-500/30 p-3 text-sm text-amber-400'}>{form.api_key_configured ? '密钥已配置在后端。为保护密钥，编辑框不显示原文；留空保存会保留原密钥，只有填入新值才会替换。' : '尚未配置密钥，请填入服务商凭据或已配置的服务器密钥引用。'}</p>
      {form.protocol_type === 'volcengine_digital_human' && <p className="text-sm text-[var(--text-secondary)]">使用火山视觉智能服务 AK/SK 签名认证；火山语音 Token、方舟 API Key 不能代替。更换时请同时填写 AK 和 SK；保留原密钥时两个输入框都留空。</p>}
      {form.protocol_type === 'volcengine_digital_human' && <div className="grid gap-4 md:grid-cols-2"><label className="space-y-1 text-sm">Access Key ID<input className={field} type="password" autoComplete="new-password" placeholder={form.api_key_configured ? '已配置；留空保留原 AK' : '填写 Access Key ID'} value={form.accessKeyId || ''} onChange={event => setForm({ ...form, accessKeyId: event.target.value })} /></label><label className="space-y-1 text-sm">Secret Access Key<input className={field} type="password" autoComplete="new-password" placeholder={form.api_key_configured ? '已配置；留空保留原 SK' : '填写 Secret Access Key'} value={form.secretAccessKey || ''} onChange={event => setForm({ ...form, secretAccessKey: event.target.value })} /></label></div>}
      <label className="space-y-1 text-sm">{form.protocol_type === 'volcengine_digital_human' ? '或使用服务器密钥引用' : 'API Key'}<input className={field} type="password" autoComplete="new-password" value={form.api_key} onChange={event => setForm({ ...form, api_key: event.target.value })} placeholder={form.api_key_configured ? '已配置；留空保留原密钥' : form.protocol_type === 'volcengine_digital_human' ? 'env://VOLCENGINE_VISUAL_CREDENTIALS' : '填写 API Key；阿里可填写 env://DASHSCOPE_API_KEY'} /></label>
      <div className="grid gap-4 md:grid-cols-2"><label className="space-y-1 text-sm">默认画质售价（元/{perSecond ? '秒' : '次'}）<input className={field} type="number" min="0" step="0.001" value={form.price} onChange={event => setForm({ ...form, price: event.target.value })} /></label><label className="space-y-1 text-sm">默认画质成本（元/{perSecond ? '秒' : '次'}）<input className={field} type="number" min="0" step="0.001" value={form.cost} onChange={event => setForm({ ...form, cost: event.target.value })} /></label></div>
      <div className="rounded-lg border border-[var(--border)] p-3 text-sm space-y-2"><strong>计费方式：{perSecond ? '按生成秒数计费' : '按成功任务次数计费'}</strong><p className="text-[var(--text-secondary)]">{perSecond ? '不按整分钟进位。任务提交时锁定单价与生成时长，最终金额四舍五入到分。成功交付扣费，失败不收视频费。' : '成功交付收取一次费用，失败不收视频费。'}</p>{perSecond && <p>默认画质示例：{[30, 40, 60, 61, 90].filter(value => value >= Number(formConfig?.min_duration || 1) && value <= Number(formConfig?.max_duration || form.max) && !(formConfig?.req_key === 'jimeng_realman_avatar_picture_omni_v15' && value >= 60)).map(value => value + '秒 ¥' + humanQuote(previewModel, '', value).toFixed(2)).join('；') || '当前模型时长较短，请以支持时长内的预估费用为准'}</p>}</div>
      {formConfig && Object.entries(formConfig.resolution_prices || {}).filter(([resolution]) => resolution !== formConfig?.default_resolution).map(([resolution, price]) => <div key={resolution} className="grid gap-4 md:grid-cols-2"><label className="space-y-1 text-sm">{resolution} 售价（元/{perSecond ? '秒' : '次'}）<input className={field} type="number" min="0" step="0.001" value={String(price)} onChange={event => setForm({ ...form, config: JSON.stringify({ ...formConfig, resolution_prices: { ...formConfig?.resolution_prices, [resolution]: event.target.value } }, null, 2) })} /></label><label className="space-y-1 text-sm">{resolution} 成本（元/{perSecond ? '秒' : '次'}）<input className={field} type="number" min="0" step="0.001" value={String(formConfig?.resolution_cost_prices?.[resolution] ?? 0)} onChange={event => setForm({ ...form, config: JSON.stringify({ ...formConfig, resolution_cost_prices: { ...formConfig?.resolution_cost_prices, [resolution]: event.target.value } }, null, 2) })} /></label></div>)}
      <details><summary className="cursor-pointer text-sm">高级协议参数</summary><textarea className={field + ' mt-3 font-mono'} rows={16} aria-label="数字人协议配置" value={form.config} onChange={event => setForm({ ...form, config: event.target.value })} /></details>
      <button className="rounded-lg bg-[var(--primary)] p-3 font-semibold text-[var(--primary-foreground)] disabled:opacity-50" disabled={busy}>{busy ? '正在保存…' : '保存配置'}</button>
    </form>}
    <div className="grid gap-3">{rows.map(row => <article key={row.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--border)] p-4"><div><h3 className="font-semibold">{row.name}</h3><p className="mt-1 text-sm text-[var(--text-secondary)]">{row.api_key_configured ? '密钥已配置 · 后端保存' : '尚未配置密钥'}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{row.api_protocol_config.requires_source_video ? '视频改口型' : '照片说话'} · ¥{Number(row.price_per_use).toFixed(3)}/{row.api_protocol_config.billing_unit === 'output_second' ? '秒' : '次'} · {row.api_protocol_config.__model_activation_gate && (row.api_protocol_config.__model_activation_gate as Record<string, unknown>).state === 'pending' ? '待真实验证' : row.is_active ? '已启用' : '未启用'}</p></div><div className="flex flex-wrap gap-2"><button className={button} onClick={() => { setError(''); setForm({ provider: row.provider, id: row.id, name: row.name, model_name: row.model_name, protocol_type: row.protocol_type, api_endpoint: row.api_endpoint, api_key: '', api_key_configured: row.api_key_configured === true, price: String(row.price_per_use), cost: String(row.cost_price), config: JSON.stringify(row.api_protocol_config, null, 2), max: row.max_duration, image: row.supports_image_input }); }}>编辑</button><button className={button} onClick={() => setTesting(row)}>生成验证（管理员诊断）</button></div></article>)}</div>
    {testing && <ValidationDialog modelId={testing.id} modelName={testing.name} listedPrice={Number(testing.price_per_use)} token={token} onClose={() => setTesting(null)} onPublished={() => { void load(); setNotice('验证通过的模型已发布，前台将读取最新配置。'); }} />}
  </section>;
}
