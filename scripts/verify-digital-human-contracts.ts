import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { humanDurationCapabilities, planHumanDuration } from '../src/features/digital-human/duration-policy';
import { humanBillingSeconds } from '../src/features/digital-human/client-state';
import { submitVideoTask, pollVideoTask, type VideoModelConfig } from '../src/lib/video-adapter';
import { humanQuote, saveHumanJob, readHumanJobs, type HumanJob } from '../src/features/digital-human/client-state';
import { getVideoDurationCapabilities, resolveVideoCharge, coerceVideoTargetDuration } from '../src/lib/video-model-capabilities';
import { isCurrentDigitalHumanTask } from '../src/lib/digital-human-task';
import { getVideoInputContract } from '../src/lib/video-input-contract';
import { HUMAN_PRESETS } from '../src/features/digital-human/presets';
import { signVisualRequest } from '../src/lib/volcengine-digital-human';
import { isDigitalHumanWorkspaceModel } from '../src/lib/video-model-surface';

async function main() {
 const catalogRoute = readFileSync('src/app/api/video/models/route.ts', 'utf8');
 assert.match(
  catalogRoute,
  /requestedSurface === ["']digital-human["']\) return isDigitalHuman;/u,
  'legacy lip-sync/talking-head rows must remain discoverable on the digital-human surface',
 );
 assert.equal(isDigitalHumanWorkspaceModel({ protocol_type:'dashscope_video_retalk',name:'legacy source video row' }),true);
 assert.equal(isDigitalHumanWorkspaceModel({ protocol_type:'standard',name:'普通文生视频' }),false);
 assert.match(readFileSync('src/app/api/digital-human/generate/route.ts','utf8'),/!isDigitalHumanWorkspaceModel\(model\)/u);
 assert.match(readFileSync('src/app/api/video/generate/route.ts','utf8'),/digitalHumanModel = isDigitalHumanWorkspaceModel\(selectedModel\)/u);
 assert.equal(isCurrentDigitalHumanTask({ task_label:'digital-human:photo', client_request_id:'digital-new' }),true);
 assert.equal(isCurrentDigitalHumanTask({ task_label:'digital-human:legacy',client_request_id:'old' }),false);
 assert.equal(isCurrentDigitalHumanTask({ task_label:'digital-human:photo',client_request_id:'old' }),false);
 assert.equal(isCurrentDigitalHumanTask({ task_label:'digital-human:photo',client_request_id:'vav_'+ 'a'.repeat(64) }),true);
 assert.equal(isCurrentDigitalHumanTask({ task_label:'digital-human:video',client_request_id:'vav_bad' }),false);
 assert.equal(isCurrentDigitalHumanTask({ task_label:'digital-human:legacy',client_request_id:'vav_'+ 'a'.repeat(64) }),false);
 const store = new Map<string, string>();
 const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string,v: string) => { store.set(k,v); }, key: (i: number) => [...store.keys()][i] || null, get length() { return store.size; } } as Storage;
 const job: HumanJob = { requestId: 'digital-original', taskId: '', businessId: '', modelId: 'selected-model', modelName: 'Selected model', mode: 'photo', status: 'submitting', createdAt: new Date().toISOString(), resolution: '480p', duration: 4.1, price: 2.05, error: '' };
 saveHumanJob(storage, 'owner-a', job);
 assert.equal(readHumanJobs(storage, 'owner-b').length,0);
 assert.equal(readHumanJobs(storage, 'owner-a')[0].status,'unknown');
 saveHumanJob(storage, 'owner-a',{ ...job, status:'completed' });
 saveHumanJob(storage, 'owner-a',job);
 assert.equal(readHumanJobs(storage,'owner-a').length,0, 'settled requests cannot be resurrected by a late tab');
 assert.throws(() => saveHumanJob({ ...storage, setItem() { throw new Error('storage blocked'); } },'owner-a',{ ...job,requestId:'digital-blocked' }), /storage blocked/);
 for (const preset of HUMAN_PRESETS.slice(0,2)) {
   const duration=4.13;
   const caps={ ...preset.config, billingUnit:'output_second', resolutionPrices:[preset.config.default_resolution + '=' + preset.price], defaultResolution:preset.config.default_resolution, resolutionOptions:[...preset.config.resolution_options], minDuration:preset.config.min_duration,maxDuration:preset.config.max_duration,durationMode:'range',durationStep:0.1 };
   const model={ publicPrice:preset.price,price_per_use:preset.price,api_protocol_config:preset.config,capabilities:caps };
   const target=coerceVideoTargetDuration(model,Math.ceil(duration*10)/10);
   assert.equal(humanQuote(model,preset.config.default_resolution,duration),Math.round(resolveVideoCharge(model,preset.config.default_resolution,target).publicPrice * 100) / 100, 'customer quote is rounded to the same cents as settlement');
 }
 const publicH3 = { publicPrice:0.01,capabilities:{durationMode:'discrete',minDuration:1,maxDuration:15,defaultDuration:5,nativeDurations:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],durationStep:1,billingUnit:'output_second',resolutionPrices:['768p=0.01']} };
 assert.equal(humanQuote(publicH3,'768p',4),0.04,'public DTO uses its real duration capabilities');
 assert.equal(getVideoInputContract({supports_image_input:false,api_protocol_config:HUMAN_PRESETS[1].config}).showReferenceImages,false,'video+audio models do not render a photo control');
 const retalkCaps = humanDurationCapabilities({ protocol_type:'dashscope_video_retalk',api_protocol_config:HUMAN_PRESETS[1].config });
 for (const seconds of [29.9,30,30.1,40,59.9,60,60.1,61,90,119.9]) assert.equal(planHumanDuration(retalkCaps,'video',seconds,seconds).seconds,seconds);
 for (const seconds of [2,120,120.1,Infinity,NaN]) {
  assert.equal(planHumanDuration(retalkCaps,'video',seconds,4).code,'DIGITAL_HUMAN_INPUT_DURATION');
  assert.equal(planHumanDuration(retalkCaps,'video',4,seconds).code,'DIGITAL_HUMAN_INPUT_DURATION');
 }
 assert.equal(planHumanDuration(retalkCaps,'video',30,61).code,'DIGITAL_HUMAN_DURATION_CHOICE');
 assert.equal(planHumanDuration(retalkCaps,'video',30,61,'preserve_audio').seconds,61);
 assert.equal(planHumanDuration(retalkCaps,'video',30,61,'preserve_audio').videoExtension,true);
 assert.equal(planHumanDuration(retalkCaps,'video',30,61,'trim_audio').lostAudioSeconds,31);
 assert.equal(planHumanDuration(retalkCaps,'video',61,30).seconds,30);
 assert.equal(planHumanDuration({...retalkCaps,supportsVideoExtension:false},'video',30,61,'preserve_audio').code,'DIGITAL_HUMAN_EXTENSION_UNSUPPORTED');
 assert.equal(humanBillingSeconds(publicH3,4.2),5,'H3 must not cut off a fractional audio tail');
 assert.equal(humanBillingSeconds(publicH3,15.1),0,'oversize input must not get a capped quote');
 const volcCaps = humanDurationCapabilities({ protocol_type:'volcengine_digital_human',api_protocol_config:HUMAN_PRESETS[2].config });
 assert.equal(getVideoDurationCapabilities({api_protocol_config:HUMAN_PRESETS[2].config}).minDuration,1.1);
 assert.equal(getVideoDurationCapabilities({durationMode:'range',minDuration:1.1,maxDuration:239.9}).maxDuration,239.9);
 assert.equal(planHumanDuration(volcCaps,'video',350,240).seconds,240);
 assert.equal(planHumanDuration(volcCaps,'video',3,1.01).seconds,1.01);
 assert.equal(planHumanDuration(volcCaps,'video',30,61,'preserve_audio').seconds,61);
 assert.equal(planHumanDuration(volcCaps,'video',30,61,'trim_audio').seconds,30);
 assert.equal(planHumanDuration(volcCaps,'video',30,61).code,'DIGITAL_HUMAN_DURATION_CHOICE');
 for (const [video,audio] of [[2.99,4],[350.01,4],[4,1],[4,240.01]]) assert.equal(planHumanDuration(volcCaps,'video',video,audio,'preserve_audio').code,'DIGITAL_HUMAN_INPUT_DURATION');
 const volcQuote = { publicPrice:0.3, capabilities:{ billingUnit:'output_second', durationMode:'range',minDuration:1.1,maxDuration:240,durationStep:0.1 } };
 for (const [seconds,price] of [[30,9],[40,12],[60,18],[61,18.3],[240,72]]) assert.equal(humanQuote(volcQuote,'720p',seconds),price);
 const original=globalThis.fetch; let dispatch=0;
 const config: VideoModelConfig={id:'retalk-fixture',provider:'dashscope',name:'Retalk',model_name:'videoretalk',api_endpoint:HUMAN_PRESETS[1].endpoint,api_key:'offline-fixture',protocol_type:'dashscope_video_retalk',price_per_use:0.08,duration_seconds:4,supports_image_input:false};
 try {
  globalThis.fetch=async (input,init)=>{dispatch++; assert.equal(String(input),config.api_endpoint);assert.deepEqual(JSON.parse(String(init?.body)),{model:'videoretalk',input:{video_url:'https://example.test/source.mp4',audio_url:'https://example.test/audio.wav'},parameters:{video_extension:false}});return Response.json({output:{task_id:'original-retalk'}});};
  assert.equal((await submitVideoTask(config,{prompt:'',audioUrl:'https://example.test/audio.wav'})).status,'failed');assert.equal(dispatch,0);
  assert.equal((await submitVideoTask(config,{prompt:'',sourceVideoUrl:'https://example.test/source.mp4',audioUrl:'https://example.test/audio.wav'})).taskId,'original-retalk');assert.equal(dispatch,1);
  globalThis.fetch=async (_input,init)=>{assert.equal(JSON.parse(String(init?.body)).parameters.video_extension,true);return Response.json({output:{task_id:'full-audio-retalk'}});};
  assert.equal((await submitVideoTask(config,{prompt:'',sourceVideoUrl:'https://example.test/source.mp4',audioUrl:'https://example.test/audio.wav',videoExtension:true})).taskId,'full-audio-retalk');
  globalThis.fetch=async()=>Response.json({output:{task_status:'UNKNOWN'}});
  assert.equal((await pollVideoTask(config,'original-retalk')).status,'processing');
  globalThis.fetch=async()=>Response.json({code:'InvalidApiKey'},{status:401});
  assert.equal((await pollVideoTask(config,'original-retalk')).status,'processing');
  globalThis.fetch=async()=>Response.json({output:{task_status:'SUCCEEDED',video_url:'https://example.test/result.mp4'}});
  assert.equal((await pollVideoTask(config,'original-retalk')).videoUrl,'https://example.test/result.mp4');
  globalThis.fetch=async()=>Response.json({code:'InvalidParameter',message:'fixture rejected'},{status:400});
  assert.equal((await submitVideoTask(config,{prompt:'',sourceVideoUrl:'https://example.test/source.mp4',audioUrl:'https://example.test/audio.wav'})).status,'failed');
  for (const status of [500,502,503]) {
   globalThis.fetch=async()=>Response.json({code:'GatewayError'},{status});
   const uncertain=await submitVideoTask(config,{prompt:'',sourceVideoUrl:'https://example.test/source.mp4',audioUrl:'https://example.test/audio.wav'});
   assert.equal(uncertain.submissionOutcome,'unknown');assert.equal(uncertain.status,'processing');
  }
  globalThis.fetch=async()=>{throw new TypeError('fixture connection reset after dispatch');};
  assert.equal((await submitVideoTask(config,{prompt:'',sourceVideoUrl:'https://example.test/source.mp4',audioUrl:'https://example.test/audio.wav'})).submissionOutcome,'unknown');
  globalThis.fetch=async()=>Response.json({output:{}});
  assert.equal((await submitVideoTask(config,{prompt:'',sourceVideoUrl:'https://example.test/source.mp4',audioUrl:'https://example.test/audio.wav'})).submissionOutcome,'unknown');
 } finally { globalThis.fetch=original; }
 const volc: VideoModelConfig={...config,id:'volc-fixture',protocol_type:'volcengine_digital_human',api_endpoint:HUMAN_PRESETS[2].endpoint,api_protocol_config:JSON.parse(JSON.stringify(HUMAN_PRESETS[2].config)),api_key:JSON.stringify({accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'})};
 try {
  for (const extended of [false,true]) {
   globalThis.fetch=async (input,init)=>{
    assert.equal(new URL(String(input)).searchParams.get('Action'),'RealmanChangeLipsSubmitTask');
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body,{req_key:'realman_change_lips',url:'https://example.test/source.mp4',pure_audio_url:'https://example.test/audio.wav',align_audio:extended,align_audio_reverse:extended});
    assert.ok(!String(init?.body).includes('fixture-secret'));
    return Response.json({code:10000,data:{task_id:'original-volc'}});
   };
   assert.equal((await submitVideoTask(volc,{prompt:'',sourceVideoUrl:'https://example.test/source.mp4',audioUrl:'https://example.test/audio.wav',videoExtension:extended})).taskId,'original-volc');
  }
  // Official GetResult nests a JSON string in resp_data.
  for (const status of ['done',undefined]) {
   globalThis.fetch=async()=>Response.json({code:10000,data:{status,resp_data:JSON.stringify({code:0,progress:100,url:'https://example.test/result.mp4'})}});
   assert.equal((await pollVideoTask(volc,'original-volc')).videoUrl,'https://example.test/result.mp4');
  }
  globalThis.fetch=async()=>Response.json({code:10000,data:{status:'done',resp_data:'incomplete json'}});
  assert.equal((await pollVideoTask(volc,'original-volc')).status,'processing');
  globalThis.fetch=async()=>Response.json({code:10000,data:{status:'done',resp_data:JSON.stringify({code:5001,msg:'Generation failed'})}});
  assert.equal((await pollVideoTask(volc,'original-volc')).status,'failed');
  globalThis.fetch=async()=>Response.json({code:10000,data:{status:'running',resp_data:JSON.stringify({progress:37})}});
  assert.equal((await pollVideoTask(volc,'original-volc')).progress,37);
  globalThis.fetch=async()=>Response.json({code:50400},{status:401});
  assert.equal((await pollVideoTask(volc,'original-volc')).status,'processing','query failure cannot refund a possibly running task');
  globalThis.fetch=async()=>Response.json({code:50500},{status:500});
  await assert.rejects(submitVideoTask(volc,{prompt:'',sourceVideoUrl:'https://example.test/source.mp4',audioUrl:'https://example.test/audio.wav'}),/暂未确认提交结果/);
 } finally { globalThis.fetch=original; }
 const url=new URL('https://visual.volcengineapi.com/?Version=2024-06-06&Action=RealmanChangeLipsSubmitTask');
 const signed=signVisualRequest(url,'{}',{accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'},new Date('2026-09-03T00:00:00Z'));
 assert.equal(signed['x-date'],'20260903T000000Z');
 assert.equal(signed['x-content-sha256'],'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
 assert.match(signed.authorization,/Credential=fixture-access\/20260903\/cn-north-1\/cv\/request/);
 assert.ok(!JSON.stringify(signed).includes('fixture-secret'));
 assert.notEqual(signVisualRequest(url,'{"changed":true}',{accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'},new Date('2026-09-03T00:00:00Z')).authorization,signed.authorization);
 console.log('Digital human contracts: PASS (ownership, original receipt, settlement, quote, distinct input, submission uncertainty, unknown polling, signing; real network=0, provider calls=0)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
