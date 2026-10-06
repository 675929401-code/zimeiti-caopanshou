import assert from 'node:assert/strict';
import { humanDurationCapabilities, planHumanDuration, shouldSegmentHumanVideo } from '../src/features/digital-human/duration-policy';
import { toPublicModelDto } from '../src/lib/public-model-dto';
const volc = {id:'routing-volc',protocol_type:'volcengine_digital_human',duration_seconds:4,max_duration:240,api_protocol_config:{req_key:'realman_change_lips',duration_mode:'range',min_duration:1,max_duration:240}};
const ali = {id:'routing-ali',protocol_type:'dashscope_video_retalk',duration_seconds:2,max_duration:120,api_protocol_config:{duration_mode:'range',min_duration:2,max_duration:120}};
const fireCaps=humanDurationCapabilities(volc),aliCaps=humanDurationCapabilities(ali);
for(const seconds of [30,60,115,116,120,121,239.99,240]){assert.equal(shouldSegmentHumanVideo(fireCaps,'video',seconds),false,'Volc native duration must never route to Alibaba-only worker');assert.equal(planHumanDuration(fireCaps,'video',4.2,seconds,'preserve_audio').error,'');}
assert.ok(planHumanDuration(fireCaps,'video',4.2,240.01,'preserve_audio').error);
for(const seconds of [116,120,150,240])assert.equal(shouldSegmentHumanVideo(aliCaps,'video',seconds),true);
assert.equal(shouldSegmentHumanVideo(aliCaps,'video',115),false);
assert.equal(shouldSegmentHumanVideo(aliCaps,'photo',150),false);
assert.equal(shouldSegmentHumanVideo(undefined,'video',150),false);
assert.equal(shouldSegmentHumanVideo(aliCaps,'video',NaN),false);
assert.equal(toPublicModelDto('video',volc,0,fireCaps).capabilities.supportsLongVideoSegmentation,false);
assert.equal(toPublicModelDto('video',ali,0,aliCaps).capabilities.supportsLongVideoSegmentation,true);
console.log(JSON.stringify({passed:true,volcNativeSeconds:[30,60,115,116,120,121,239.99,240],retalkSegmentationOnly:true,publicCapabilityPreserved:true,aboveMaximumRejected:true}));
