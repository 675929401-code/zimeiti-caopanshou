// lconai图片模型接入：admin创建（pending ID隔离）→ 受控canary → 发布。
// 协议：/v1/images/generations (dalle式，1k/2k/4k档+比例映射)，2026-09-11 lconai.apifox.cn核验。
const ORIGIN = 'http://127.0.0.1:5000';
const LCONAI_KEY = process.argv[2];
if (!LCONAI_KEY || !LCONAI_KEY.startsWith('sk-')) throw new Error('缺少lconai密钥参数');

const login = await fetch(`${ORIGIN}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: '18685178259', password: 'Admin@2026abc' }),
});
const token = (await login.json()).token;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (path, body) => {
  const r = await fetch(ORIGIN + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(300000) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const MODELS = [
  { name: 'Nano Banana Pro · 高质量档（中转lconai）', model_name: 'nano-banana-pro', cost_price: 0.24, selling_price: 0.264, supports_image_input: true,
    note: 'lconai Gemini-image-G1组0.8x后¥0.24/次；Nano Banana Pro高质量档；按次计费' },
  { name: 'Gemini 3.1 Flash Image · 4K（中转lconai）', model_name: 'gemini-3.1-flash-image-4k', cost_price: 0.16, selling_price: 0.176, supports_image_input: true,
    note: 'lconai Gemini-image-G1组0.8x后¥0.16/次；4K分辨率SKU；按次计费' },
  { name: 'Grok Imagine Image Quality（中转lconai）', model_name: 'grok-imagine-image-quality', cost_price: 0.08, selling_price: 0.088, supports_image_input: false,
    note: 'lconai B1组1x ¥0.08/次；xAI Aurora高质量文生图；按次计费' },
];

for (const m of MODELS) {
  // 1. 创建（隔离pending）
  const create = await api('/api/admin/cover-models', {
    name: m.name, model_name: m.model_name, provider: 'lconai',
    api_endpoint: 'https://n.lconai.com', api_key: LCONAI_KEY,
    cost_price: m.cost_price, selling_price: m.selling_price,
    supports_image_input: m.supports_image_input,
  });
  if (create.status !== 200) { console.log('创建失败', m.model_name, create.status, JSON.stringify(create.data).slice(0, 150)); continue; }
  const modelId = create.data.id || create.data.model?.id;
  console.log('已创建', m.model_name, '→', modelId);

  // 2. 验证上下文
  const ctx = await api(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(modelId)}`);
  if (ctx.status !== 200) { console.log('  上下文失败', JSON.stringify(ctx.data).slice(0, 150)); continue; }
  const key = ctx.data.validationKey;
  if (!key) { console.log('  busy或无key', JSON.stringify(ctx.data).slice(0, 150)); continue; }
  const proof = { validationKey: key, configurationHash: ctx.data.configurationHash, epoch: ctx.data.epoch, clientIdempotencyKey: key, clientTraceId: key };
  console.log('  上下文OK epoch=' + ctx.data.epoch);

  // 3. 受控canary（同步生图）
  const gen = await api('/api/image/generate', {
    mode: 'local', modelId, prompt: 'a clean product photo of a gray hoodie on pure white background, studio lighting',
    aspectRatio: '1:1', resolution: '1K', style: '', coverText: '',
    clientIdempotencyKey: key, clientTraceId: key,
    adminValidation: { confirmation: ctx.data.confirmation || 'RUN_SINGLE_REAL_IMAGE_VALIDATION', ...proof },
  });
  const recId = gen.data?.traceId || gen.data?.recordId || gen.data?.record_id || gen.data?.imageRecordId;
  console.log('  canary', gen.status, 'traceId=' + (recId || '-'), 'state=' + (gen.data?.status || gen.data?.state || '-'), (gen.data?.error || '').slice(0, 80));
  if (gen.status >= 400 || !recId) continue;

  // 同步路由：completed 直接可发布；否则等状态
  let ready = gen.data?.status === 'completed';
  for (let i = 0; !ready && i < 30; i += 1) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await api(`/api/image/status?recordId=${encodeURIComponent(recId)}`);
    const state = st.data?.state || st.data?.status;
    if (state === 'completed' || state === 'delivered') { ready = true; break; }
    if (state === 'failed') break;
  }
  console.log('  生成状态:', ready ? '完成' : '未就绪');
  if (!ready) continue;

  // 4. 发布
  const pub = await api('/api/admin/cover-models/validation/publish', {
    modelId, imageRecordId: recId, proof, confirmation: 'PUBLISH_VALIDATED_IMAGE_MODEL',
  });
  console.log('  发布:', pub.status, JSON.stringify(pub.data).slice(0, 150));
}
