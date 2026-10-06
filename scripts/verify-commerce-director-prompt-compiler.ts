import assert from 'node:assert/strict';
import {DIRECTOR_PROMPT_PROVENANCE,assertBenchmarkOriginalDirectorPrompt,benchmarkOriginalDirectorPromptsAcquired} from '../src/commerce/server/director-prompt-provenance';
import {DIRECTOR_VISIBLE_OUTPUT_HEADINGS,assertDirectorVisibleOutputFormat,compileDirectorPromptLayers,compileIndependentDirectorPrompt} from '../src/commerce/server/director-prompt-compiler';

assert.equal(Object.keys(DIRECTOR_PROMPT_PROVENANCE).length,5);
assert.equal(benchmarkOriginalDirectorPromptsAcquired(),false);
assert.throws(()=>assertBenchmarkOriginalDirectorPrompt('benchmark-admin-original-prompts'),/尚未取得/);

const compiled=compileIndependentDirectorPrompt({common:'共同事实与安全规则',category:'商业视频根规则',skill:'口播带货差异规则',runtime:'20秒，中文，生成声音'});
const positions=['【common:commerce-safety】','【category:commerce-video】','【skill:director-skill】','【runtime:turn-context】'].map(value=>compiled.indexOf(value));
assert.ok(positions.every((position,index)=>position>=0&&(index===0||position>positions[index-1])));
assert.throws(()=>compileDirectorPromptLayers([
 {kind:'skill',id:'skill',content:'差异',sourceId:'benchmark-reconstructed-core'},
 {kind:'common',id:'common',content:'共同规则',sourceId:'fire-agent-independent-core'}
]),/顺序/);
assert.throws(()=>compileDirectorPromptLayers([
 {kind:'skill',id:'private',content:'声称是官方原文',sourceId:'benchmark-admin-original-prompts'}
]),/尚未取得/);

const visible=DIRECTOR_VISIBLE_OUTPUT_HEADINGS.map(heading=>`## ${heading}\n正文`).join('\n\n');
assert.equal(assertDirectorVisibleOutputFormat(visible),visible);
assert.throws(()=>assertDirectorVisibleOutputFormat(`${visible}\n\n## 额外说明\n正文`),/五段结构/);

console.log(JSON.stringify({passed:8,networkCalls:0,paidCalls:0,benchmarkOriginalPromptsAcquired:false,visibleHeadings:DIRECTOR_VISIBLE_OUTPUT_HEADINGS}));
