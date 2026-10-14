import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildStoryboardUserPrompt,
  STORYBOARD_AGENT_PROMPT,
  STORYBOARD_AGENT_VERSION,
  storyboardTextLayoutInstruction,
  storyboardNarrationCharBudget,
  StoryboardTargetDurationSchema,
  StoryboardTextLayoutModeSchema,
  StoryboardVisualAssetModeSchema,
} from "../src/lib/storyboard-workbench.ts";
import { buildStoryboardVideoPrompt, storyboardVideoRuntimeGuard } from "../src/lib/storyboard-video-prompt.ts";

const baseUrl = String(process.env.BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const document = await readFile("docs/10秒故事板导演智能体提示词-v2.md", "utf8");
const videoGenerateRoute = await readFile("src/app/api/video/generate/route.ts", "utf8");
const compileRoute = await readFile("src/app/api/storyboard/compile/route.ts", "utf8");
const fenceStart = document.indexOf("```text\n");
const fenceEnd = document.indexOf("\n```", fenceStart + 8);
assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, "交付文档缺少系统提示词代码块");

const documentedPrompt = document.slice(fenceStart + 8, fenceEnd).replace(/\r\n/g, "\n");
const runtimePrompt = STORYBOARD_AGENT_PROMPT.replace(/\r\n/g, "\n");
assert.equal(documentedPrompt, runtimePrompt, "交付文档与运行时提示词不一致");
for (const duration of [8, 10, 15]) {
  assert.equal(
    StoryboardTargetDurationSchema.safeParse(duration).success,
    true,
    `目标时长 Schema 应接受 ${duration} 秒`,
  );
}
for (const duration of [5, 9, 12, 16, "10"]) {
  assert.equal(
    StoryboardTargetDurationSchema.safeParse(duration).success,
    false,
    `目标时长 Schema 不应接受 ${String(duration)}`,
  );
}
assert.equal(StoryboardTextLayoutModeSchema.safeParse("visual-only").success, true);
assert.equal(StoryboardTextLayoutModeSchema.safeParse("advanced-text-layout").success, true);
assert.equal(StoryboardTextLayoutModeSchema.safeParse("always-text").success, false);
assert.equal(StoryboardVisualAssetModeSchema.safeParse("off").success, true);
assert.equal(StoryboardVisualAssetModeSchema.safeParse("selected").success, true);
const visualOnlyInstruction = storyboardTextLayoutInstruction("visual-only");
const advancedTextInstruction = storyboardTextLayoutInstruction("advanced-text-layout");
assert.ok(visualOnlyInstruction.includes("不得要求或暗示生成任何可读文字"));
assert.ok(visualOnlyInstruction.includes("标题、副标题、字幕"));
assert.ok(advancedTextInstruction.includes("用户明确开启高级文字排版"));
assert.ok(advancedTextInstruction.includes("平台在生图完成后单独渲染"));
const defaultUserPrompt = buildStoryboardUserPrompt({
  script: "这是用于验证默认纯视觉模式的完整口播文案。",
  style: "电影级3D卡通动画",
  ratio: "16:9",
  panelMode: "fixed-4",
  targetDuration: 10,
  segments: ["这是用于验证默认纯视觉模式的完整口播文案。"],
});
assert.ok(defaultUserPrompt.includes("画面文字模式：visual-only"));
assert.ok(defaultUserPrompt.includes(visualOnlyInstruction));
assert.ok(defaultUserPrompt.includes("视觉资产模式：off"));
assert.ok(defaultUserPrompt.includes("口播容量基准：每秒约6个有效汉字"));
assert.equal(storyboardNarrationCharBudget(8).target, 48);
assert.equal(storyboardNarrationCharBudget(10).target, 60);
assert.equal(storyboardNarrationCharBudget(15).target, 90);
assert.ok(compileRoute.includes('StoryboardTextLayoutModeSchema.default("visual-only")'), "编译接口没有把纯视觉设为默认模式");
assert.ok(compileRoute.includes("storyboardTextLayoutInstruction(input.textLayoutMode)"), "编译接口没有给数据库旧提示词追加最高优先级文字模式");
assert.ok(runtimePrompt.includes("8秒、10秒或15秒"), "文字协议没有同时声明 8/10/15 秒");
assert.ok(runtimePrompt.includes("8秒真实成片使用3个镜头"), "文字协议缺少 8 秒镜头规则");
assert.ok(runtimePrompt.includes("10秒真实成片使用3至4个镜头"), "文字协议缺少 10 秒镜头规则");
assert.ok(runtimePrompt.includes("15秒真实成片使用4至6个镜头"), "文字协议缺少 15 秒镜头规则");

