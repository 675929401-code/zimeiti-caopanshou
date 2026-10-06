import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const customerFiles = [
  "src/components/app-route-shell.tsx",
  "src/components/manual-canvas.tsx",
  "src/components/agent-marketplace.tsx",
  "src/components/video-history-gallery.tsx",
  "src/contexts/app-context.tsx",
  "src/lib/chat-pipeline.ts",
  "src/app/video/page.tsx",
  "src/app/digital-human/page.tsx",
  "src/features/digital-human/SpeechComposer.tsx",
  "src/features/digital-human/ImitationComposer.tsx",
  "src/features/youcai-film-studio/use-short-drama-paid-readiness.ts",
  "src/features/youcai-upload-script/youcai-upload-script.tsx",
  "src/features/youcai-general-script/youcai-general-script.tsx",
  "src/features/film-studio-project/film-studio-project-workbench.tsx",
  "src/features/film-studio-project/film-studio-production-panel.tsx",
  "src/features/film-studio-project/film-studio-shot-panel.tsx",
  "src/features/film-studio-project/film-studio-entity-panel.tsx",
  "src/features/youcai-skills/youcai-skills-page.tsx",
  "src/features/youcai-film-studio/youcai-film-studio-portal.tsx",
  "src/features/short-drama/formal-script-unavailable.tsx",
  "src/features/short-drama/short-drama-portal.tsx",
  "src/features/official-tool-aliases/official-tool-alias-map.ts",
  "src/features/official-tool-aliases/official-tool-alias-page.tsx",
  "src/features/official-core-routes/official-agent-route.tsx",
  "src/features/official-core-routes/official-canvas-route.tsx",
  "src/features/official-core-routes/official-assets-route.tsx",
  "src/features/official-home/official-home-page.tsx",
  "src/features/official-inspiration/official-inspiration-gallery.tsx",
  "src/features/official-inspiration/admin-uploaded-inspiration.ts",
  "src/features/drama-script/drama-script-workbench.tsx",
  "src/features/general-script/general-script-workbench.tsx",
  "src/features/general-script/general-script-history-panel.tsx",
  "src/features/general-script-official/general-script-official.tsx",
  "src/features/youcai-skills/youcai-skill-api.ts",
  "src/app/youcai/inspiration/error.tsx",
  "src/components/creation-center/creation-center-page.tsx",
  "src/components/storyboard-workbench.tsx",
  "src/components/image-workbench.tsx",
  "src/components/cover-studio.tsx",
  "src/components/vs/Footer.tsx",
  "src/components/vs/LinkCloneForm.tsx",
  "src/lib/vs/preview-cache.ts",
  "src/app/voice-studio/imitate/page.tsx",
  "src/app/voice-studio/workspace/page.tsx",
  "src/app/extract/page.tsx",
  "src/hooks/use-tool-runtime-catalog.ts",
  "src/app/media-history/page.tsx",
  "src/app/help/storyboard-mode-showcase.tsx",
  "src/app/help/help-center-client.tsx",
  "src/app/api/extract/status/route.ts",
  "src/app/api/cover/history/route.ts",
  "src/app/api/image-workbench/failure-history/route.ts",
  "src/app/api/storage/files/route.ts",
  "src/app/api/video/models/route.ts",
  "src/app/api/voice/status/route.ts",
  "src/app/api/voice/nest/route.ts",
  "src/lib/digital-human-long-repository.ts",
  "src/lib/llm-request-idempotency.ts",
  "src/lib/text-chat-controls.ts",
  "src/lib/extraction-provider-error.ts",
  "src/lib/image-failure-history.ts",
  "src/lib/short-drama/public-drama-errors.ts",
  "src/lib/short-drama/repository.ts",
  "src/lib/short-drama/readiness.ts",
  "src/lib/short-drama/production-repository.ts",
];

