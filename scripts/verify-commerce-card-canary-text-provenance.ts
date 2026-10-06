import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {resolveImageTextProvenance,stageCardCanaryImageTextWorkflow} from '../src/commerce/server/image-workflow-context';

const root=process.cwd(),runtimeRoot=path.resolve(root,'.tmp-e2e','commerce-card-canary-text-provenance');
assert.ok(runtimeRoot.startsWith(path.resolve(root,'.tmp-e2e')+path.sep),'测试数据目录必须位于项目 .tmp-e2e 内');
fs.rmSync(runtimeRoot,{recursive:true,force:true});
process.env.COMMERCE_DATA_DIR=runtimeRoot;
const owner='card-canary-test-owner',input={
 requestId:'card-canary-test-request',
 kind:'image' as const,
 modelId:'card-canary-test-model',
 purpose:'commerce-card-canary',
 prompt:'生成四镜头故事版',
 skillId:'script-storyboard',
 references:[],
 aspectRatio:'1:1',
 resolution:'1K',
};

assert.throws(()=>stageCardCanaryImageTextWorkflow(owner,input,''),/完整脚本文本/u);
const staged=stageCardCanaryImageTextWorkflow(owner,input,'镜头1：人物拿起白色杯子。\n镜头2：人物观察蓝色圆形图案。');
assert.ok(staged);
const provenance=resolveImageTextProvenance(owner,input,staged.executionContext);
assert.equal(provenance?.workflowId,staged.executionContext.imageWorkflowContext.workflowId);
assert.equal(provenance?.sources.length,1);
assert.equal(provenance?.sources[0]?.text,'镜头1：人物拿起白色杯子。\n镜头2：人物观察蓝色圆形图案。');
assert.equal(provenance?.sources[0]?.contentHash,staged.scriptTextHash);
staged.cleanup();
assert.throws(()=>resolveImageTextProvenance(owner,input,staged.executionContext),/画布任务不存在/u);
assert.equal(stageCardCanaryImageTextWorkflow(owner,{...input,skillId:'default'},undefined),undefined);
console.log(JSON.stringify({suite:'commerce-card-canary-text-provenance',passed:7,providerCalls:0,walletWrites:0}));
