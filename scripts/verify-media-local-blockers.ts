import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

async function source(path: string) {
  return readFile(resolve(root, path), "utf8");
}

function section(text: string, start: string, end: string) {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return text.slice(startIndex, endIndex);
}

function assertBefore(text: string, first: string, second: string, message: string) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing first marker: ${first}`);
  assert.notEqual(secondIndex, -1, `missing second marker: ${second}`);
  assert.ok(firstIndex < secondIndex, message);
}

async function main() {
  const [
    imageStore,
    imageStatus,
    imageWorkbench,
    imagePersist,
    imageGenerate,
    voiceStatus,
    voiceTts,
    imitatePage,
    mediaHistory,
    mediaContent,
    billing,
  ] = await Promise.all([
    source("src/lib/image-exactly-once.ts"),
    source("src/app/api/image/status/route.ts"),
    source("src/components/image-workbench.tsx"),
    source("src/app/api/image-workbench/persist/route.ts"),
    source("src/app/api/image/generate/route.ts"),
    source("src/app/api/voice/status/route.ts"),
    source("src/app/api/voice/tts/route.ts"),
    source("src/app/voice-studio/imitate/page.tsx"),
    source("src/app/api/media-history/route.ts"),
    source("src/app/api/media-history/content/route.ts"),
    source("src/lib/billing.ts"),
  ]);

  // 图片：状态刷新只读本地幂等记录，未知态绝不可盲目重提。
  assert.match(imageStore, /get\(input:[\s\S]+clientIdempotencyKey[\s\S]+clientTraceId/, "exactly-once store must expose trace-bound local status lookup");
  assert.match(imageStatus, /export async function GET/);
  assert.match(imageStatus, /state:\s*delivered \? "completed" : "provider_completed_pending_delivery"/);
  assert.match(imageStatus, /record\.deliveryState === "delivered" && Boolean\(record\.deliveryAssetId\)/);
  assert.match(imageStatus, /canResubmit:\s*false/g);
  assert.match(imageStatus, /状态不明，勿重复提交/);
  assert.doesNotMatch(imageStatus, /\bfetch\s*\(/, "image status lookup must perform zero provider/network fetches");
  assert.match(imageWorkbench, /"unknown"/);
  assert.match(imageWorkbench, /"recoverable"/);
  assert.match(imageWorkbench, /\["idle",\s*"failed",\s*"recoverable"\]\.includes\(job\.status\)/);
  assert.match(imageWorkbench, /\/api\/image\/status\?/);
  assert.match(imageWorkbench, /clientTraceId:\s*generationTraceId/);
  assert.match(imageWorkbench, /存在状态不明的请求，已禁止盲目重提；请先刷新状态/);
  assert.match(imageWorkbench, /data\.status !== "completed"[\s\S]+data\.persisted !== true/);
  assert.match(imageWorkbench, /!data\.assetId \|\| !data\.historyRecordId/);

  // 图片交付：跨日重试依然定位同一资产，且资产+历史都成功才返回 completed。
  assert.match(imagePersist, /image-workbench\/by-trace\//);
  assert.match(imagePersist, /requireOwnershipRecord:\s*true/);
  assert.match(imagePersist, /from\("conversation_messages"\)\.upsert/);
  assert.match(imagePersist, /status:\s*"completed"/);
  assert.match(imagePersist, /persisted:\s*true/);
  assert.match(imagePersist, /assetId:\s*history\.assetId/);
  assert.match(imagePersist, /historyRecordId:\s*history\.historyRecordId/);
  assertBefore(imageGenerate, "persistAutodlH3SelfhostImageWithRecovery({", "executeCashDeduction({", "H3 image must persist before charging ordinary users");
  assertBefore(imageGenerate, "executeCashDeduction({", "finalizeImageExactlyOnceDelivery({", "image ownership must only be finalized after a successful charge");
  assert.match(imageGenerate, /assetId:\s*delivery\.assetId/);
  assert.match(imageStore, /db\.rpc\("finalize_image_generation_delivery"/);
  assert.match(imageStore, /!result\?\.deliveryAssetId \|\| result\.deliveryState !== "delivered"/);

  // 语音：缺 key 在任何扣费前 fail closed，响应明确 0 上游/0 扣费。
  const seed = section(voiceTts, "async function handleSeedAudio", "async function handleMixSynthesize");
  const mix = section(voiceTts, "async function handleMixSynthesize", "async function handleDualTTS");
  const dual = section(voiceTts, "async function handleDualTTS", "async function handleTTS");
  const regular = section(voiceTts, "async function handleTTS", "export async function POST");
  for (const [name, handler] of [["seed", seed], ["mix", mix], ["dual", dual], ["regular", regular]] as const) {
    assertBefore(handler, "isVolcanoConfigured()", "deductCredits(user.id", `${name} must check Volcano key before deduction`);
  }
  assert.match(voiceTts, /code:\s*'VOICE_PROVIDER_UNAVAILABLE'/);
  assert.match(voiceTts, /upstreamSubmitted:\s*false/);
  assert.match(voiceTts, /creditsCharged:\s*0/);
  assert.match(mix, /persistGeneratedAudio[\s\S]+addGeneration[\s\S]+terminalStatus:\s*'completed'/);
  assert.match(dual, /persistGeneratedAudio[\s\S]+addGeneration[\s\S]+terminalStatus:\s*'completed'/);
  assert.match(regular, /persistGeneratedAudio[\s\S]+addGeneration[\s\S]+terminalStatus:\s*'completed'/);

  const voiceStatusGet = section(voiceStatus, "export async function GET", "export async function POST");
  assert.match(voiceStatusGet, /upstreamCalls:\s*0/);
  assert.match(voiceStatusGet, /creditsCharged:\s*0/);
  assert.doesNotMatch(voiceStatusGet, /synthesize|generateAudio|routeCloneStatus/, "voice preflight must not call a provider operation");
  assert.match(imitatePage, /\/api\/voice\/status\?provider=volcano/);
  assert.match(imitatePage, /providerStatus !== 'available'/);
  assert.match(imitatePage, /terminalStatus === 'completed'/);
  assert.match(imitatePage, /persisted === true/);
  assert.match(imitatePage, /asset\?\.id/);
  assert.match(imitatePage, /generationId/);

  // 媒体历史：DB completed 不等于可交付；必须有永久对象并通过用户归属校验。
  assert.match(mediaHistory, /storage_url/);
  assert.match(mediaHistory, /hasPersistedResult/);
  assert.match(mediaHistory, /ownedImageAssetMap/);
  assert.match(mediaHistory, /assetId[\s\S]+storageKey[\s\S]+ownedAsset/);
  assert.match(mediaHistory, /结果未完成持久化/);
  assert.match(mediaContent, /from\("user_files"\)/);
  assert.match(mediaContent, /\.eq\("id",\s*reference\.assetId\)/);
  assert.match(mediaContent, /\.eq\("user_id",\s*user\.userId\)/);
  assert.match(mediaContent, /\.eq\("storage_key",\s*reference\.storageKey\)/);
  assert.match(mediaContent, /storageManager\.read/);
  assert.doesNotMatch(mediaContent, /\bfetch\s*\(/, "media history must never re-fetch an expiring/remote gallery URL");

  // 普通用户扣费契约：供应商失败前不扣；同 reference 只允许一条消费流水；语音后链失败调用退款。
  assertBefore(imageGenerate, "if (\n      !imageStorageUri", "executeCashDeduction({", "incomplete image delivery metadata must fail before charging");
  const cashDeduction = section(billing, "export async function deductCash", "export async function topupCash");
  assert.match(cashDeduction, /applyAtomicWalletOperation\(\{[\s\S]*?operationKind: 'cash_charge',[\s\S]*?idempotencyKey: referenceId/u);
  assert.doesNotMatch(cashDeduction, /\.from\(['"]users['"]\)[\s\S]*?\.update\(/u, "cash deduction must not use a non-atomic application-level balance mutation");
  assert.match(seed, /if \(!audioResult\)[\s\S]+refundCredits/);
  assert.match(mix, /historyError[\s\S]+refundCredits/);
  assert.match(dual, /persistError[\s\S]+refundCredits/);
  assert.match(regular, /if \(ttsResult && !ttsResult\.success\)[\s\S]+refundCredits/);

  console.log(JSON.stringify({
    ok: true,
    contracts: {
      imageUnknownNoResubmit: true,
      imageSameKeyRecovery: true,
      voiceMissingKeyUpstreamCalls: 0,
      voiceMissingKeyCreditsCharged: 0,
      deliveryRequiresTerminalAssetHistory: true,
      billingIdempotentAndFailureRefunded: true,
    },
    networkCalls: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
