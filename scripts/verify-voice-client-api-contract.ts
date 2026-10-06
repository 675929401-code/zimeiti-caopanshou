import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function includesAll(source: string, snippets: string[], label: string) {
  for (const snippet of snippets) {
    assert(source.includes(snippet), `${label} 缺少契约片段：${snippet}`);
  }
}

const clonePage = read('src/app/voice-studio/clone/page.tsx');
const designPage = read('src/app/voice-studio/design/page.tsx');
const imitatePage = read('src/app/voice-studio/imitate/page.tsx');
const voicesPage = read('src/app/voice-studio/voices/page.tsx');
const workspacePage = read('src/app/voice-studio/workspace/page.tsx');
const favoritesHook = read('src/hooks/use-voice-favorites.ts');
const selector = read('src/components/vs/ReferenceAudioSelector.tsx');
const referenceClient = read('src/lib/vs/reference-audio-extraction.ts');
const statusRoute = read('src/app/api/voice/status/route.ts');
const cloneRoute = read('src/app/api/voice/clone/route.ts');
const designRoute = read('src/app/api/voice/design/route.ts');
const uploadRoute = read('src/app/api/voice/upload/route.ts');
const extractRoute = read('src/app/api/voice/link-clone/extract-audio/route.ts');
const extractor = read('src/lib/vs/link-extractor.ts');
const volcanoAdapter = read('src/lib/vs/volcengine.ts');
const trainingStatus = read('src/lib/voice-training-status.ts');

for (const [label, source] of [['复刻页', clonePage], ['设计页', designPage]] as const) {
  includesAll(source, ["redirect('/voice-studio/imitate')"], `${label} 兼容入口`);
}

includesAll(imitatePage, [
  'if (ref.assetId) return { assetId: ref.assetId }',
  "throw new Error('参考音频身份已过期，请重新选择已保存音频')",
  "'Idempotency-Key': attempt.clientRequestId",
  'Authorization:',
  '/api/voice/generation-status?',
  'clearBrowserClientAttempt',
], '音色模仿页');
assert(!imitatePage.includes('String.fromCharCode(...new Uint8Array'), '音色模仿仍可能因大文件展开数组而栈溢出');
assert(!imitatePage.includes('readFileBase64'), '音色模仿仍会把参考音频重发为 base64');

includesAll(referenceClient, [
  "fetch('/api/extract'",
  "'Idempotency-Key': attempt.clientRequestId",
  "extraction_mode: 'video'",
  'isActiveTemporaryExtractVideo(candidate)',
  'temporaryVideoUrl: video.temporary_url',
  "fetch('/api/voice/link-clone/extract-audio'",
  'assetId: String(voice.id)',
], '两阶段参考音频提取');
assert(!referenceClient.includes('audio_url'), '参考音频客户端仍读取供应商音频 URL');
assert(!referenceClient.includes('download_url'), '参考音频客户端仍读取供应商下载 URL');

includesAll(selector, [
  'extractReferenceAudioFromShareLink',
  'assetId: pendingAudio.voice.id',
  "fetch('/api/voice/upload', {",
  "method: 'PUT'",
  'JSON.stringify({ id: renamingFile, name: renameValue.trim() })',
  'JSON.stringify({ id: audio.id })',
], '参考音频选择器');
assert(!selector.includes('/api/voice/clone/extract-audio'), '参考音频选择器仍调用不存在的旧提取路由');

includesAll(statusRoute, [
  'withAuth, type AuthUser',
  'return withAuth(req, async (user: AuthUser) => {',
  'loadOwnedVoiceTrainingJob(db, user.id, jobKey, operation)',
  'getVoiceStatus(speakerId)',
  'normalizeVoiceTrainingStatus(result.status)',
], '训练状态 API');
assert(!statusRoute.includes('body.speakerId'), '训练状态 API 仍信任客户端 speakerId');

includesAll(cloneRoute, [
  'cloneVoice, getActiveApiKey',
  "if (engine === 'volcano')",
  'await cloneVoice({',
  'normalizeVoiceTrainingStatus(result.status)',
  'providerStatus: result.status',
  'providerResult = await routeClone(',
  'finalizeVoiceTrainingReady',
  'reconciliation_required',
  'const providerConfirmedFailed = Boolean(providerSpeakerId)',
  'if (!providerResult.success || !providerData || !providerSpeakerId)',
  "terminal: true, released: true",
], '声音复刻 API 的 V3 与兼容适配');
assert(!cloneRoute.includes('message: `声音克隆失败: ${reason}`'), '声音复刻 API 不应向客户端透传供应商异常');
const ambiguousProviderBlock = cloneRoute.slice(
  cloneRoute.indexOf('if (!providerResult.success || !providerData || !providerSpeakerId)'),
  cloneRoute.indexOf('const resultPayload = {'),
);
assert(!ambiguousProviderBlock.includes('releaseVoiceTrainingTerminal'), '供应商结果不确定时不得释放授权或退款');

