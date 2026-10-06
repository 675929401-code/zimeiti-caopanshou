import assert from 'node:assert/strict';
import { submitVolcDigitalHuman, pollVolcDigitalHuman, OMNI_HUMAN_V15 } from '../src/lib/volcengine-digital-human';
import { HUMAN_PRESETS } from '../src/features/digital-human/presets';
import { humanDurationCapabilities, planHumanDuration } from '../src/features/digital-human/duration-policy';
import { videoProviderRequestReceipt } from '../src/lib/video-provider-request-audit';
import type { VideoModelConfig } from '../src/lib/video-adapter';

async function main() {
  const original = globalThis.fetch;
  const config = (index: number): VideoModelConfig => ({ id:'fixture',provider:'cv',name:'fixture',model_name:HUMAN_PRESETS[index].model,protocol_type:HUMAN_PRESETS[index].protocol,api_endpoint:HUMAN_PRESETS[index].endpoint,api_key:JSON.stringify({accessKeyId:'fixture-only-ak',secretAccessKey:'fixture-only-sk'}),price_per_use:1,duration_seconds:4,supports_image_input:index===3,api_protocol_config:JSON.parse(JSON.stringify(HUMAN_PRESETS[index].config)) });
  let response: unknown = {Result:{code:10000,data:{task_id:'original-upstream-task'}}};
  let submitted: Record<string, any> = {}; let target = new URL('https://example.test');
  globalThis.fetch = async (url, init) => { target = new URL(String(url)); submitted=JSON.parse(String(init?.body)); return Response.json(response); };
  try {
    const retalk = await submitVolcDigitalHuman(config(2), {prompt:'test',sourceVideoUrl:'https://example.test/person.mp4',audioUrl:'https://example.test/audio.wav'});
    assert.equal(retalk.taskId,'original-upstream-task');
    response={Result:{code:10000,data:{status:'done',resp_data:JSON.stringify({code:0,url:'https://example.test/result.mp4',progress:100})}}};
    assert.equal((await pollVolcDigitalHuman(config(2),retalk.taskId)).status,'success');
    response={ResponseMetadata:{}};
    await assert.rejects(submitVolcDigitalHuman(config(2),{prompt:'test',sourceVideoUrl:'https://example.test/person.mp4',audioUrl:'https://example.test/audio.wav'}),/暂无法确认/);
    response={code:10000,data:{task_id:'omni-original'}};
    for (const resolution of ['720p','1080p']) {
      const result=await submitVolcDigitalHuman(config(3),{prompt:'自然讲话',imageUrl:'https://example.test/image.jpg',audioUrl:'https://example.test/audio.wav',resolution});
      assert.equal(result.taskId,'omni-original');
      assert.equal(target.searchParams.get('Action'),'CVSubmitTask');
      assert.equal(target.searchParams.get('Version'),'2022-08-31');
      assert.equal(submitted.req_key,OMNI_HUMAN_V15);
      assert.equal(submitted.output_resolution,parseInt(resolution));
      assert.equal(submitted.pe_fast_mode,resolution==='720p');
      assert.equal(videoProviderRequestReceipt(target,{method:'POST',body:JSON.stringify(submitted)})?.submittedModel,OMNI_HUMAN_V15);
    }
    response={code:10000,data:{status:'done',video_url:'https://example.test/omni.mp4'}};
    assert.equal((await pollVolcDigitalHuman(config(3),'omni-original')).status,'success');
    response={code:50215,message:'Input invalid for this service.'};
    assert.equal((await pollVolcDigitalHuman(config(3),'omni-original')).status,'failed');
    response={code:50400,message:'Access denied'};
    assert.equal((await pollVolcDigitalHuman(config(3),'omni-original')).status,'processing');
    const caps=humanDurationCapabilities(config(3) as unknown as Record<string,unknown>);
    for(const seconds of [30,40,59.99]) assert.equal(planHumanDuration(caps,'photo',0,seconds).error,'');
    for(const seconds of [60,61,90]) assert.equal(planHumanDuration(caps,'photo',0,seconds).code,'DIGITAL_HUMAN_INPUT_DURATION');
    console.log('PASS: Result envelope, unknown receipt retention, Omni protocol/resolution, terminal errors, audio <60s');
  } finally { globalThis.fetch=original; }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