const response = await fetch(`${baseUrl}/api/storyboard/agent`);
const apiConfig = await response.json();
assert.equal(response.status, 401, "匿名访问不应读取完整提示词");
assert.equal(apiConfig.error, "请先登录", "匿名访问应先返回登录门禁");
assert.equal(apiConfig.code, "AUTH_REQUIRED", "匿名访问应返回稳定的登录错误码");
const agentRoute = await readFile("src/app/api/storyboard/agent/route.ts", "utf8");
assert.ok(/export async function GET\(request: NextRequest\)[\s\S]*authorizeAdminCapability\(request, "prompts\.view"/u.test(agentRoute), "GET 没有管理员提示词查看门禁");

for (const required of [
  "一张4至5格故事板",
  "panelMode",
  "beats[].videoPrompt",
  '"storyboardImagePrompt"',
  '"durationSeconds": 8',
  "角色保持自然肢体表演",
  "镜头执行线生成器",
  "动作余波",
  "四层控制架构",
  "默认模式可读文字为零",
  "包装有强度预算",
  "高能语义包装强度层",
  "每2至3秒一个可见强事件",
  "每段至少3个强视觉事件",
  "占画面约25%至40%",
  "至少2次可见镜头冲击",
  "从冲突色到解决色的转化",
  "剪枝保护",
  "精彩表演调度层",
  "镜头微结构",
  "表演反差",
  "狗狗感染力",
  "主宠关系戏",
  "道具因果戏",
  "镜头动机",
  "时长保鲜",
  "注释校准",
  "安全构图",
  "首格必须能完整识别女主人和狗狗",
  "不能用只拍手、只拍躯干或狗身体局部的开场",
  "每段开头先用0.4至0.8秒建立完整角色身份镜头",
  "完整可见",
  "现场声轨",
  "videoPrompt字段禁用过程词",
  "最终videoPrompt里只允许出现镜头执行句",
  "非语言表演",
  "嘴部动作只服务表情、呼吸和惊讶反应",
  "行业标杆十维门禁",
  "语义核唯一",
  "Prompt密度合格",
  "图视频强绑定",
  "视频阶段始终只上传一张完整的四宫格或五宫格故事板图",
  "不能裁切、拆格、上传视觉资产图",
  "包装有物理来源",
  "失败预判明确",
  "风格指纹必须具体可见",
  "质量密度门槛",
  "清晰干净",
  "柔和次表面散射",
  "气质干净亲和",
  "黄色主要作为上衣或小面积配件识别色",
  "蓝色直筒牛仔裤",
  "中度动画化犬类表演",
  "语义镜头编舞器",
  "场景语义路由",
  "不默认总在室外公园或大马路",
  "不是扁平核对表",
  "资产锁定句 + 本段语义句 + 分格动作句 + 收尾约束句",
  "开场绑定句 + 时间镜头 + 收尾边界句",
  "默认回归测试必须使用纯画面版",
  "高级文字排版另测平台后置渲染",
  "visualAssetPlan",
  "visualAssetRefs",
  "角色/宠物资产只参与分镜生图阶段",
  "可迁移规律按三层处理",
  "stable_grammar",
  "semantic_router",
  "one_off_device",
  "语义包装方法论",
  "选择至少3个候选载体",
  "候选评分与去重",
  "文案字面现实物体优先",
  "指令索引与遵从度锚点",
  "道具轨迹锚点",
  "表情峰值锚点",
  "情绪故事锚点",
  "包装继承锚点",
  "镜头证据锚点",
  "负载优先级锚点",
  "道具五连",
  "眼白扩大",
  "瞳孔放大",
  "眼珠左右扫视",
  "同形态运动继承",
  "主人意图或误解",
  "关系回暖或行动落点",
  "每个实体道具都要有动作证据链",
  "每段至少有2个狗狗表情峰值",
  "图形化包装锚点",
  "默认 visual-only 模式",
  "advanced-text-layout",
  "图片模型仍不自行绘制任何文字",
  "占底部格宽度约10%至14%",
  "至少16%画面宽",
  "不贴边、不半出画、不压住角色脸",
  "每段开头先用0.4至0.8秒建立完整角色身份镜头",
  "无字舒适区刻度",
  "背景医院、商店、路牌、量表和信息窗使用图标或无字造型",
]) {
  assert.ok(runtimePrompt.includes(required), `提示词缺少必要协议：${required}`);
}

const videoPromptGuard = await readFile("src/lib/storyboard-video-prompt.ts", "utf8");
assert.equal(storyboardVideoRuntimeGuard(10), "", "视频运行时不得再注入隐藏的通用文字或创意前缀");
assert.equal(buildStoryboardVideoPrompt({ prompt: "  用户确认的视频执行提示词  ", duration: 10 }), "用户确认的视频执行提示词");
assert.ok(videoPromptGuard.includes("never mixed into the user's provider prompt"), "视频提示词边界缺少直传说明");
assert.ok(runtimePrompt.includes("videoPrompt字段禁用过程词"), "智能体提示词没有建立最终视频Prompt禁用词门禁");
assert.ok(runtimePrompt.includes("最终videoPrompt里只允许出现镜头执行句"), "智能体提示词没有把最终视频Prompt限制为执行口令");
for (const forbiddenTextLeakToken of ["白名单短词", "短中文结论牌", "参考图已有的短中文视觉锚点", "画面文字锚点", "半透明触摸刻度窗", "触摸刻度窗"]) {
  assert.ok(!runtimePrompt.includes(forbiddenTextLeakToken), `智能体提示词仍包含文字泄漏风险词：${forbiddenTextLeakToken}`);
  assert.ok(!videoPromptGuard.includes(forbiddenTextLeakToken), `视频运行时保护句仍包含文字泄漏风险词：${forbiddenTextLeakToken}`);
}
for (const forbiddenRuntimeGuardToken of ["原始口播", "后期", "分段文案", "切合语义", "画面时序依据"]) {
  assert.ok(!videoPromptGuard.includes(forbiddenRuntimeGuardToken), `视频运行时保护句仍包含过程词：${forbiddenRuntimeGuardToken}`);
}

assert.ok(videoGenerateRoute.includes("Creative prompt integrity is independent from technical model settings"), "视频后端缺少创意提示词直传边界");
assert.ok(videoGenerateRoute.includes("const normalizedTiming = { prompt: trimmedPrompt, timelineNormalized: false }"), "视频后端仍可能按时长改写用户提示词");
assert.ok(!/全部核心动作、对白|全部动作、对白|新对白/.test(videoGenerateRoute), "视频后端仍包含对白触发词");

console.log(JSON.stringify({
  passed: true,
  version: STORYBOARD_AGENT_VERSION,
  promptLength: runtimePrompt.length,
  singleSource: true,
}, null, 2));
