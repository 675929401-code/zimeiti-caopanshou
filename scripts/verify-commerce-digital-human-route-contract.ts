import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {humanDurationCapabilities,planHumanDuration,shouldSegmentHumanVideo} from '../src/features/digital-human/duration-policy';
import {planAliLongDigitalHumanVideo} from '../src/features/digital-human/long-video-segmentation';
import {HUMAN_PRESETS} from '../src/features/digital-human/presets';

const read=(path:string)=>readFileSync(path,'utf8');
const route=read('src/app/commerce/toolbox/digital-human/page.tsx');
const catchAll=read('src/app/commerce/[...view]/page.tsx');
const catalog=read('src/commerce/components/commerce-agent/catalog.ts');
const workspace=read('src/commerce/components/commerce-agent/workspace.tsx');
const hotStudio=read('src/commerce/components/commerce-agent/hot-video-remix-studio.tsx');
const hotStyles=read('src/commerce/components/commerce-agent/hot-video-remix.css');
const page=read('src/app/digital-human/page.tsx');
const generateRoute=read('src/app/api/digital-human/generate/route.ts');

assert.match(route,/export \{default\} from ['"]@\/app\/digital-human\/page['"]/u,'Commerce route must reuse the main digital-human page and its single state machine');
assert.match(catchAll,/toolbox\/hot-video-remix/u,'hot remix must be an allowed Commerce workspace route');
assert.doesNotMatch(catchAll,/toolbox\/digital-human/u,'digital human must remain a real static route rather than a second workspace implementation');
assert.match(catalog,/['"]数字人视频['"],\s*['"]爆款视频二创['"]/u,'new tools must be appended to the existing catalog');
assert.match(workspace,/window\.location\.href\s*=\s*['"]\/commerce\/toolbox\/digital-human['"]/u,'digital human must use a full-page navigation to the shared page');
assert.match(page,/pathname\.startsWith\(['"]\/commerce\/['"]\)\s*\?\s*['"]\/commerce['"]\s*:\s*['"]\/['"]/u,'shared digital-human page must preserve the Commerce return context');
assert.match(workspace,/['"]\/toolbox\/hot-video-remix['"]/u,'hot remix must be wired into the Commerce workspace router');
assert.match(workspace,/HotVideoRemixStudio/u,'hot remix workspace must render a functioning studio rather than a dead link');
assert.match(hotStudio,/AssetPicker/u,'hot remix must use the shared owned-asset picker');
assert.match(hotStudio,/sourceSlot:MaterialSlot=\{[^}]*max:3[^}]*kinds:\[['"]video['"]\]/u,'hot remix must accept at most three source videos');
assert.match(hotStudio,/bgmSlot:MaterialSlot=\{[^}]*max:1[^}]*kinds:\[['"]audio['"]\]/u,'hot remix must expose one optional BGM asset');
assert.match(hotStudio,/action:['"]quote['"]/u,'hot remix must request a frozen quote before execution');
assert.match(hotStudio,/action:['"]confirm['"]/u,'hot remix must confirm by quote id');
assert.match(hotStudio,/\/api\/commerce\/hot-video-remix/u,'hot remix controls must be wired to the durable API');
assert.match(hotStudio,/type=['"]number['"] min=\{2\} max=\{60\}/u,'hot remix must constrain target duration to 2–60 seconds');
for(const ratio of ['9:16','16:9','1:1'])assert.match(hotStudio,new RegExp(`value=["']${ratio}["']`),`hot remix must expose ${ratio}`);
assert.match(hotStudio,/preserveSourceAudio,bgmVolume/u,'hot remix must submit source-audio and BGM-volume choices');
assert.match(hotStudio,/不调用外部模型、不扣主站钱包/u,'zero-fee confirmation must state the real execution boundary');
assert.match(hotStudio,/任务可离开页面后继续，返回时按原记录读回/u,'hot remix must expose durable history semantics');
assert.match(hotStudio,/selectedUrl\?<video/u,'a successful durable result must be previewable');
assert.match(hotStudio,/moveSource\(index,-1\)[\s\S]*moveSource\(index,1\)/u,'source-video ordering controls must be wired');
assert.match(hotStyles,/\.ca-hot-remix\{[^}]*height:100%[^}]*overflow-y:auto/u,'hot remix must own vertical scrolling inside the Commerce shell');

const [wan,retalk,volcLite,omni]=HUMAN_PRESETS;
const caps=(preset:typeof HUMAN_PRESETS[number])=>humanDurationCapabilities({protocol_type:preset.protocol,duration_seconds:preset.config.min_duration,max_duration:preset.config.max_duration,api_protocol_config:preset.config});
const durations=[30,60,70,80] as const;

for(const seconds of durations){
 const retalkPlan=planHumanDuration(caps(retalk),'video',seconds,seconds);
 assert.equal(retalkPlan.error,'',`VideoRetalk ${seconds}s should remain accepted by the current contract`);
 assert.equal(shouldSegmentHumanVideo(caps(retalk),'video',seconds),false,`VideoRetalk ${seconds}s should remain a single native task`);
 const volcPlan=planHumanDuration(caps(volcLite),'video',seconds,seconds);
 assert.equal(volcPlan.error,'',`Volc Lite ${seconds}s should remain native`);
 assert.equal(shouldSegmentHumanVideo(caps(volcLite),'video',seconds),false,'Volc Lite must not enter the Retalk-only segmentation worker');
}
assert.equal(planHumanDuration(caps(omni),'photo',0,30).error,'','OmniHuman 30s is currently accepted');
for(const seconds of [60,70,80])assert.equal(planHumanDuration(caps(omni),'photo',0,seconds).code,'DIGITAL_HUMAN_INPUT_DURATION',`OmniHuman ${seconds}s is currently rejected at its exclusive 60s ceiling`);
for(const seconds of durations)assert.equal(planHumanDuration(caps(wan),'photo',0,seconds).code,'DIGITAL_HUMAN_INPUT_DURATION',`Wan ${seconds}s exceeds the current preset limit`);

const submitBody=page.match(/body:\s*JSON\.stringify\(\{([\s\S]*?durationChoice:\s*effectiveDurationChoice[\s\S]*?)\}\)\s*\}\);/u)?.[1]||'';
assert.ok(submitBody,'digital-human submit body must remain inspectable');
assert.doesNotMatch(submitBody,/boundar(?:y|ies)/iu,'the current client does not submit measured sentence or silence boundaries');
assert.doesNotMatch(submitBody,/quoteId/iu,'the current client does not bind an immutable server quote');
assert.match(generateRoute,/from\(['"]video_models['"]\)\.select\(['"]\*['"]\)/u,'submit currently reloads the live model row and reprices server-side');
assert.doesNotMatch(generateRoute,/body\.quoteId/u,'ordinary digital-human submit currently has no immutable quote binding');
const fallbackPlan=planAliLongDigitalHumanVideo({totalDurationSeconds:230,boundaries:[]});
assert.ok(fallbackPlan.segments.some(segment=>segment.endBoundary==='planned'),'without supplied boundaries the long-video planner uses balanced planned cuts');

console.log(JSON.stringify({
 passed:true,
 checks:54,
 routes:{digitalHuman:'shared-static-page',hotRemix:'commerce-workspace'},
 durationMatrix:{videoRetalk:{30:'native',60:'native',70:'native',80:'native'},volcLite:{30:'native',60:'native',70:'native',80:'native'},omniHuman:{30:'accepted',60:'rejected',70:'rejected',80:'rejected'},wan:{30:'rejected',60:'rejected',70:'rejected',80:'rejected'}},
 knownLimitations:{measuredSentenceBoundaries:false,immutablePreSubmitQuote:false},
 providerCalls:0,
 walletWrites:0,
}));
