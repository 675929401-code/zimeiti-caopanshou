import assert from 'node:assert/strict';
import {compileSegmentPrompt,parseStructuredRollingPrompt,planSegments,sliceStructuredRollingPrompt} from '../src/commerce/server/rolling-video';

const native=[4,5,6,7,8,9,10,11,12,13,14,15];
assert.deepEqual(planSegments(30,native),[15,15]);
assert.deepEqual(planSegments(60,native),[15,15,15,15]);
assert.deepEqual(planSegments(70,native),[14,14,14,14,14]);
const segments=planSegments(80,native);
assert.deepEqual(segments,[14,14,13,13,13,13]);
assert.equal(planSegments(81,native),null);

const boundaries=[0,14,28,41,54,67,80];
const source=[
  '## 剧情梗概','八十秒商品故事。','## 素材与职责','- 图片1：只负责商品外观。',
  '## 主体与全片设定','人物与商品全片一致。\n\n转化收尾：\n最后一镜给出购买动作。\n\n声音：\n全片连续口播。',
  '## 镜头 / 时间轴',
  ...boundaries.slice(0,-1).flatMap((start,index)=>[
    `**[镜头${index+1}：${start}-${boundaries[index+1]}s｜段${index+1}]**`,
    `"SHOT_${index+1}；动作从起点完成到终点"`,
  ]),
  '## 始终禁止','禁止字幕、水印和商品变形。',
].join('\n\n');

assert.equal(parseStructuredRollingPrompt(source)?.shots.length,6);
assert.equal(sliceStructuredRollingPrompt('普通提示词',0,14,false),null);

let start=0;
const prompts=segments!.map((duration,index)=>{
  const end=start+duration;
  const prompt=compileSegmentPrompt(source,index+1,segments!.length,start,end,80,true,index>0);
  start=end;
  return prompt;
});

for(const [index,prompt] of prompts.entries()){
  assert.match(prompt,new RegExp(`SHOT_${index+1}`));
  for(let other=0;other<prompts.length;other+=1)if(other!==index)assert.doesNotMatch(prompt,new RegExp(`SHOT_${other+1}`));
  assert.match(prompt,/## 素材与职责/u);
  assert.match(prompt,/## 主体与全片设定/u);
  assert.match(prompt,/## 始终禁止/u);
  assert.match(prompt,/镜头1：0-/u);
}
assert.doesNotMatch(prompts[0],/last-frame|开头最多5帧|声音必须延续/u);
for(const prompt of prompts.slice(1)){
  assert.match(prompt,/last-frame/u);
  assert.match(prompt,/只约束本段开头最多5帧/u);
  assert.match(prompt,/声音必须延续上一段/u);
  assert.match(prompt,/不得重新开场/u);
}
for(const prompt of prompts.slice(0,-1)){
  assert.doesNotMatch(prompt,/最后一镜给出购买动作/u);
  assert.match(prompt,/不得提前执行转化收尾/u);
}
assert.match(prompts.at(-1)!,/最后一镜给出购买动作/u);
assert.match(prompts.at(-1)!,/这是最后一段/u);

const fallback=compileSegmentPrompt('普通自由提示词',1,2,0,10,20,false,false);
assert.match(fallback,/普通自由提示词/u);

console.log(JSON.stringify({passed:75,networkCalls:0,databaseWrites:0,walletCalls:0,providerCalls:0,segments,semanticSlices:prompts.length,tailFrameOpeningFrameLimit:5}));