includesAll(designRoute, [
  'designVoice, getActiveApiKey',
  "engine !== 'volcano'",
  'normalizeVoiceTrainingStatus(result.status)',
  'providerStatus:',
  'demoAudioUrl:',
  'finalizeVoiceTrainingReady',
  'reconciliation_required',
  "terminal: true, released: true",
], '声音设计 API 的 V3 适配');
assert(!designRoute.includes('message: `声音设计失败: ${reason}`'), '声音设计 API 不应向客户端透传供应商异常');

includesAll(volcanoAdapter, [
  "throw new Error('火山引擎未配置 API Key，未调用上游')",
  'normalizeSpeakerStatus(record.speaker_status)',
  "throw new Error('火山声音复刻响应缺少有效数据')",
  "throw new Error('火山声音设计响应缺少有效数据')",
  "throw new Error('火山音色状态响应缺少有效数据')",
  "speakerId.startsWith('D_')",
  '错误码校验必须位于 JSON 解析 catch 之外',
], '火山 V3 协议适配器');

includesAll(trainingStatus, [
  'normalizeVoiceTrainingStatus',
  "value === 2 || value === 4",
  "return 'ready'",
  'isVoiceTrainingFailed',
], '训练状态公共 DTO');

includesAll(uploadRoute, [
  'export async function PUT',
  'renameOwnedCustomVoice(user.id, id, name)',
  'export async function DELETE',
  'registerCustomVoiceAsset',
], '参考音频存储 API');
assert(!uploadRoute.includes('detail: String(error)'), '参考音频存储 API 不应向客户端泄露服务端异常细节');

includesAll(extractRoute, [
  "export const runtime = 'nodejs';",
  'resolveOwnedTemporaryVideo(body.temporaryVideoUrl, user.id)',
  'verifyExtractTemporaryVideoSignature',
  'extractAudioFromLocalVideo(videoPath, duration',
  'registerCustomVoiceAsset',
  'audioAssetId: voice.id',
  "audioFormat: 'wav'",
], '链接音频提取 API');
assert(!extractRoute.includes('audioBase64'), '链接音频提取 API 仍返回大体积 base64 JSON');

includesAll(extractor, [
  "import { spawn } from 'node:child_process';",
  "import { resolveFfmpegExecutable } from '@/lib/video-postprocess';",
  'const binary = resolveFfmpegExecutable();',
  'spawn(binary, args, { windowsHide: true })',
  'readWavDurationSeconds(wav)',
  "await rm(tempDir, { recursive: true, force: true })",
], '链接音频提取器');
assert(!extractor.includes("import { safeFetch }"), '链接音频提取器仍可下载任意远程地址');
assert(!extractor.includes('api.iyuns.com'), '链接音频提取器仍依赖不受控第三方转码站');
assert(!extractor.includes("import { exec }"), '链接音频提取器仍使用可拼接 shell 命令');

assert(voicesPage.includes('useVoiceFavorites(userId,token)'), '音色库未使用按账号隔离的收藏组件');
assert(workspacePage.includes('useVoiceFavorites('), '工作台未使用共享收藏组件');
assert(!voicesPage.includes("localStorage.getItem('voice_favorites')"), '音色库仍读取旧收藏键');
includesAll(favoritesHook, ['/api/voice/favorites', 'Authorization'], '云端收藏鉴权');
assert(!voicesPage.includes('window.open(`/workspace'), '音色库仍跳转到错误的根工作台路由');

assert(workspacePage.includes('text.length > 5000'), '长文本客户端限制未与后端 5000 字符契约对齐');
assert(!workspacePage.includes('text.length > 50000'), '长文本客户端仍允许后端必拒绝的 50000 字符');
assert(!workspacePage.includes('SSE 流式合成'), '工作台仍展示未接入的 SSE 开关');

console.log('[verify-voice-client-api-contract] PASS');
console.log('upstreamCalls=0 paidRequests=0 databaseMutations=0');
