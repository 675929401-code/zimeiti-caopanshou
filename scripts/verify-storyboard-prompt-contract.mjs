import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  STORYBOARD_AGENT_PROMPT,
  STORYBOARD_AGENT_VERSION,
  StoryboardTargetDurationSchema,
} from "../src/lib/storyboard-workbench.ts";

const baseUrl = String(process.env.BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const document = await readFile("docs/10秒故事板导演智能体提示词-v2.md", "utf8");
const videoGenerateRoute = await readFile("src/app/api/video/generate/route.ts", "utf8");
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
assert.ok(runtimePrompt.includes("8秒、10秒或15秒"), "文字协议没有同时声明 8/10/15 秒");
assert.ok(runtimePrompt.includes("8秒真实成片使用3个镜头"), "文字协议缺少 8 秒镜头规则");
assert.ok(runtimePrompt.includes("10秒真实成片使用3至4个镜头"), "文字协议缺少 10 秒镜头规则");
assert.ok(runtimePrompt.includes("15秒真实成片使用4至6个镜头"), "文字协议缺少 15 秒镜头规则");

const response = await fetch(`${baseUrl}/api/storyboard/agent`);
const apiConfig = await response.json();
assert.equal(response.status, 403, "匿名访问不应读取完整提示词");
assert.equal(apiConfig.error, "需要管理员权限", "匿名访问应返回明确的管理员门禁");
const agentRoute = await readFile("src/app/api/storyboard/agent/route.ts", "utf8");
assert.ok(/export async function GET\(request: Request\)[\s\S]*requireAdmin\(request\)/u.test(agentRoute), "GET 没有管理员门禁");

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
  "白名单",
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
  "0秒直接进入第1格对应场景扩展后的全屏画面",
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
  "对标注释版校准",
  "图文导演注释版",
  "视频安全参考版",
  "每格注释只描述该格的运镜",
  "每格注释要能反推一个高能强事件",
  "默认回归测试必须至少跑一次图文导演注释版",
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
  "全段最多在最终落幅保留1个大号白名单短中文结论牌",
  "最终结论牌必须是完整入镜的不透明实体牌",
  "占底部格宽度约10%至14%",
  "至少16%画面宽",
  "画面内部安全区而不是角落边缘",
  "每段开头先用0.4至0.8秒建立完整角色身份镜头",
  "无字舒适区刻度",
  "背景医院、商店、路牌、量表和信息窗使用图标或无字造型",
]) {
  assert.ok(runtimePrompt.includes(required), `提示词缺少必要协议：${required}`);
}

const videoPromptGuard = await readFile("src/lib/storyboard-video-prompt.ts", "utf8");
assert.ok(videoPromptGuard.includes("完整的一图多画面故事板"), "视频运行时保护句没有绑定完整故事板参考");
assert.ok(videoPromptGuard.includes("暖芥末黄上衣") && videoPromptGuard.includes("蓝色牛仔裤"), "视频运行时保护句没有锁定严格对标穿搭");
assert.ok(videoPromptGuard.includes("开头0.4至0.8秒先建立完整角色身份镜头"), "视频运行时保护句没有强化开头完整角色同框");
assert.ok(videoPromptGuard.includes("高能版执行") && videoPromptGuard.includes("全段至少3个强视觉事件"), "视频运行时保护句没有强化高能事件密度");
assert.ok(videoPromptGuard.includes("25%至40%视觉注意力") && videoPromptGuard.includes("至少两次强镜头冲击"), "视频运行时保护句没有锁定英雄包装和强镜头冲击");
assert.ok(videoPromptGuard.includes("红黑冲突包装向金色或绿色解决包装转化"), "视频运行时保护句没有锁定冲突色到解决色转化");
assert.ok(videoPromptGuard.includes("duration === 15") && videoPromptGuard.includes("增加升级爆点或二次反转"), "视频运行时保护句没有强化15秒扩展规则");
assert.ok(videoPromptGuard.includes("每个实体道具沿一条清楚物理路径完成动作"), "视频运行时保护句没有拦截道具凭空出现");
assert.ok(!videoPromptGuard.includes("视频模型看不到其余故事板格"), "视频运行时保护句仍在裁切为首格参考");
assert.ok(videoPromptGuard.includes("现场声轨只包含") && videoPromptGuard.includes("人物和宠物不发出语言化声音"), "视频运行时保护句没有区分现场声与语言类声音");
assert.ok(videoPromptGuard.includes("无字牌面") && videoPromptGuard.includes("全段最多在最终落幅保留1个大号短中文结论牌"), "视频运行时保护句没有建立文字泄漏防护");
assert.ok(videoPromptGuard.includes("不透明实体牌") && videoPromptGuard.includes("完整入镜") && videoPromptGuard.includes("只放一个短词"), "视频运行时保护句没有约束最终结论牌和小字泄漏");
assert.ok(videoPromptGuard.includes("道具来源、取出或拾起、持有移动、接触点、释放或放回"), "视频运行时保护句没有建立道具轨迹锚点");
assert.ok(videoPromptGuard.includes("眼白扩大") && videoPromptGuard.includes("至少两次明显表情峰值"), "视频运行时保护句没有强化狗狗表情峰值");
assert.ok(videoPromptGuard.includes("核心光晕、电弧、速度线、实体牌和粒子路径按同形态运动继承"), "视频运行时保护句没有继承参考包装形态");
assert.ok(runtimePrompt.includes("videoPrompt字段禁用过程词"), "智能体提示词没有建立最终视频Prompt禁用词门禁");
assert.ok(runtimePrompt.includes("最终videoPrompt里只允许出现镜头执行句"), "智能体提示词没有把最终视频Prompt限制为执行口令");
for (const forbiddenTextLeakToken of ["参考图已有的短中文视觉锚点", "画面文字锚点", "半透明触摸刻度窗", "触摸刻度窗"]) {
  assert.ok(!runtimePrompt.includes(forbiddenTextLeakToken), `智能体提示词仍包含文字泄漏风险词：${forbiddenTextLeakToken}`);
  assert.ok(!videoPromptGuard.includes(forbiddenTextLeakToken), `视频运行时保护句仍包含文字泄漏风险词：${forbiddenTextLeakToken}`);
}
for (const forbiddenRuntimeGuardToken of ["原始口播", "后期", "分段文案", "切合语义", "画面时序依据"]) {
  assert.ok(!videoPromptGuard.includes(forbiddenRuntimeGuardToken), `视频运行时保护句仍包含过程词：${forbiddenRuntimeGuardToken}`);
}

assert.ok(videoGenerateRoute.includes("动作、声音事件和运镜"), "视频后端时长护栏没有使用无对白的声音事件表达");
assert.ok(!/全部核心动作、对白|全部动作、对白|新对白/.test(videoGenerateRoute), "视频后端时长护栏仍包含对白触发词");

console.log(JSON.stringify({
  passed: true,
  version: STORYBOARD_AGENT_VERSION,
  promptLength: runtimePrompt.length,
  singleSource: true,
}, null, 2));
