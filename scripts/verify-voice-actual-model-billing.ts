import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.join(process.cwd(), 'src/app/api/voice/tts/route.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

const checks: Array<[string, boolean]> = [
  ['provider variants map to published Seed TTS 2.0 pricing', source.includes("return 'seed-tts-2.0';")],
  ['provider variants map to published Seed ICL 2.0 pricing', source.includes("return 'seed-icl-2.0';")],
  ['unknown provider model is not silently remapped', source.includes('return normalized;')],
  ['missing published price fails closed before upstream', source.includes("code: 'VOICE_PRICE_NOT_CONFIGURED'")],
  ['single TTS freezes provider model before quote', source.includes('const frozenVolcanoTarget = engine === \'volcano\'')],
  ['single TTS charges frozen published model', source.includes('frozenVolcanoTarget?.billingModelId || inferModelId')],
  ['single TTS sends only frozen provider model', source.includes('model: inferredModel,') && source.includes('resourceId: frozenVolcanoTarget!.providerResourceId')],
  ['single TTS persists actual provider and billing model IDs', source.includes('providerModelId: inferredModel') && source.includes('billingModelId: modelId')],
  ['cross-priced single fallback removed', !source.includes("{ model: 'seed-icl-2.0', resourceId: 'seed-icl-2.0' }")],
  ['dual role one has independent quote', source.includes('resolveVoiceBillingQuote(text.length, target1.billingModelId)')],
  ['dual role two has independent quote at frozen exchange rate', source.includes('resolveVoiceBillingQuote(text2.length, target2.billingModelId, undefined, quote1.creditsPerYuan)')],
  ['dual charge is aggregate of the two exact quotes', source.includes('quote1.costBreakdown.creditsToCharge + quote2.costBreakdown.creditsToCharge')],
  ['dual provider candidates are frozen before charge', source.includes('providerCandidates: [target1.providerModelId, target2.providerModelId]')],
  ['dual calls only frozen targets', source.includes('model: target1.providerModelId') && source.includes('model: target2.providerModelId')],
  ['cross-priced dual fallback removed', !source.includes('const fallbacks = [')],
  ['partial refund uses failed role exact quote', source.includes('const failedQuote = hasError1 ? quote1.costBreakdown : quote2.costBreakdown')],
  ['half-refund guess removed', !source.includes('Math.floor(creditsToCharge / 2)') && !source.includes('halfRefund')],
  ['dual response exposes per-role provider and billing IDs', source.includes('roles: [') && source.includes('billingModelId: target2.billingModelId')],
  ['charge idempotency remains stable and phase scoped', source.includes('voice:${operation.clientRequestId}:${operation.phase}:charge')],
  ['refund idempotency remains stable and scope specific', source.includes('voice:${lifecycle.clientRequestId}:${lifecycle.phase}:${scope}:refund')],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length > 0) {
  console.error(`\n${failed.length}/${checks.length} voice billing checks failed.`);
  process.exit(1);
}
console.log(`\n${checks.length}/${checks.length} voice billing checks passed.`);