const forbiddenCustomerCopy = [
  /管理员(?:免费|免|需先|部署|完成)/u,
  /供应商(?:仍可能)?收费/u,
  /数据库(?:尚未)?迁移/u,
  /生产数据库/u,
  /deploy:ready/u,
  /production 配置/u,
  /错误码：/u,
  /真实生产链已关闭/u,
  /管理员测试/u,
  /免本站积分/u,
  /主站 JWT/u,
  /单一账本/u,
  /模型密钥/u,
  /公开脱敏模型目录/u,
  /不向浏览器暴露渠道与密钥/u,
  /UI 提示，不是安全边界/u,
  /本页自动扣费/u,
  /后端尚未完成验收/u,
  /专项链路待接入/u,
  /模型通道绑定/u,
  /兼容持久层/u,
  /原生短剧表/u,
  /接口已返回真实结果/u,
  /前端 fixture/u,
  /供应商任务 ID/u,
  /上游 HTTP/u,
  /SOURCE PAYLOAD · SUMMARY/u,
  /sourcePayload\.episodes 中暂无分集/u,
  /正式链路验收/u,
  /个人存储索引/u,
  /voice-platform-20250719/u,
  /流式传输异常/u,
  /云存储返回 HTTP/u,
  /接口未返回该条目的有效结果/u,
  /测试存档.+evidence-archive/u,
  /影视工坊保存接口/u,
  /剧本生成接口返回/u,
  /正在写入项目数据库/u,
  /调用 general-script@/u,
  /Skill 包控制面迁移/u,
  /引擎未配置 API Key/u,
  /供应商明确拒绝/u,
  /按门禁执行/u,
  /视觉验收/u,
  /生产环境不会读取公开验收证据/u,
  /当前后台没有可用/u,
  /系统会后台拆解/u,
  /后台官方模板/u,
  /管理员在“管理后台/u,
  /后台 media 域/u,
  /请勿将本次刷新恢复视为已验收/u,
  /官网公开契约/u,
  /管理员可在后台添加智能体/u,
  /已提交任务由后台继续处理/u,
  /服务端历史记录与浏览器本地副本分离/u,
  /以服务端历史为准/u,
  /验收夹具/u,
  /项目验收记录固化为带 SHA-256/u,
];

const sources = await Promise.all(customerFiles.map(async (file) => ({
  file,
  source: await readFile(file, "utf8"),
})));

for (const { file, source } of sources) {
  for (const pattern of forbiddenCustomerCopy) {
    assert.doesNotMatch(source, pattern, `${file} still exposes operational copy: ${pattern}`);
  }
}

const byFile = new Map(sources.map(({ file, source }) => [file, source]));
assert.match(byFile.get("src/components/app-route-shell.tsx"), /部分扩展功能正在准备中/u);
assert.match(byFile.get("src/components/manual-canvas.tsx"), /账号画布保存服务正在准备中/u);
assert.match(byFile.get("src/lib/chat-pipeline.ts"), /当前智能体暂时无法完成回复/u);
assert.match(byFile.get("src/app/voice-studio/workspace/page.tsx"), /function customerVoiceError/u);
assert.match(byFile.get("src/features/official-core-routes/official-agent-route.tsx"), /附件记录暂未保存/u);
assert.match(byFile.get("src/features/film-studio-project/film-studio-production-panel.tsx"), /影视生产服务正在准备中/u);
assert.match(byFile.get("src/app/api/extract/status/route.ts"), /失败记录恢复服务正在准备中/u);
assert.match(byFile.get("src/app/api/cover/history/route.ts"), /现有已完成封面仍可查看/u);
assert.match(byFile.get("src/lib/llm-request-idempotency.ts"), /本次未调用模型或产生费用/u);
assert.match(byFile.get("src/lib/short-drama/public-drama-errors.ts"), /已有项目和草稿不会受影响/u);
assert.doesNotMatch(byFile.get("src/app/extract/page.tsx"), /adminExempt/u);
assert.doesNotMatch(byFile.get("src/hooks/use-tool-runtime-catalog.ts"), /adminExempt/u);
assert.match(byFile.get("src/features/official-tool-aliases/official-tool-alias-page.tsx"), /该工具正在准备中/u);
assert.match(byFile.get("src/features/film-studio-project/film-studio-production-panel.tsx"), /本步骤没有提交生成或产生费用/u);
assert.match(byFile.get("src/components/storyboard-workbench.tsx"), /刚刚收到进度更新/u);
assert.match(byFile.get("src/components/cover-studio.tsx"), /只有明确未扣费的失败记录可以载入/u);
assert.match(byFile.get("src/components/cover-studio.tsx"), /disabled=\{!briefText\.trim\(\)\} onClick=\{\(\) => analyzeBrief\(\)\}/u);
assert.match(byFile.get("src/app/api/video/models/route.ts"), /输出清晰度由当前服务自动选择/u);
assert.doesNotMatch(byFile.get("src/components/vs/Footer.tsx"), /项目地址/u);
assert.doesNotMatch(byFile.get("src/app/api/storage/files/route.ts"), /\bstorage_provider\s*:/u);

console.log(JSON.stringify({
  passed: true,
  customerFiles: customerFiles.length,
  forbiddenPatterns: forbiddenCustomerCopy.length,
  providerRequests: 0,
  paidRequests: 0,
  networkRequests: 0,
  databaseWrites: 0,
}));
