// lconai中转站模型接入：视频4款经主站admin API隔离保存（is_active=false+gate pending）。
// 协议 newapi_video（POST /v1/videos + GET /v1/videos/{id}，2026-09-11 lconai.apifox.cn核验）。
// 价格=成本×1.10（relay-model-onboarding标准）；来源 n.lconai.com 模型广场 B1组（2026-09-11）。
const ORIGIN = 'http://127.0.0.1:5000';
const LCONAI_KEY = process.argv[2];
if (!LCONAI_KEY || !LCONAI_KEY.startsWith('sk-')) throw new Error('缺少lconai密钥参数');

const login = await fetch(`${ORIGIN}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: '18685178259', password: 'Admin@2026abc' }),
});
const token = (await login.json()).token;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const base = {
  api_endpoint: 'https://n.lconai.com',
  api_key: LCONAI_KEY,
  protocol_type: 'newapi_video',
  supports_image_input: true,
  sort_order: 60,
};
const cfg = (over = {}) => ({
  submit_path: '/v1/videos',
  poll_path: '/v1/videos/{id}',
  result_url_path: 'video_url',
  connection_group: 'video-NewAPI · lconai B1',
  provider_channel: 'lconai:video-newapi:B1',
  documentation_url: 'https://lconai.apifox.cn/',
  price_source_url: 'https://n.lconai.com/pricing',
  price_verified_at: '2026-09-11T03:40:00+08:00',
  price_verification: 'account',
  billing_unit: 'output_second',
  supports_prompt: true,
  supports_duration: true,
  duration_step: 1,
  min_duration: 4,
  max_duration: 15,
  min_submit_duration: 4,
  duration_options: [5, 10, 15],
  aspect_ratios: ['16:9', '9:16', '4:3', '1:1', '3:4', '21:9'],
  resolution_options: ['480p'],
  default_resolution: '480p',
  max_reference_images: 1,
  workspace_surfaces: ['ai-video', 'storyboard'],
  supports_audio_input: false,
  workflow_input_mode: 'single_image',
  ...over,
});

const models = [
  {
    id: 'lconai-seedance-2-0-mini-480p', name: 'Seedance 2.0 Mini · 480P · 轻量快速（中转lconai）',
    model_name: 'seedance-2-0-mini-480p-i2v', cost_price: 0.225, price_per_use: 0.2475,
    admin_notes: '【内部渠道备注｜仅管理员可见】lconai（n.lconai.com）B1组1x；Seedance 2.0 Mini轻量档，文生/图生视频，成本敏感与高并发场景；按秒计费。来源：模型广场2026-09-11。',
  },
  {
    id: 'lconai-seedance-2-0-1080p', name: 'Seedance 2.0 · 1080P · 高清（中转lconai）',
    model_name: 'seedance-2-0-1080p-i2v', cost_price: 2.25, price_per_use: 2.475,
    admin_notes: '【内部渠道备注｜仅管理员可见】lconai B1组1x；Seedance 2.0标准档1080P；按秒计费。',
    cfg: { resolution_options: ['1080p'], default_resolution: '1080p' },
  },
  {
    id: 'lconai-seedance-2-0-4k', name: 'Seedance 2.0 · 4K · 超清（中转lconai）',
    model_name: 'seedance-2-0-4k-i2v', cost_price: 4.5, price_per_use: 4.95,
    admin_notes: '【内部渠道备注｜仅管理员可见】lconai B1组1x；Seedance 2.0标准档4K超清；按秒计费；高价模型注意验收成本。',
    cfg: { resolution_options: ['4k'], default_resolution: '4k' },
  },
  {
    id: 'lconai-grok-imagine-video-15', name: 'Grok Imagine Video 1.5 · 图生视频画音一体（中转lconai）',
    model_name: 'grok-imagine-video-1.5-preview', cost_price: 1.0, price_per_use: 1.1,
    admin_notes: '【内部渠道备注｜仅管理员可见】lconai B1组1x；xAI Aurora纯图生视频（必须带图），自动生成匹配音效人声BGM；按次计费。',
    cfg: {
      billing_unit: 'per_use', requires_image: true, required_reference_images: 1,
      max_reference_images: 1, duration_options: [5, 10], max_duration: 10,
      resolution_options: ['720p'], default_resolution: '720p',
    },
  },
];

for (const m of models) {
  const body = {
    id: m.id, name: m.name, model_name: m.model_name,
    api_endpoint: base.api_endpoint, api_key: base.api_key,
    protocol_type: base.protocol_type, provider: base.protocol_type,
    cost_price: m.cost_price, price_per_use: m.price_per_use,
    duration_seconds: 5, max_duration: 15, supports_image_input: true,
    admin_notes: m.admin_notes,
    api_protocol_config: cfg(m.cfg || {}),
  };
  const r = await fetch(`${ORIGIN}/api/admin/video-models`, { method: 'POST', headers, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  console.log(r.status, m.id, d.model ? `active=${d.model.is_active} hidden=${d.model.is_hidden} gate=${(d.model.api_protocol_config||{}).__model_activation_gate?.state || '-'}` : JSON.stringify(d).slice(0, 150));
}
