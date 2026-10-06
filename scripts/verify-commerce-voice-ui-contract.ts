import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=(path:string)=>readFileSync(path,'utf8');
const catalog=read('src/commerce/components/commerce-agent/catalog.ts');
const workspace=read('src/commerce/components/commerce-agent/workspace.tsx');
const studio=read('src/commerce/components/commerce-agent/voice-synthesis-studio.tsx');
const css=read('src/commerce/components/commerce-agent/voice-synthesis.css');
const route=read('src/app/commerce/[...view]/page.tsx');
const apiRoute=read('src/app/api/commerce/voice-synthesis/route.ts');

assert.match(catalog,/['"]图片精修['"],\s*['"]数字人视频['"],\s*['"]爆款视频二创['"],\s*['"]语音合成['"]/u,'voice synthesis must be appended without moving existing tool indices 0-8');
assert.match(workspace,/const TOOL_ICONS = \[[^\]]*UserRound, Play, Mic2\]/u,'voice icon must be appended at tool index 9');
assert.match(workspace,/9:['"]\/toolbox\/voice-synthesis['"]/u,'tool index 9 must navigate to voice synthesis');
assert.match(route,/toolbox\/voice-synthesis/u,'Commerce catch-all must allow the exact voice route');
assert.match(workspace,/nextVoice=url\.pathname===['"]\/toolbox\/voice-synthesis['"]/u,'workspace router must distinguish the voice studio');
assert.match(workspace,/VoiceSynthesisStudio/u,'workspace must render the functioning voice studio');

assert.match(studio,/\/api\/commerce\/voice-synthesis\?action=catalog/u,'UI must read the server voice catalog');
assert.match(studio,/\/api\/commerce\/voice-synthesis['"],\{action:['"]quote['"]/u,'UI must request a frozen quote');
assert.match(studio,/action:['"]confirm['"],quoteId:quote\.id,clientRequestId:confirmRequest\.current\.clientRequestId/u,'confirm must send quote id and stable client request id');
assert.match(studio,/confirmRequest\.current=\{quoteId:result\.quote\.id,clientRequestId:crypto\.randomUUID\(\)\}/u,'client request id must be allocated once per quote');
assert.match(studio,/window\.confirm\(`/u,'cash submission must require an explicit user confirmation');
assert.match(studio,/主站现金钱包支付 \$\{money\(quote\.payableTotal\)\}/u,'confirmation must state the exact cash amount');
assert.match(studio,/quote\.modelId/u,'quote UI must show the frozen public model id');
assert.match(studio,/quote\.providerModelId/u,'quote UI must show the frozen provider model id');
assert.match(studio,/dateText\(quote\.expiresAt\)/u,'quote UI must show expiry');
assert.match(studio,/setInterval\(\(\)=>void loadJobs\(true\),4000\)/u,'durable jobs must be polled read-only');
assert.match(studio,/audio controls preload=['"]metadata['"]/u,'completed assets must be playable');
assert.match(studio,/download=1/u,'completed assets must be downloadable');
assert.match(studio,/submission_unknown[^]*需要人工对账/u,'unknown submission must be visibly routed to manual reconciliation');
assert.match(studio,/系统不会自动重发，也不会自动退款/u,'unknown submission must promise no automatic resubmission or refund');
assert.doesNotMatch(studio,/submission_unknown[^]{0,500}action:['"]confirm['"]/u,'unknown-state rendering must never call confirm again');
assert.match(studio,/resolveUnknown\(['"]retry-save['"]\)/u,'unknown submission must expose an asset-only reconciliation action');
assert.match(studio,/resolveUnknown\(['"]request-reconciliation['"]\)/u,'unknown submission must expose a manual reconciliation request');
assert.doesNotMatch(studio,/refund-unknown/u,'ordinary Commerce UI must not expose evidence-free unknown refunds');
assert.match(studio,/action,id:selectedJob\.id/u,'unknown resolution must target the existing job without a new client request id');
assert.match(studio,/const inProgress=new Set<VoiceStatus>\(\[['"]queued['"],['"]running['"],['"]saving['"]\]\)/u,'unknown and failed-charge submissions must remain outside automatic polling');
assert.match(studio,/generationReady/u,'catalog must keep a separate real-acceptance generation gate');
assert.match(studio,/disabled=\{!!busy\|\|!selectedVoice\?\.generationReady\}/u,'paid confirmation must remain disabled until acceptance evidence is published');
assert.match(studio,/resolvePendingCharge\(['"]retry-charge['"]\)/u,'failed wallet charge must require a new explicit confirmation');
assert.match(studio,/resolvePendingCharge\(['"]cancel-pending-charge['"]\)/u,'an uncharged pending task must be cancellable');

assert.match(apiRoute,/if\(action===['"]catalog['"]\)/u,'API must expose catalog');
assert.match(apiRoute,/body\.action===['"]quote['"]/u,'API must expose quote');
assert.match(apiRoute,/body\.action===['"]confirm['"]/u,'API must expose confirm');
assert.match(apiRoute,/body\.action===['"]retry-charge['"]/u,'API must expose explicit idempotent charge retry');
assert.match(apiRoute,/body\.action===['"]cancel-pending-charge['"]/u,'API must expose uncharged cancellation');
assert.match(apiRoute,/body\.action===['"]retry-save['"]/u,'API must expose asset-only recovery');
assert.match(apiRoute,/body\.action===['"]request-reconciliation['"]/u,'API must expose manual reconciliation request');
assert.match(apiRoute,/url\.searchParams\.get\(['"]id['"]\)/u,'API must expose get by id');
assert.match(apiRoute,/voiceJobs\(user\.id\)/u,'API must expose owned history');
assert.match(css,/@media\(max-width:620px\)/u,'voice studio must include a narrow mobile layout');

console.log(JSON.stringify({
 passed:true,
 checks:40,
 route:'/commerce/toolbox/voice-synthesis',
 boundaries:{quoteBeforeConfirm:true,explicitCashConfirmation:true,stableClientRequestId:true,acceptanceEvidenceRequired:true,pendingChargeManualOnly:true,submissionUnknownManualOnly:true},
 providerCalls:0,
 walletWrites:0,
 browserWrites:0,
}));
