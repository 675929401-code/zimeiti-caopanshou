import assert from 'node:assert/strict';
import { buildAgentStoryboardPromptDraftDetail as build, parseAgentStoryboardPromptDraftImport as parse } from '../src/lib/agent-storyboard-prompt-draft';
const fence = (text: string, language = 'text') => `\`\`\`${language}\n${text}\n\`\`\``;
const pair = (number: number, image = '图片字面 **文本** <tag> &', video = '视频镜头动作') => `## 段落 ${number}：原编号保留\n\n### 生图 Prompt\n${fence(image)}\n\n### 图生视频 Prompt\n${fence(video)}`;
const message = (content: string) => ({ id: 'manual-test', role: 'assistant', content });
let positive = 0, negative = 0;
const source = `${pair(12)}\n\n${pair(12, '第二图', '第二视频')}`;
const detail = build(message(source)); assert.ok(detail); const plan = parse(detail); assert.ok(plan); positive++;
assert.equal(plan.intakeVerified, false); assert.equal(plan.promptDraft, true); assert.equal(plan.executionMode, 'ordinary'); assert.equal(plan.phase, 'draft');
assert.deepEqual(plan.segments.map(x => x.sourceIndex), [1, 2]); assert.notEqual(plan.segments[0].segmentId, plan.segments[1].segmentId); assert.match(plan.segments[1].narration, /段落 12/); assert.ok(plan.originalInput.special_notes.endsWith(source)); assert.equal(plan.settings.targetDurationSeconds, 10); assert.equal(plan.settings.aspectRatio, '16:9'); assert.equal(plan.settings.animationStyle, '未指定（请核对原提示词）'); assert.match(plan.legacyDraftWarning || '', /不代表原提示词采用了该导演模式或3D风格/u);
assert.equal(plan.segments[0].imagePrompt, '图片字面 **文本** <tag> &\n'); assert.equal(plan.visualAssetPlan, undefined); positive++;
const crlf = pair(7).replace(/\n/g, '\r\n'); const crlfPlan = parse(build(message(crlf))); assert.ok(crlfPlan); assert.ok(crlfPlan.segments[0].imagePrompt.endsWith('\r\n')); assert.ok(crlfPlan.originalInput.special_notes.endsWith(crlf)); positive++;
for (const ratio of ['9:16', '16:9']) { const p = parse(build(message(`${ratio}\n${pair(2)}`))); assert.equal(p?.settings.aspectRatio, ratio); positive++; }
assert.equal(parse(build(message(`16:9 / 9:16\n${pair(3)}`)))?.settings.aspectRatio, '16:9'); positive++;
for (const content of [pair(1).replace('```text\n视频镜头动作\n```', '```text\n视频镜头动作'), pair(1).replace('视频镜头动作', ' '), pair(1).replace('生图 Prompt', '未知说明'), pair(1).replace('图生视频 Prompt', '生图 Prompt'), pair(1).replace('```text', '```javascript'), `### 角色三视图\n${fence('角色')}\n${pair(1)}`, `### 三视图参考图\n${pair(1)}`, `${pair(1)}\n${fence('未分类')}`, pair(1).split('### 图生视频')[0], `${pair(1)}\n\n### 视频 Prompt`, `${pair(1)}\n<!-- machine -->`, `${pair(1)}\n\n~~~text\n未闭合`, pair(1, 'x'.repeat(50001)), Array.from({length:101}, (_, i) => pair(i)).join('\n'), 'x'.repeat(500001), pair(1).replace('### 生图 Prompt', '> ### 生图 Prompt').replace('```text\n图片', '> ```text\n图片'), `输出中断\n${pair(1)}`]) { assert.equal(build(message(content)), null); negative++; }
for (const patch of [{role:'user'}, {isStreaming:true}, {error:'failure'}, {streamStatus:'result_unknown'}, {id:''}]) { assert.equal(build({...message(pair(1)),...patch}), null); negative++; }
const clone = () => structuredClone(detail) as unknown as Record<string, unknown>;
for (const [key, value] of Object.entries({expected_input:{}, required_contract_version:'forged', require_performance_plan:false, verified_asset_bindings:[], reference_project_id:'fake', assets:[], segments:[{source_index:9}], phase:'planned', commit_key:'fake', intakeVerified:true})) { const forged=clone();forged[key]=value; assert.equal(parse(forged),null); negative++; }
for (const [key,value] of Object.entries({assets:[], visual_asset_plan:{mode:'selected',assets:[]}, input:{}, warning:'verified', draft_kind:'prompt_text', expected_input:{}})) { const forged=clone();(forged.machine_payload as Record<string,unknown>)[key]=value;assert.equal(parse(forged),null);negative++; }
const forged=clone();((forged.machine_payload as Record<string,unknown>).segments as Array<Record<string,unknown>>)[0].image_prompt='modified';assert.equal(parse(forged),null);negative++;
const reordered=Object.fromEntries(Object.entries(detail).reverse());assert.ok(parse(reordered));positive++;
console.log(JSON.stringify({passed:true,positive,negative,providerCalls:0,businessWrites:0}));
