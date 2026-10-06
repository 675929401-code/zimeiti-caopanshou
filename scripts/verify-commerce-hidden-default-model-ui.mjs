import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(file)=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
const workspace=read('src/commerce/components/commerce-agent/workspace.tsx');
const runtime=read('src/commerce/components/commerce-agent/runtime-ui.tsx');
const quotes=read('src/commerce/server/quotes.ts');
const modelsRoute=read('src/app/api/commerce/models/route.ts');
const modelPopover=read('src/commerce/components/commerce-agent/reference-ui.tsx');
const modelSelection=read('src/commerce/components/commerce-agent/model-selection.ts');
let passed=0;
const check=(name,work)=>{work();passed+=1;console.log(`PASS ${name}`);};

check('普通用户模型目录只读取视频模型',()=>{
  assert.match(workspace,/const endpoints = \{ video: '\/api\/commerce\/models\?kind=video&operationId=video\.generate' \}/u);
  assert.doesNotMatch(workspace,/\/api\/commerce\/models\?kind=(?:image|agent)/u);
});
check('图片和 Agent 提交不携带隐藏模型 ID',()=>{
  assert.match(workspace,/\.\.\.\(tab==='video'\?\{modelId:modelIds\.video\}:\{\}\)/u);
  assert.doesNotMatch(workspace,/kind:'agent',modelId:/u);
});
check('运行时允许隐藏模型的请求省略 modelId',()=>{
  assert.match(runtime,/Omit<JobInput,'requestId'\|'modelId'>&\{modelId\?:string\}/u);
});
check('服务端忽略隐藏模型客户端值并按发布路由解析',()=>{
  assert.match(quotes,/const route = resolveOperation\(input\);\s*input = \{ \.\.\.input, modelId: route\.modelId \}/u);
});
check('普通用户接口拒绝查询图片和 Agent 模型目录',()=>{
  assert.match(modelsRoute,/kind\s*!==\s*['"]video['"]/u);
});
check('图片本地校验不依赖未公开模型能力',()=>{
  const validationLine=workspace.split(/\r?\n/u).find((line)=>line.includes('validateImageInput({skillId,prompt,format,references:'))||'';
  assert.ok(validationLine);
  assert.doesNotMatch(validationLine,/model\?\.capabilities/u);
});
check('图片生成按钮不再依赖视频模型对象',()=>{
  assert.match(workspace,/\(tab==='video'&&\(!model\|\|model\.capabilities\.available===false\|\|model\.generationReady===false\)\)/u);
});
check('图片与 Agent 不渲染模型选择器',()=>{
  assert.match(workspace,/tab==='video'&&modelOpen&&<ModelPopover/u);
  assert.match(workspace,/const chatModelSelect=<div className="ca-model-select" aria-label="智能创作能力">/u);
});
check('图片付费动作承诺在确认前展示准确报价',()=>{
  assert.match(workspace,/生成前确认准确价格/u);
  assert.match(runtime,/应付 ¥\$\{price\}/u);
});
check('普通用户错误文案不引导进入后台',()=>{
  assert.doesNotMatch(workspace,/后台检查模型连接/u);
  assert.match(workspace,/当前视频模型暂不可用，请稍后重试/u);
});
check('已发布模型不会因缺少验收记录从目录消失',()=>{
  assert.match(modelsRoute,/annotated\.filter\(model=>publishedVideoIds\.has\(model\.id\)\)/u);
  assert.doesNotMatch(modelsRoute,/publishedVideoIds\.has\(model\.id\)&&model\.verified/u);
  assert.match(modelsRoute,/generationReady/u);
  assert.doesNotMatch(modelsRoute,/if\(c\.executionSupported===false\)reasons\.push/u);
  assert.match(modelsRoute,/catch\{acceptanceAvailable=false;\}/u);
});
check('共享发布缺失时目录仍展示但生成保持关闭',()=>{
  assert.match(modelsRoute,/primePublishedCommerceConfiguration\(\{required:false\}\)/u);
  assert.match(modelsRoute,/configurationStatus\.enabled&&!published\?'带货配置尚未发布，当前模型仅供选择和配置'/u);
  assert.match(modelsRoute,/generationReady=.*!configurationStatus\.enabled\|\|!!published&&published\.paidJobsReady/u);
});
check('未就绪模型可查看选择但生成动作被明确阻止',()=>{
  assert.match(modelPopover,/m\.generationReady===false/u);
  assert.doesNotMatch(modelPopover,/disabled=.*generationReady/u);
  assert.match(workspace,/model\.generationReady===false/u);
  assert.match(workspace,/完成生成验收后开放/u);
});
check('模型默认选择优先生成就绪项并保留可见回退',()=>{
  assert.match(modelSelection,/const ready=available\.filter\(item=>item\.generationReady!==false\)/u);
  assert.match(modelSelection,/\|\|available\[0\]\?\.id\|\|''/u);
});

console.log(`commerce hidden default model UI contract passed: ${passed}`);
