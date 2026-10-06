import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/app/api/video/history/route.ts", import.meta.url), "utf8");
const videoPage = readFileSync(new URL("../src/app/video/page.tsx", import.meta.url), "utf8");
const accountHistory = readFileSync(new URL("../src/components/account-video-history.tsx", import.meta.url), "utf8");
const storyboard = readFileSync(new URL("../src/components/storyboard-workbench.tsx", import.meta.url), "utf8");
const storyboardProjects = readFileSync(new URL("../src/app/api/storyboard/projects/route.ts", import.meta.url), "utf8");
const storyboardProjectContract = readFileSync(new URL("../src/lib/storyboard-project-contract.ts", import.meta.url), "utf8");

assert.match(source, /const publicModelId = t\.model_id \? toPublicModelId\("video", String\(t\.model_id\)\) : "";/u);
assert.match(source, /modelId: publicModelId,\s*publicModelId,/u, "历史主模型字段和别名必须都是公开编号");
assert.doesNotMatch(source, /modelId:\s*String\(t\.model_id/u, "视频历史不得直接返回数据库模型编号");
assert.match(source, /\.eq\("user_id", userId\)/u, "视频历史必须按当前用户隔离");
assert.match(source, /surfaceFilter/u, "视频制作与数字人历史必须按工作台隔离");
assert.match(source, /createVideoAccessUrl/u, "完成结果必须返回站内授权播放地址");
assert.match(source, /classifyVideoProviderError\(rawError, publicModelName\)/u, "失败提示必须绑定原任务模型名称");
assert.match(source, /hideMediaHistoryItem/u, "移出历史必须保留原结果和账单证据");
assert.match(source, /task_label\.not\.like\.分镜工作台%/u, "普通视频数据库窗口必须排除分镜工作台任务");
assert.match(source, /!String\(task\.task_label \|\| ""\)\.startsWith\("分镜工作台"\)/u, "普通视频返回结果必须二次排除分镜任务");
assert.match(videoPage, /\/api\/video\/history\?surface=video-page&limit=100/u, "普通视频页面必须显式声明历史来源");
assert.match(videoPage, /surface: 'video-page', taskId: id/u, "普通视频重试读取必须限定普通视频来源");
assert.match(accountHistory, /onRetry\?: \(task: VideoTask\) => void/u, "账号历史必须支持由来源工作台接管安全重试");
assert.match(accountHistory, /onRetry=\{onRetry\}/u, "账号历史必须把重试处理器传给画廊");
assert.match(storyboard, /surface=storyboard-workbench&limit=200/u, "分镜恢复必须只读取分镜任务");
assert.match(storyboard, /card\.videoTaskId\s*\?\s*await requestVideoAccessUrl\(card\.videoTaskId, token\)/u, "分镜项目视频必须在点击时按稳定任务编号换取新票据");
assert.doesNotMatch(storyboard, /setPreviewMedia\(\{ url: card\.videoUrl, type: "video"/u, "分镜项目视频不得继续直接打开列表加载时的旧票据");
assert.match(storyboard, /card\.videoStatus === "failed" \? "视频生成失败"/u, "分镜失败历史只展示失败状态，不得从历史自动提交");
assert.match(storyboardProjects, /card\.videoTaskId = taskId/u, "项目响应必须把供应商任务编号规范成本站自有任务编号");
assert.match(storyboardProjects, /videoTaskId: String\(card\.videoTaskId \|\| ""\)/u, "项目摘要必须向前端返回稳定视频任务编号");
assert.match(storyboardProjectContract, /videoTaskId: string;/u, "项目卡摘要合同必须包含稳定视频任务编号");

console.log("video history public model/surface/fresh-ticket contract passed; zero network/db/wallet/provider calls");
