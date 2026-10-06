import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentMode = process.env.AGENT_MODE || "high_energy";
const runId = process.env.RUN_ID || `storyboard-semantic-vnext-${agentMode}-${Date.now()}`;
const replayConversationId = process.env.REPLAY_CONVERSATION_ID?.trim() || "";
const replayRawFile = process.env.REPLAY_RAW_FILE?.trim() || "";
const targetDuration = process.env.TARGET_DURATION_SECONDS || "10";
const scenarioSet = process.env.SCENARIO_SET || "diversity";
const scenarioCase = process.env.SCENARIO_CASE?.trim().toUpperCase() || "";
assert.ok(["10", "15"].includes(targetDuration), "vNext只验收10或15秒");

const agents = {
  high_energy: { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张" },
  cinematic: { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事" },
  lyrical: { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感" },
} as const;
assert.ok(agentMode in agents, `未知AGENT_MODE：${agentMode}`);
const expectedAgent = agents[agentMode as keyof typeof agents];

const diversityCases = [
  {
    kind: "高能喜剧",
    expectedPet: /柯基/u,
    copy: "门口的扫地机器人突然卷走外卖袋提绳，短腿小狗误以为猎物逃跑，猛扑后被空纸袋罩住脑袋，主人伸手没接住，鞋柜上的钥匙和帽子接连掉下来。",
  },
  {
    kind: "温暖陪伴",
    expectedPet: /金毛/u,
    copy: "她深夜加班回家，狗狗没有兴奋乱跳，只把旧毛毯从沙发拖到门边，安静靠住她冻得发抖的腿；她蹲下抱住它，玄关感应灯才慢慢亮满。",
  },
  {
    kind: "健康科普",
    expectedPet: /比格/u,
    copy: "六岁比格犬最近喝水明显变多，男主人先在水碗外贴刻度记录一天水量，又观察尿垫次数，随后带它做无创检查；重点是持续异常要咨询兽医，不能自己乱用药。",
  },
  {
    kind: "情绪抒情",
    expectedPet: /贵宾/u,
    copy: "退休木匠把老伴留下的蓝围巾收进抽屉，白色老年贵宾犬却轻轻叼住围巾一角，把它放回窗边那把空椅子上；老人停住手，坐到椅旁陪它一起看暮色。",
  },
] as const;

const packagingCases = [
  {
    kind: "关系与社交破冰",
    expectedPet: /金毛/u,
    copy: "他每天傍晚带狗绕小区一圈，原本互不认识的邻居因为狗狗停步、交换玩具和互相让路，慢慢开始点头打招呼；狗不是恋爱公式，却常常成为真实的社交破冰点。",
  },
  {
    kind: "累积与热量挤占",
    expectedPet: /柯基/u,
    copy: "主人把零食一颗颗塞进训练袋，短腿小狗以为今天奖励无限，刚坐好就扑了个空；零食也要算进一天总热量，给得越多，正餐能留下的空间就越少。",
  },
  {
    kind: "听觉与视线校准",
    expectedPet: /边牧/u,
    copy: "边牧隔着门听到钥匙的细响，先竖起一只耳朵，再歪头绕过门框找到声源；歪头是在重新校准听觉和视线，并不只是故意卖萌。",
  },
  {
    kind: "时间与情绪留痕",
    expectedPet: /贵宾/u,
    copy: "白色老年贵宾犬每天都把旧牵引绳放到门边，老人明知今天不出门，还是替它扣好空着的项圈；他们一起坐到窗前，等夕阳把牵引绳的影子慢慢拉长。",
  },
] as const;

const benchmarkVnext4Cases = [
  {
    kind: "隐藏声源与行为反转",
    expectedPet: /柯基/u,
    copy: "狗狗无缘无故地乱叫？它的听力是人类的十几倍，有时候甚至能听到我们听不到的声音，可能是门外陌生的脚步，也可能是眼前飞过的昆虫。",
  },
] as const;

const generalizationVnext4Cases = [
  {
    id: "A",
    kind: "健康判断与身体负担",
    expectedPet: /金毛|柯基/u,
    copy: "狗是胖点好还是瘦点好？别再凭可爱判断。站在正上方看，腰线应该收进去；顺着侧腹摸，能摸到肋骨但不是根根凸起，才是正常。胖狗走两步就喘、上台阶要停，不是懒，是身体在透支。控制体重，不是亏待它，是让它多陪你几年。",
  },
  {
    id: "B",
    kind: "关系情绪与安全确认",
    expectedPet: /金毛/u,
    copy: "遛狗时它走几步就回头看你，不是磨蹭，也不是胆小。它是在确认你还跟在身后。对狗来说，你不是牵绳的人，而是它探索世界时的安全坐标。下次它回头，别急着拽绳，给它一个眼神，它就知道可以放心往前走。",
  },
  {
    id: "C",
    kind: "本能机制与喜剧动作",
    expectedPet: /柯基/u,
    copy: "狗睡觉前为什么总要转几圈、扒两下窝？不是嫌弃你买的床。它的祖先会踩平草叶、赶走虫子，还要用身体感受风向和温度。现在家里明明很安全，这套古老程序还是会自动启动。它转的不是圈，是刻在身体里的生存记忆。",
  },
] as const;

const novelVnext43Cases = [
  {
    id: "D",
    kind: "离家信号误解与生活反差",
    expectedPet: /金毛|柯基/u,
    copy: "你一拿钥匙，狗就叼着拖鞋躲起来，它不是故意捣乱，也不一定讨厌出门。钥匙声、换鞋、关灯这些每天重复的动作，早被它串成了‘你要离开’的预告。试着打乱顺序：拿起钥匙却坐回沙发，穿好鞋先陪它玩一会儿，让这些信号不再只通向分别。它误解的不是钥匙，是你反复演给它看的离开。",
  },
] as const;

const generalizationVnext433Cases = [
  {
    id: "A",
    kind: "喜剧反差与选择性听觉",
    expectedPet: /哈士奇/u,
    copy: "喊哈士奇下沙发，它把脸埋进靠垫，耳朵往后一撇，像完全听不见。可你只是轻轻捏了一下零食袋，它下一秒就从沙发弹到你面前。别被它骗了，狗会按声音和结果筛选反应：没好处的呼唤先装傻，熟悉的奖励声却能瞬间锁定。想让召回更可靠，别只重复喊，把回应和清楚、适量的奖励重新连起来。",
  },
  {
    id: "B",
    kind: "健康科普与友好耳部检查",
    expectedPet: /金毛|柯基/u,
    copy: "狗狗频繁甩头、挠耳朵，不一定是在卖萌，可能是耳朵发痒或不舒服。先靠近观察有没有异常气味、红肿或分泌物，再记下它出现的频率；如果持续反复，就尽快做检查。别拿棉签往深处掏，也别自己乱滴药，错误处理可能把问题推得更深。",
  },
  {
    id: "C",
    kind: "情感关系与珍贵礼物",
    expectedPet: /金毛/u,
    copy: "你难过时，狗叼来最喜欢的旧玩具，轻轻放到脚边，又退开等着。它不一定是在催你陪玩，也可能是在用自己最珍贵的东西安慰你。对它来说，玩具不是普通物件，而是安全感和快乐的储存罐。下次别急着丢出去，先接住它的礼物，看看它是不是在等你重新抬头。",
  },
] as const;

const generalizationVnext434Cases = [
  {
    id: "A",
    kind: "训练机制与牵引反作用",
    expectedPet: /柴犬/u,
    expectedCarrier: /牵引绳|拔河|红绿灯|停止|松绳/u,
    copy: "遛柴犬时你越用力拽绳，它反而越拼命往前顶？这不一定是故意较劲。牵引绳突然绷紧，会让狗本能地向反方向对抗压力。先停住脚步，等绳子松下来，再用奖励引导它回到身边。会走松绳，不是被拽服，是学会了跟你一起走。",
  },
  {
    id: "B",
    kind: "夏日健康与地面灼热",
    // 文案未指定品种：健康场景由智能体按语义在金毛/柯基中选择，测试不反向硬编码。
    expectedPet: /金毛|柯基/u,
    expectedCarrier: /温度计|刻度|肉垫|脚印|警示|红灯/u,
    copy: "夏天遛狗前别只看气温，先把手背贴在地面五秒。你觉得烫得放不住，狗的肉垫也可能被灼伤。它突然抬脚、踮走或拒绝前进，不是在耍赖。换到清晨傍晚，走阴影和草地，才是真正保护它的脚。",
  },
  {
    id: "C",
    kind: "镜像识别与嗅觉反差",
    expectedPet: /金毛/u,
    expectedCarrier: /镜子|落地镜|放大镜|鼻子|气味|问号/u,
    copy: "金毛第一次对着落地镜低吼，不是认出了另一只狗。镜子里有动作和眼神，却没有任何气味，信息根本对不上。它会先警惕、绕到镜后寻找，再慢慢失去兴趣。对狗来说，鼻子才是确认身份的主开关。",
  },
] as const;

const generalizationVnext4346Cases = [
  {
    id: "A",
    kind: "抵抗力与盲目补充",
    expectedPet: /金毛|柯基/u,
    expectedCarrier: /盾|门|围栏|雨伞|屏障|缓冲/u,
    copy: "狗狗抵抗力差，不等于每天多倒几勺补充剂。真正的防线来自规律吃饭、稳定睡眠、适量运动和及时检查。瓶子堆得再高，也挡不住长期熬夜和过量喂食。先把生活节奏稳住，再判断它真正缺什么。",
  },
  {
    id: "B",
    kind: "拆家压力与释放",
    expectedPet: /金毛|柯基/u,
    expectedCarrier: /压力表|弹簧|阀门|泄压|沙发|纸箱|玩具/u,
    copy: "狗把沙发咬出一个洞，不一定是在报复你。精力和焦虑像越压越紧的弹簧，没有散步、嗅闻和互动，它只能找最近的东西释放。先给它能撕、能找、能追的正确出口，压力有地方走，家具才有机会完整。",
  },
  {
    id: "C",
    kind: "等待时间与重逢",
    expectedPet: /金毛|柯基/u,
    expectedCarrier: /钟|时钟|沙漏|门|门缝|灯|脚印|日历/u,
    copy: "你出门两小时，对狗来说可能像等了很久。它守着门口、听每一次脚步，直到钥匙真正转动。回家时别急着推开它，先蹲下让它确认你回来了。那几秒的回应，会把漫长等待重新变成安心。",
  },
] as const;

assert.ok(["diversity", "packaging", "benchmark_vnext4", "generalization_vnext4", "novel_vnext4_3", "generalization_vnext4_3_3", "generalization_vnext4_3_4", "generalization_vnext4_3_4_6"].includes(scenarioSet), `未知SCENARIO_SET：${scenarioSet}`);
const selectedCases = scenarioSet === "packaging"
  ? packagingCases
  : scenarioSet === "benchmark_vnext4"
    ? benchmarkVnext4Cases
    : scenarioSet === "generalization_vnext4"
      ? generalizationVnext4Cases
      : scenarioSet === "novel_vnext4_3"
        ? novelVnext43Cases
        : scenarioSet === "generalization_vnext4_3_3"
          ? generalizationVnext433Cases
          : scenarioSet === "generalization_vnext4_3_4"
            ? generalizationVnext434Cases
            : scenarioSet === "generalization_vnext4_3_4_6"
              ? generalizationVnext4346Cases
            : diversityCases;
const usesLeanPositivePromptContract = scenarioSet === "generalization_vnext4_3_4" || scenarioSet === "generalization_vnext4_3_4_6";
const cases = scenarioCase
  ? selectedCases.filter((item) => "id" in item && item.id === scenarioCase)
  : selectedCases;
assert.ok(cases.length > 0, `SCENARIO_CASE未命中：${scenarioCase}`);

interface PresetField {
  id: string;
  label?: string;
  sendLabel?: boolean;
  sendText?: string;
  type?: string;
  order?: number;
  options?: string[];
}

interface AgentCard {
  id: string;
  name: string;
  model: string;
  preset_fields?: PresetField[];
}

function buildPresetMessage(fields: PresetField[]): string {
  const values: Record<string, string> = {
    segmented_script: cases.map((item, index) => `${index + 1}.【${item.copy}】`).join("\n"),
    animation_style: "高能商业3D动画喜剧（皮克斯式）",
    aspect_ratio: "16:9",
    target_duration_seconds: targetDuration,
  };
  return [...fields]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .flatMap((field) => {
      const raw = values[field.id]?.trim();
      if (!raw) return [];
      const value = field.type === "textarea" ? raw.replace(/^(\d+)\. /gm, "$1\\. ") : raw;
      return field.sendLabel === false ? [value] : [`${field.sendText || field.label || field.id}：${value}`];
    })
    .join("\n");
}

async function readStreamingContent(response: Response): Promise<string> {
  assert.ok(response.body, "模型流没有响应体");
  const reader = response.body.getReader();
  const decoder = new SseEventStreamDecoder();
  let content = "";
  let doneEvent = false;
  const consume = (events: ReturnType<SseEventStreamDecoder["push"]>) => {
    for (const event of events) {
      const raw = event.data.trim();
      if (!raw) continue;
      if (event.event === "done" || raw === "[DONE]") {
        doneEvent = true;
        continue;
      }
      const data = JSON.parse(raw) as {
        error?: string | { message?: string };
        content?: string;
        delta?: { content?: string };
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      if (data.error) throw new Error(typeof data.error === "string" ? data.error : data.error.message || "模型流错误");
      content += data.choices?.[0]?.delta?.content
        || data.choices?.[0]?.message?.content
        || data.delta?.content
        || data.content
        || "";
    }
  };
  while (!doneEvent) {
    const { done, value } = await reader.read();
    if (value) consume(decoder.push(value));
    if (done) break;
  }
  consume(decoder.finish());
  assert.ok(doneEvent, "模型流在[DONE]前中断");
  return content;
}

function parseCodeBlocks(content: string): string[] {
  return [...content.matchAll(/```(?:text)?\s*\r?\n([\s\S]*?)```/giu)].map((match) => match[1].trim());
}

function uniqueNumbers(prompt: string, label: "Frame" | "镜头"): number[] {
  const pattern = label === "Frame" ? /Frame\s*([1-5])/giu : /镜头\s*([1-5])/gu;
  return [...new Set([...prompt.matchAll(pattern)].map((match) => Number(match[1])))];
}

async function waitForHistory(token: string, conversationId: string, expectedAssistant: string) {
  const deadline = Date.now() + 45_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      last = await response.json();
      const messages = (last as { conversation?: { messages?: Array<{ role?: string; content?: string }> } })
        .conversation?.messages || [];
      if (messages.some((message) => message.role === "user")
        && messages.some((message) => message.role === "assistant" && message.content === expectedAssistant)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`对话历史未完整落库：${JSON.stringify(last)}`);
}

async function main() {
  await mkdir(".tmp-e2e", { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; user?: { id?: string }; error?: string };
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");

  const botsResponse = await fetch(`${baseUrl}/api/bots?semantic_vnext=${Date.now()}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const botsPayload = await botsResponse.json() as { bots?: AgentCard[]; error?: string };
  assert.ok(botsResponse.ok, botsPayload.error || "主站智能体列表读取失败");
  const agent = botsPayload.bots?.find((item) => item.id === expectedAgent.id && item.name === expectedAgent.name);
  assert.ok(agent, `主站未找到：${expectedAgent.name}`);
  const fields = agent.preset_fields || [];
  for (const id of ["segmented_script", "animation_style", "aspect_ratio", "target_duration_seconds", "special_notes"]) {
    assert.ok(fields.some((field) => field.id === id), `${agent.name}缺少接收字段：${id}`);
  }
  assert.deepEqual(fields.find((field) => field.id === "target_duration_seconds")?.options, ["10", "15"]);

  const submittedMessage = buildPresetMessage(fields);
  const conversationId = replayConversationId
    || `conv_storyboard_semantic_vnext_${agentMode}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  let content = "";
  let replayHistory: unknown = null;
  if (replayRawFile) {
    content = await readFile(replayRawFile, "utf8");
    assert.ok(content.trim(), `离线复验文件为空：${replayRawFile}`);
  } else if (replayConversationId) {
    const historyResponse = await fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.ok(historyResponse.ok, `真实历史恢复失败（${historyResponse.status}）`);
    replayHistory = await historyResponse.json();
    const messages = (replayHistory as { conversation?: { messages?: Array<{ role?: string; content?: string }> } })
      .conversation?.messages || [];
    content = [...messages].reverse().find((message) => message.role === "assistant")?.content || "";
    assert.ok(content, `真实历史缺少assistant输出：${conversationId}`);
  } else {
    const response = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: submittedMessage }],
        model: agent.model,
        stream: true,
        userId: session.user.id,
        agentName: agent.name,
        agentId: agent.id,
        conversationId,
        maxContextRounds: 0,
        maxReplyTokens: 32768,
        timeout: 300,
        enableWebSearch: false,
        responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(420_000),
    });
    assert.ok(response.ok, `${agent.name}真实生成失败（${response.status}）`);
    content = response.headers.get("content-type")?.includes("text/event-stream")
      ? await readStreamingContent(response)
      : String(((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || "");
  }
  await writeFile(`.tmp-e2e/${runId}-agent-raw.md`, content, "utf8");

  const blocks = parseCodeBlocks(content);
  assert.equal(blocks.length, cases.length * 2, `应输出${cases.length * 2}个代码框，实际${blocks.length}个`);
  assert.doesNotMatch(content, /```json|"schema_version"\s*:/iu, "前台输出仍含JSON机器包");
  const results = cases.map((testCase, index) => {
    const imagePrompt = blocks[index * 2];
    const videoPrompt = blocks[index * 2 + 1];
    const frames = uniqueNumbers(imagePrompt, "Frame");
    const shots = uniqueNumbers(videoPrompt, "镜头");
    const captionFrames = [...new Set([...imagePrompt.matchAll(/Frame\s*([1-5])\s*:\s*[A-Za-z]/gu)]
      .map((match) => Number(match[1])))];
    const captionSentences = [...imagePrompt.matchAll(/Frame\s*[1-5]\s*:\s*([A-Za-z][^\r\n]*)/gu)]
      .map((match) => match[1].trim());
    const packagingMethodLines = imagePrompt.split(/\r?\n/)
      .filter((line) => /语义核|视觉动词|场景载体|角色互动|生命周期|主语义装置|主包装表达|包装表达/u.test(line));
    assert.ok(frames.length === 4 || frames.length === 5, `${testCase.kind}不是4/5格`);
    assert.ok(shots.length >= (targetDuration === "10" ? 3 : 4)
      && shots.length <= (targetDuration === "10" ? 4 : 5), `${testCase.kind}实际镜头数错误：${shots.length}`);
    assert.match(imagePrompt, testCase.expectedPet, `${testCase.kind}犬种未按语义或原文选定`);
    assert.match(videoPrompt, testCase.expectedPet, `${testCase.kind}视频未锁定犬种`);
    assert.doesNotMatch(imagePrompt, /黄(?:色|金色|芥末黄)?连帽卫衣|黄卫衣/u, `${testCase.kind}回退到固定黄卫衣人物`);
    if (!usesLeanPositivePromptContract) {
      assert.match(imagePrompt, /非真人|非照片写实/u, `${testCase.kind}缺少非真人3D风格锁`);
      assert.match(videoPrompt, /非真人|非照片写实/u, `${testCase.kind}视频缺少跨图3D风格锁`);
      assert.match(videoPrompt, /(?:不得|不)显示[^\n]{0,24}网格/u, `${testCase.kind}视频缺少网格排除指令`);
      assert.match(videoPrompt, /(?:不得|不)(?:生成|新增|显示).*字幕/u, `${testCase.kind}视频缺少字幕排除指令`);
    } else {
      assert.match(imagePrompt, /高端商业3D动画电影|高能商业(?:风格化)?3D动画电影|商业级3D动画电影|高能商业3D动画喜剧|影院级风格/u, `${testCase.kind}缺少正向商业3D美术定义`);
      assert.match(imagePrompt, /成年亚洲女性/u, `${testCase.kind}未落实默认成年亚洲女性`);
      assert.match(imagePrompt, /制作说明条的唯一文字资产是(?:下方四条|与格数对应的)英文\s*Frame\s*句/u, `${testCase.kind}未显式锁定英文说明条唯一文字资产`);
      assert.ok(captionSentences.every((sentence) => {
        const wordCount = sentence.match(/[A-Za-z]+(?:'[A-Za-z]+)?/gu)?.length || 0;
        return wordCount >= 8 && wordCount <= 14;
      }), `${testCase.kind}英文说明条未控制在8至14个常用词`);
      assert.match(videoPrompt, /保持(?:参考图的高端商业|统一)风格化3D动画形象/u, `${testCase.kind}视频缺少单句正向风格连续定义`);
      const imageBudget = scenarioSet === "generalization_vnext4_3_4_6" ? [1500, 2400] : [1750, 2800];
      const videoBudget = scenarioSet === "generalization_vnext4_3_4_6" ? [550, 1100] : [700, 1500];
      assert.ok(imagePrompt.length >= imageBudget[0] && imagePrompt.length <= imageBudget[1], `${testCase.kind}生图Prompt长度超预算：${imagePrompt.length}`);
      assert.ok(videoPrompt.length >= videoBudget[0] && videoPrompt.length <= videoBudget[1], `${testCase.kind}视频Prompt长度超预算：${videoPrompt.length}`);
      const repeatedDefenseCount = [...`${imagePrompt}\n${videoPrompt}`.matchAll(/非真人|非半写实|非照片写实|不复制|最高真值|重新设计|不得重新/gu)].length;
      assert.ok(repeatedDefenseCount <= 1, `${testCase.kind}仍有重复防御话术：${repeatedDefenseCount}`);
      assert.doesNotMatch(`${imagePrompt}\n${videoPrompt}`, /内部分析|八维分析|评分标准|候选方案|选择优先级|输出前/u, `${testCase.kind}泄露内部方法论`);
      if ("expectedCarrier" in testCase) assert.match(imagePrompt, testCase.expectedCarrier, `${testCase.kind}缺少一秒可懂的语义载体`);
    }
    if (scenarioSet === "packaging" || scenarioSet === "benchmark_vnext4" || scenarioSet === "generalization_vnext4" || scenarioSet === "novel_vnext4_3" || scenarioSet === "generalization_vnext4_3_3" || usesLeanPositivePromptContract) {
      assert.equal(captionFrames.length, frames.length, `${testCase.kind}没有为每格写入英文制作说明句`);
      if (!usesLeanPositivePromptContract) assert.ok(packagingMethodLines.length >= 1, `${testCase.kind}没有输出动态包装推导结果`);
    }
    if (scenarioSet === "benchmark_vnext4" || scenarioSet === "generalization_vnext4" || scenarioSet === "novel_vnext4_3" || scenarioSet === "generalization_vnext4_3_3") {
      assert.match(imagePrompt, /亚洲女性|东亚女性/u, `${testCase.kind}未落实默认成年亚洲女性`);
      assert.match(imagePrompt, /视觉母题|母题|贯穿/u, `${testCase.kind}未写出统一视觉母题`);
      assert.match(videoPrompt, /预备|蓄力/u, `${testCase.kind}视频缺少动作预备`);
      assert.match(videoPrompt, /余波|停留|稳定/u, `${testCase.kind}视频缺少余波或清晰停留`);
      assert.match(imagePrompt, /皮克斯式/u, `${testCase.kind}生图未锁定皮克斯式动画风格`);
      assert.match(videoPrompt, /皮克斯式/u, `${testCase.kind}视频未重复皮克斯式动画风格锁`);
    }
    return {
      index: index + 1,
      kind: testCase.kind,
      narration: testCase.copy,
      frameCount: frames.length,
      shotCount: shots.length,
      captionFrameCount: captionFrames.length,
      packagingMethodLineCount: packagingMethodLines.length,
      imagePrompt,
      videoPrompt,
      detected: {
        pets: [...imagePrompt.matchAll(/(?:柯基|金毛|柴犬|比格|贵宾|哈士奇|拉布拉多|边境牧羊犬|边牧|雪纳瑞)/gu)].map((match) => match[0]),
        packagingForms: (imagePrompt.match(/(?:盾牌|天平|跷跷|杠杆|刻度|量杯|进度槽|标尺|阈值|发光牌|警报牌|弹窗|标签|教学标片|轨迹|速度弧|涟漪|光带|声波|示意窗|教学窗|环境变形|场景机关|影子|牵引绳|红绿灯|温度计|肉垫|脚印|镜子|落地镜|放大镜|问号)/gu) || []),
        colors: [...imagePrompt.matchAll(/(?:红|橙|黄|绿|青|蓝|紫|白|黑|灰|棕|金)色/gu)].map((match) => match[0]),
      },
    };
  });

  assert.equal(new Set(results.map((item) => item.imagePrompt)).size, cases.length, "四类语义生图Prompt发生模板复用");
  const history = replayRawFile
    ? { source: "saved-real-platform-output", rawFile: replayRawFile }
    : replayHistory || await waitForHistory(session.token, conversationId, content);
  const suite = {
    passed: true,
    source: replayRawFile ? "saved-real-platform-agent-output" : "real-platform-agent-conversation",
    testedAt: new Date().toISOString(),
    runId,
    conversationId,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model,
    targetDurationSeconds: Number(targetDuration),
    scenarioSet,
    submittedMessage,
    cases: results,
  };
  await writeFile(`.tmp-e2e/${runId}-suite.json`, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
  await writeFile(`.tmp-e2e/${runId}-agent-report.json`, `${JSON.stringify({
    ...suite,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    historyVerified: true,
    history,
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    passed: true,
    runId,
    conversationId,
    agentId: agent.id,
    agentName: agent.name,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    scenarioSet,
    cases: results.map(({ kind, frameCount, shotCount, captionFrameCount, packagingMethodLineCount, detected }) => ({
      kind,
      frameCount,
      shotCount,
      captionFrameCount,
      packagingMethodLineCount,
      detected,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
