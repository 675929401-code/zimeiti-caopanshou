import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const agentName = process.env.EXPECTED_AGENT_NAME?.trim() || "3D故事导演｜电影叙事";
const expectedSchema = process.env.EXPECTED_SCHEMA?.trim() || "storyboard_director_output_style.v4.0.9";
const expectedPromptSha = process.env.EXPECTED_PROMPT_SHA?.trim() || "09b827d84d8de2c5e01ab98c8570d748676768ced60bdd32c2e050925278faee";
const replayConversationId = process.env.REPLAY_CONVERSATION_ID?.trim() || "";
const reviewId = process.env.REVIEW_ID?.trim() || "voiceover-cinematic-random-two-segments-v409-fullchain-pro2k-omni10-20260817";
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);

const defaultNarrations = [
  "狗狗一看到饭盆就狼吞虎咽，几十秒把整碗吃光。吞得太急会带进很多空气，胃部迅速鼓胀，吃完后它会弓背、干呕。",
  "狗狗独自在家时，听见门外钥匙声会立刻竖起耳朵。确认是主人回来后，它才叼起最喜欢的玩具冲向门口，尾巴摇个不停。",
] as const;
const narrations = process.env.TEST_NARRATIONS_JSON?.trim()
  ? JSON.parse(process.env.TEST_NARRATIONS_JSON) as [string, string]
  : [...defaultNarrations] as [string, string];
assert.equal(narrations.length, 2, "测试必须恰好包含两段口播");

type PresetField = { id: string; label?: string; sendLabel?: boolean; sendText?: string; order?: number };
type AgentRecord = {
  id: string;
  name: string;
  model: string;
  system_prompt?: string;
  output_style?: Record<string, unknown>;
  preset_fields?: PresetField[];
};
type Segment = {
  number: number;
  narration: string;
  panelCount: number;
  imagePrompt: string;
  videoPrompt: string;
  shotCount: number;
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson<T extends Record<string, unknown> = Record<string, unknown>>(response: Response): Promise<T> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    return { error: `non-JSON response (${response.status}): ${raw.slice(0, 500)}` } as unknown as T;
  }
}

async function requestJson<T extends Record<string, unknown>>(url: string, token: string) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { response, data: await readJson<T>(response) };
}

function buildMessage(fields: PresetField[]) {
  const numbered = narrations.map((value, index) => `${index + 1}.【${value}】`).join("\n");
  const values: Record<string, string> = {
    segmented_script: numbered,
    animation_style: "默认皮克斯式高端商业3D动画",
    aspect_ratio: "16:9",
    target_duration_seconds: "10",
    special_notes: "",
  };
  const message = [...fields]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .flatMap((field) => {
      const value = values[field.id]?.trim();
      if (!value) return [];
      return field.sendLabel === false ? [value] : [`${field.sendText || field.label || field.id}：${value}`];
    })
    .join("\n");
  narrations.forEach((value, index) => assert.ok(message.includes(`${index + 1}.【${value}】`), `第${index + 1}段未原样送入`));
  return message;
}

async function readStream(response: Response) {
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
  assert.ok(doneEvent, "模型流在[DONE]前结束");
  return content;
}

function parse(raw: string): Segment[] {
  const heading = /^\*\*原文案内容段落\s*(\d+)\*\*：([^\r\n]+)\r?$/gmu;
  const headings = [...raw.matchAll(heading)];
  assert.equal(headings.length, 2, `原文标题应为2个，实际${headings.length}个`);
  assert.equal([...raw.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)].length, 4, "平台输出不是4个text代码框");
  return headings.map((match, index) => {
    const number = Number(match[1]);
    const narration = match[2].trim().replace(/^【|】$/gu, "");
    const start = (match.index || 0) + match[0].length;
    const end = headings[index + 1]?.index ?? raw.length;
    const section = raw.slice(start, end);
    const blocks = [...section.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)].map((item) => item[1].trim());
    const panelMatch = section.match(/故事板分镜图文生图 Prompt（共(4)格）/u);
    assert.equal(number, index + 1, `段落编号错位：${number}`);
    assert.equal(narration, narrations[index], `第${number}段原文被改写`);
    assert.ok(panelMatch, `第${number}段缺少4/5格标题`);
    assert.equal(blocks.length, 2, `第${number}段不是两个代码框`);
    const [imagePrompt, videoPrompt] = blocks;
    const chineseFrames = [...new Set([...imagePrompt.matchAll(/第([一二三四])格/gu)].map((item) => "一二三四".indexOf(item[1]) + 1))];
    const englishFrames = [...new Set([...imagePrompt.matchAll(/Frame\s*([1-4])\s*(?!:)/giu)].map((item) => Number(item[1])))];
    const quadrantFrames = ["左上格", "右上格", "左下格", "右下格"].filter((label) => imagePrompt.includes(label));
    const frames = chineseFrames.length ? chineseFrames : englishFrames.length ? englishFrames : quadrantFrames;
    const shotLabels = [...new Set([...videoPrompt.matchAll(/镜(?:头)?\s*([1-4])/gu)].map((item) => Number(item[1])))];
    const timeRanges = [...videoPrompt.matchAll(/\d+(?:\.\d+)?\s*[-—–至]\s*\d+(?:\.\d+)?\s*秒/gu)];
    const shotCount = shotLabels.length || timeRanges.length;
    assert.equal(frames.length, Number(panelMatch[1]), `第${number}段Frame数量不匹配`);
    assert.ok(shotCount >= 2 && shotCount <= 3, `第${number}段不是10秒2至3镜`);
    assert.match(imagePrompt, /雾蓝[^。；\n]{0,36}(?:夹克|外套)/u, `第${number}段现代雾蓝外套未锁定`);
    assert.match(imagePrompt, /深炭灰[^。；\n]{0,24}(?:直筒裤|长裤)/u, `第${number}段现代直筒裤未锁定`);
    assert.match(imagePrompt, /白灰[^。；\n]{0,24}(?:运动鞋|鞋)/u, `第${number}段现代鞋履未锁定`);
    assert.doesNotMatch(imagePrompt, /黄色[^。；\n]{0,28}(?:卫衣|连帽衫)/u, `第${number}段仍在使用黄色卫衣`);
    assert.match(imagePrompt, /柯基/u, `第${number}段犬种未锁定`);
    assert.match(imagePrompt, /头顶[^。；\n]{0,32}鞋底|从头[^。；\n]{0,32}鞋|(?:人物|女人|女性|主人|两者|女人与柯基均)[^。；\n]{0,32}(?:全身|身体|完整入框|完整可见)[^。；\n]{0,12}(?:完整|安全边距|入框|可见)?/u, `第${number}段缺少人物完整入框`);
    assert.match(imagePrompt, /耳尖[^。；\n]{0,38}(?:四爪|尾端)|四爪[^。；\n]{0,38}尾|(?:柯基|宠物|犬只|人物和狗|两者|女人与柯基均)[^。；\n]{0,32}(?:全身|身体|完整入框|完整可见)[^。；\n]{0,12}(?:完整|安全边距|入框|可见)?/u, `第${number}段缺少狗完整入框`);
    assert.match(imagePrompt, /(?:零文字|无任何文字|绝对无文字|绝对无中文|不出现中文、英文|纯净无字)/u, `第${number}段缺少图内零文字约束`);
    assert.doesNotMatch(imagePrompt, /英文说明条\s*[：:]|Frame\s*[1-4]\s*:/u, `第${number}段仍要求绘制英文说明条`);
    assert.match(imagePrompt, /(?:织纹|缝线|粗糙度|底绒|护毛|中性白平衡|蓝灰)/u, `第${number}段材质灯光描述仍过于空泛`);
    assert.match(videoPrompt, /秒[｜|]/u, `第${number}段视频缺少语义拍点时间标题`);
    assert.doesNotMatch(videoPrompt, /口播锚点|对应口播|原始分段口播/u, `第${number}段仍把原文当作视频执行指令`);
    assert.ok(!videoPrompt.includes(narration), `第${number}段视频Prompt仍复制了整段原文`);
    assert.doesNotMatch(`${imagePrompt}\n${videoPrompt}`, /过肩|体态测量环|健康站|检测舱|扫描舱|全息/u, `第${number}段仍有复制人物或概念装置诱因`);
    assert.doesNotMatch(`${imagePrompt}\n${videoPrompt}`, /(?:依附|挂在|借助|通过|看向)[^。；\n]{0,24}(?:镜子|镜面|玻璃|橱窗|倒影|反射)|(?:镜子|镜面|玻璃|橱窗|倒影|反射)[^。；\n]{0,24}(?:显示|呈现|承载|出现)/u, `第${number}段仍把包装挂到反射面`);
    assert.doesNotMatch(`${imagePrompt}\n${videoPrompt}`, /(?:镜子|镜面|弧面|金属反光|玻璃|橱窗|倒影|反射|照片|手机|电视|屏幕)[^。；\n]{0,45}(?:胖|瘦|圆胖|圆滚|对照|比较|变形)/u, `第${number}段仍用镜面或屏幕制造语义对照`);
    assert.doesNotMatch(`${imagePrompt}\n${videoPrompt}`, /Too\s*thin|过瘦\?|太瘦\?|短标签|话语贴纸|信息层[“"][^”"]{2,}|中文短牌/u, `第${number}段仍生成非必要场景文字`);
    assert.doesNotMatch(`${imagePrompt}\n${videoPrompt}`, /(?:手指|手掌|目光|眼神)[^。；\n]{0,28}(?:射出|发射|生成|召唤|扫出)[^。；\n]{0,16}(?:光束|激光|能量|扫描)/u, `第${number}段仍把手势或视线演成施法`);
    return { number, narration, panelCount: Number(panelMatch[1]), imagePrompt, videoPrompt, shotCount };
  });
}

function semanticGate(segments: Segment[]) {
  const first = `${segments[0].imagePrompt}\n${segments[0].videoPrompt}`;
  const second = `${segments[1].imagePrompt}\n${segments[1].videoPrompt}`;
  const secondVisible = second;
  const firstNarration = narrations[0];
  const secondNarration = narrations[1];
  const matchIndex = (value: string, pattern: RegExp) => value.search(pattern);
  const firstVideo = segments[0].videoPrompt;
  const firstPositive = first.replace(/(?:不出现|禁止|绝不出现)[^。\n]*。/gu, "");
  const secondPositive = second.replace(/(?:不出现|禁止|绝不出现)[^。\n]*。/gu, "");
  const firstEatIndex = matchIndex(firstVideo, /(?:快速|迅速|急促|大口|连续|狼吞虎咽)[^。；\n]{0,30}(?:吃|吞|进食)|(?:吃|吞|进食)[^。；\n]{0,30}(?:快速|迅速|急促|大口|连续|狼吞虎咽)/u);
  const firstStomachIndex = matchIndex(firstVideo, /(?:胃|腹部|肚子)[^。；\n]{0,50}(?:胀|不适|起伏|紧绷|难受)|(?:胀|不适|紧绷|难受)[^。；\n]{0,40}(?:胃|腹部|肚子)/u);
  const firstRetchIndex = matchIndex(firstVideo, /干呕|弓背[^。；\n]{0,20}(?:咳|呕)|作呕/u);
  const secondSleepIndex = matchIndex(segments[1].videoPrompt, /睡|闭眼|趴卧|呼吸平稳/u);
  const secondTwitchIndex = matchIndex(segments[1].videoPrompt, /蹬腿|抖耳|耳朵抖|抽动|轻哼/u);
  const secondDreamIndex = matchIndex(segments[1].videoPrompt, /梦境|梦中|梦泡|想象层|追球|球滚/u);
  const secondKeyIndex = matchIndex(segments[1].videoPrompt, /钥匙|门锁|锁芯/u);
  const secondEarIndex = matchIndex(segments[1].videoPrompt, /竖起耳朵|竖直双耳|双耳[^。；\n]{0,24}(?:竖|转向|前倾)|耳朵[^。；\n]{0,24}(?:竖|转向|前倾)/u);
  const secondOwnerIndex = matchIndex(segments[1].videoPrompt, /确认[^。；\n]{0,40}主人|主人[^。；\n]{0,40}(?:出现|回来|进门|推门|跨入|进入)/u);
  const secondToyIndex = matchIndex(segments[1].videoPrompt, /叼起|咬住[^。；\n]{0,16}(?:玩具|球)|(?:玩具|球)[^。；\n]{0,16}(?:叼|咬)/u);
  const secondDoorRunOffset = secondToyIndex >= 0
    ? matchIndex(segments[1].videoPrompt.slice(secondToyIndex), /(?:柯基|它|四足)[^。；\n]{0,36}(?:向门口|向玄关|向主人)[^。；\n]{0,20}(?:奔跑|跑|冲)|(?:向门口|向玄关|向主人)[^。；\n]{0,24}(?:奔跑|跑|冲)/u)
    : -1;
  const secondDoorRunIndex = secondDoorRunOffset >= 0 ? secondToyIndex + secondDoorRunOffset : -1;
  const treatThrowIndex = matchIndex(firstVideo, /(?:扔|抛|掷)[^。；\n]{0,24}零食|零食[^。；\n]{0,24}(?:扔|抛|掷)/u);
  const dogMotionOffset = treatThrowIndex >= 0
    ? matchIndex(firstVideo.slice(treatThrowIndex), /(?:柯基|狗)[^。；\n]{0,120}(?:跑|转身|冲|扑|追|离开门槛|远离门口)|(?:跑|转身|冲|扑|追|离开门槛|远离门口)[^。；\n]{0,80}(?:柯基|狗)/u)
    : -1;
  const dogLeavesDoorIndex = dogMotionOffset >= 0 ? treatThrowIndex + dogMotionOffset : -1;
  const doorCloseIndex = matchIndex(firstVideo, /(?:关上|关闭|合拢|带上|闭合)[^。；\n]{0,12}(?:房门|入户门|门)|(?:房门|入户门|门)[^。；\n]{0,18}(?:关上|关闭|合拢|闭合)/u);
  const checks = {
    firstQuestionAndAnswer: !/胖点好还是瘦点好|瘦点好/u.test(firstNarration) || /健康匀称|自然腰线|体况证据|匀称体态/u.test(first),
    firstProverb: !/千金难买老来瘦/u.test(firstNarration) || /健康选择|体况证据|健康匀称|自然步态/u.test(first),
    firstWalkAndSocialPressure: !/遛狗|最怕听到/u.test(firstNarration) || (/遛狗|步道|公园|牵引绳/u.test(first) && /最怕听到|侧目|议论|评价|评论/u.test(first)),
    secondThinMisunderstanding: !/这么瘦|舍不得|虐待/u.test(secondNarration) || /这么瘦|舍不得|虐待|误解/u.test(second),
    secondFatCuteButUnhealthy: !/胖的可爱|太胖|不叫养的好/u.test(secondNarration) || (/(?:胖[^。；\n]{0,20}可爱|圆胖偏好|可爱偏好|圆润[^。；\n]{0,28}心形)/u.test(second) && /太胖|不叫养的好|健康|沉重|过量|过满/u.test(second)),
    secondFatAestheticHasVisibleEvidence: !/审美|胖的可爱/u.test(secondNarration) || /偏好诱因|圆胖偏好|可爱偏好|圆润[^。；\n]{0,28}心形|柔和眼神[^。；\n]{0,40}宽圆轮廓/u.test(secondVisible),
    secondOverweightJudgmentHasVisibleEvidence: !/太胖|养猪|按斤/u.test(secondNarration) || /过量风险|适量照顾|巨大[^。；\n]{0,18}(?:食盆|饭盆)|猪形[^。；\n]{0,12}(?:储蓄罐|摆件)|(?:过满|过量|满满)[^。；\n]{0,24}(?:食盆|饭盆)[^。；\n]{0,40}(?:秤|称重)|(?:食盆|饭盆)[^。；\n]{0,30}(?:压住|压低|占据)[^。；\n]{0,18}(?:秤|秤面)/u.test(secondVisible),
    performanceEvidence: segments.every((segment) => /视线|眼神|眼睑|眨眼/u.test(`${segment.imagePrompt}\n${segment.videoPrompt}`)
      && /耳朵|双耳/u.test(`${segment.imagePrompt}\n${segment.videoPrompt}`)
      && /口鼻|嘴角|呼吸|鼻息/u.test(`${segment.imagePrompt}\n${segment.videoPrompt}`)
      && /重心|前爪|四爪|尾根|尾巴/u.test(`${segment.imagePrompt}\n${segment.videoPrompt}`)),
    physicalContinuity: segments.every((segment) => /连续|跟随|惯性|重心|稳定|落幅|匹配切|匹配转场|落点切|横移带出|跟跑|掠过镜头/u.test(segment.videoPrompt)),
    noMagicPerformance: segments.every((segment) => !/(?:手指|手掌|目光|眼神)[^。；\n]{0,28}(?:射出|发射|生成|召唤|扫出)[^。；\n]{0,16}(?:光束|激光|能量|扫描)/u.test(`${segment.imagePrompt}\n${segment.videoPrompt}`)),
    cleanTextFreeReference: segments.every((segment) => /(?:零文字|无任何文字|绝对无文字|绝对无中文|不出现中文、英文|纯净无字)/u.test(segment.imagePrompt)
      && !/英文说明条\s*[：:]|Frame\s*[1-4]\s*:/u.test(segment.imagePrompt)),
    fullBodySafeFraming: segments.every((segment) => (/(?:人物|女人|女性|主人|两者|女人与柯基均)[^。；\n]{0,32}(?:全身|身体|完整入框|完整可见)|头顶[^。；\n]{0,32}鞋底|从头[^。；\n]{0,32}鞋|(?:人物|主人)[^。；\n]{0,20}(?:不入镜|画外|不出现)/u.test(segment.imagePrompt))
      && /耳尖[^。；\n]{0,38}(?:四爪|尾端)|四爪[^。；\n]{0,38}尾|(?:柯基|宠物|犬只|人物和狗|两者|女人与柯基均)[^。；\n]{0,32}(?:全身|身体|完整入框|完整可见)/u.test(segment.imagePrompt)),
    modernWardrobe: segments.every((segment) => /雾蓝[^。；\n]{0,36}(?:夹克|外套)/u.test(segment.imagePrompt)
      && !/黄色[^。；\n]{0,28}(?:卫衣|连帽衫)/u.test(segment.imagePrompt)),
    noReflectiveSemanticShortcut: segments.every((segment) => !/(?:镜子|镜面|弧面|金属反光|玻璃|橱窗|倒影|反射|照片|手机|电视|屏幕)[^。；\n]{0,45}(?:胖|瘦|圆胖|圆滚|对照|比较|变形)/u.test(`${segment.imagePrompt}\n${segment.videoPrompt}`)),
    executableVideoOnly: segments.every((segment) => !/口播锚点|对应口播|原始分段口播/u.test(segment.videoPrompt)
      && !segment.videoPrompt.includes(segment.narration)),
    firstSnackDoorScene: !/零食|关上房门|出门/u.test(firstNarration) || (/住宅玄关|入户玄关|玄关/u.test(first)
      && /零食/u.test(first)
      && /(?:扔|抛|掷)/u.test(first)
      && /(?:同一扇|唯一一扇|不复制)[^。；\n]{0,18}(?:房门|入户门|门)/u.test(first)),
    firstSnackDoorCausalOrder: !/零食|关上房门|出门/u.test(firstNarration) || (treatThrowIndex >= 0
      && dogLeavesDoorIndex >= treatThrowIndex
      && doorCloseIndex > dogLeavesDoorIndex
      && /(?:屋内|客厅|远离门口|远离门缝|离开门槛)[^。；\n]{0,36}(?:柯基|狗)|(?:柯基|狗)[^。；\n]{0,36}(?:屋内|客厅|远离门口|远离门缝|离开门槛)/u.test(firstVideo)),
    secondTopDownBodyCheck: !/俯视|腰线|肋骨/u.test(secondNarration) || (/俯视|顶视/u.test(second)
      && /腰线|腹线|凹凸有致/u.test(second)
      && /肋骨|肋部/u.test(second)
      && /(?:手|手指|手掌)[^。；\n]{0,30}(?:轻触|触摸|滑过|沿|摸)/u.test(second)),
    semanticSceneDiversity: !/零食|关上房门/u.test(firstNarration) || !/俯视|肋骨/u.test(secondNarration) || (/玄关/u.test(first)
      && /(?:家居检查区|家庭餐厨连接区|餐厨连接区|客厅地毯|客厅检查垫|诊室地面|检查垫|室内)/u.test(second)
      && !/延续上一段[^。；\n]{0,24}玄关|同一[^。；\n]{0,18}玄关/u.test(second)),
    independentPropsDoNotRepeat: !/零食|关上房门/u.test(firstNarration) || !/俯视|肋骨/u.test(secondNarration) || (!/零食/u.test(secondPositive)
      && !/入户门|房门/u.test(secondPositive)
      && !/软尺|检查垫|肋骨/u.test(first)),
    singleMovingPropConservation: !/零食/u.test(firstNarration) || /(?:单颗|一颗)[^。；\n]{0,36}(?:只出现一次|只有一个|唯一|不复制|不得复制)|(?:零食|道具)[^。；\n]{0,30}(?:不复制|不得复制|无重影|只出现一次)/u.test(first),
    resultPanelReleasesTouch: !/俯视|肋骨/u.test(secondNarration) || /右下格[ \s\S]{0,650}(?:手|双手|手掌|手指)[^。；\n]{0,24}(?:已完全离开|已离开|离开狗|不再接触|收回到|已收回|完全松开|悬空)/u.test(segments[1].imagePrompt),
    featureAnimationNotPhotoreal: segments.every((segment) => /(?:风格化家庭动画电影角色[^。；\n]{0,24}非真人广告摄影|动画电影面部|动画化提炼|不得生成真人广告|不做真人写实|非真人写实)/u.test(segment.imagePrompt)),
    fastEatingUsesHomeFeedingScene: !/吃饭太快|胃里|干呕/u.test(firstNarration) || (/(?:喂食区|餐厨|厨房|食盆区)/u.test(first)
      && /(?:食盆|饭盆|狗粮)/u.test(first)
      && /(?:快速|迅速|急促|大口|狼吞虎咽|吞咽|进食)/u.test(first)),
    fastEatingCausalOrder: !/吃饭太快|胃里|干呕/u.test(firstNarration) || (firstEatIndex >= 0
      && firstStomachIndex > firstEatIndex
      && firstRetchIndex > firstStomachIndex),
    stomachMechanismFriendlyAndAligned: !/胃里|胃部/u.test(firstNarration) || (/(?:非血腥|友好|柔和)[^。；\n]{0,50}(?:胃|腹部|示意|插图)|(?:胃|腹部)[^。；\n]{0,50}(?:非血腥|友好|柔和|局部示意|插图)/u.test(first)
      && !/鲜血|开膛|手术切口|血腥器官/u.test(first)),
    stomachMechanismOutsideIntactDog: !/胃里|胃部/u.test(firstNarration) || (/(?:犬体旁|狗身旁|身体旁|画面空白区|独立)[^。；\n]{0,50}(?:科普|插图|示意层)|(?:科普|插图|示意层)[^。；\n]{0,50}(?:犬体旁|狗身旁|身体旁|空白区|独立)/u.test(first)
      && /(?:毛皮|皮肤|犬体|狗身体)[^。；\n]{0,36}(?:完整|不透明|不切开|不剖开)|(?:不切开|不剖开|不开洞|不透明)[^。；\n]{0,36}(?:犬体|狗|毛皮|皮肤)/u.test(first)),
    dreamUsesBedroomSleepScene: !/睡着|做梦|蹬腿/u.test(secondNarration) || (/(?:卧室|床边|睡眠角|犬窝|睡垫)/u.test(second)
      && /(?:睡|闭眼|趴卧)/u.test(second)
      && /(?:蹬腿|抖耳|耳朵抖|抽动|轻哼)/u.test(second)
      && /(?:梦境|梦中|梦泡|想象层)/u.test(second)
      && /球/u.test(second)),
    dreamCausalOrder: !/睡着|做梦|蹬腿/u.test(secondNarration) || (secondSleepIndex >= 0
      && secondTwitchIndex > secondSleepIndex
      && secondDreamIndex > secondTwitchIndex),
    randomScenesAreDistinctAndIndoor: !/吃饭太快|睡着/u.test(`${firstNarration}\n${secondNarration}`) || (/(?:喂食区|餐厨|厨房|食盆区)/u.test(first)
      && /(?:卧室|床边|睡眠角|犬窝|睡垫)/u.test(second)
      && !/(?:户外步道|社区公园|草坪遛狗)/u.test(`${firstPositive}\n${secondPositive}`)),
    ownerReturnUsesHomeEntryScene: !/独自在家|钥匙声|主人回来/u.test(secondNarration) || (/(?:玄关|门厅|客厅靠近入户门|住宅入户门|门口)/u.test(second)
      && /(?:钥匙|门锁|锁芯)/u.test(second)
      && /(?:玩具|球)/u.test(second)
      && /(?:竖起耳朵|双耳[^。；\n]{0,28}(?:竖|转向|前倾))/u.test(second)),
    ownerReturnCausalOrder: !/独自在家|钥匙声|主人回来/u.test(secondNarration) || (secondKeyIndex >= 0
      && secondEarIndex >= secondKeyIndex
      && secondOwnerIndex > secondEarIndex
      && secondToyIndex > secondOwnerIndex
      && secondDoorRunIndex >= secondToyIndex),
    newTopicsUseDifferentIndoorScenes: !/饭盆|钥匙声/u.test(`${firstNarration}\n${secondNarration}`) || (/(?:喂食区|餐厨|厨房|食盆区)/u.test(first)
      && /(?:玄关|门厅|客厅靠近入户门|住宅入户门|门口)/u.test(second)
      && !/(?:户外步道|社区公园|草坪遛狗)/u.test(`${firstPositive}\n${secondPositive}`)),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

async function waitForHistory(token: string, conversationId: string, userContent: string, assistantContent: string) {
  const deadline = Date.now() + 90_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      latest = await response.json();
      const messages = (latest as { conversation?: { messages?: Array<{ role?: string; content?: string }> } }).conversation?.messages || [];
      if (messages.some((item) => item.role === "user" && item.content === userContent)
        && messages.some((item) => item.role === "assistant" && item.content === assistantContent)) return latest;
    }
    await sleep(1_500);
  }
  throw new Error(`平台历史未逐字落库：${JSON.stringify(latest)}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(reviewPath), { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const session = await readJson<{ token?: string; user?: { id?: string }; error?: string }>(sessionResponse);
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");
  const token = String(session.token);

  const admin = await requestJson<{ agents?: AgentRecord[]; error?: string }>(`${baseUrl}/api/admin/agents`, token);
  assert.ok(admin.response.ok, admin.data.error || "线上智能体读取失败");
  const online = admin.data.agents?.find((item: AgentRecord) => item.id === agentId) as AgentRecord | undefined;
  assert.ok(online?.system_prompt && online.name === agentName, "线上电影级口播智能体不存在");
  assert.equal(sha256(online.system_prompt), expectedPromptSha, "线上 Prompt SHA不符");
  assert.equal(online.output_style?.schema_version, expectedSchema, "线上 schema不符");
  assert.equal(online.output_style?.free_canvas_coupling, false, "电影级口播意外耦合自由画布");

  const bots = await requestJson<{ bots?: AgentRecord[]; error?: string }>(`${baseUrl}/api/bots?voiceover_cinematic_test=${Date.now()}`, token);
  assert.ok(bots.response.ok, bots.data.error || "主站智能体列表读取失败");
  const agent = bots.data.bots?.find((item: AgentRecord) => item.id === agentId && item.name === agentName) as AgentRecord | undefined;
  assert.ok(agent, "主站未读取到电影级口播智能体");
  const submittedMessage = buildMessage(agent.preset_fields || []);
  const conversationId = replayConversationId
    || `conv_voiceover_cinematic_random_two_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let history: unknown;
  let raw = "";
  if (replayConversationId) {
    const replay = await requestJson<{ conversation?: { messages?: Array<{ role?: string; content?: string }> }; error?: string }>(
      `${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`,
      token,
    );
    assert.ok(replay.response.ok, replay.data.error || "平台历史恢复失败");
    const messages = replay.data.conversation?.messages || [];
    assert.ok(messages.some((item) => item.role === "user" && item.content === submittedMessage), "恢复历史中的输入不一致");
    raw = [...messages].reverse().find((item) => item.role === "assistant")?.content || "";
    assert.ok(raw, "恢复历史缺少assistant输出");
    history = replay.data;
  } else {
    const llmResponse = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: submittedMessage }],
        model: agent.model,
        stream: true,
        userId: session.user.id,
        agentName,
        agentId,
        conversationId,
        maxContextRounds: 0,
        maxReplyTokens: 24_000,
        timeout: 720,
        enableWebSearch: false,
        responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(720_000),
    });
    assert.ok(llmResponse.ok, `平台智能体调用失败（${llmResponse.status}）`);
    raw = llmResponse.headers.get("content-type")?.includes("text/event-stream")
      ? await readStream(llmResponse)
      : String((await readJson<{ choices?: Array<{ message?: { content?: string } }> }>(llmResponse)).choices?.[0]?.message?.content || "");
  }
  await writeFile(path.join(outDir, "platform-agent-raw-4-code-blocks.md"), raw, "utf8");
  const segments = parse(raw);
  const gate = semanticGate(segments);
  assert.ok(gate.passed, `电影级口播语义门禁未通过：${JSON.stringify(gate.checks)}`);
  history ||= await waitForHistory(token, conversationId, submittedMessage, raw);

  await writeFile(path.join(outDir, "original-4-code-blocks.json"), `${JSON.stringify({
    conversationId,
    agentId,
    agentName,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    submittedMessage,
    narrations,
    segments,
    semanticGate: gate,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "platform-history.json"), `${JSON.stringify(history, null, 2)}\n`, "utf8");

  const now = Date.now();
  const review = {
    reviewId,
    status: "PROMPT_GATE_COMPLETE_NO_PAID_MEDIA",
    createdAt: new Date().toISOString(),
    conversationId,
    agentId,
    agentName,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    submittedMessage,
    narrations,
    semanticGate: gate,
    actualCost: { agentCalls: 1, imageSubmissions: 0, videoSubmissions: 0, paidRetries: 0, businessPriceCny: 0 },
    evidence: {
      rawPath: path.join(outDir, "platform-agent-raw-4-code-blocks.md"),
      blocksPath: path.join(outDir, "original-4-code-blocks.json"),
      historyPath: path.join(outDir, "platform-history.json"),
    },
    run: {
      id: `${reviewId}-run`,
      createdAt: now,
      updatedAt: now,
      ratio: "16:9",
      panelMode: "auto",
      imageResolution: "2K",
      videoResolution: "1080p",
      videoDuration: 10,
      imageModelId: "pm_HabdJ5rvD_L3-HUkfMUmGsrm",
      videoModelId: "omni-flash-10s-720p-ch3",
      title: `电影级口播${expectedSchema.split(".").slice(-3).join(".")}｜陌生文案两段｜Prompt门禁`,
      cards: segments.map((segment) => ({
        id: `${reviewId}-card-${segment.number}`,
        order: segment.number,
        label: `第${segment.number}段｜${segment.narration}`,
        narration: segment.narration,
        imagePrompt: segment.imagePrompt,
        videoPrompt: segment.videoPrompt,
        referenceImageUrls: [],
        imageStatus: "idle",
        videoStatus: "idle",
        videoError: "Prompt门禁已通过；尚未提交任何付费图片或视频",
      })),
    },
  };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1100 } });
    await context.addInitScript((authToken) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.removeItem("storyboard_prompt_workbench_current_v2");
      localStorage.removeItem("storyboard_prompt_workbench_history_v2");
    }, token);
    const page = await context.newPage();
    const response = await page.goto(`${baseUrl}/storyboard-workbench?review=${reviewId}`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `review页面打开失败（${response?.status()}）`);
    await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(".sbw-shot-card").count(), 2);
    assert.ok(await page.getByText(`电影级口播${expectedSchema.split(".").slice(-3).join(".")}｜陌生文案两段｜Prompt门禁`).count() >= 1);
    await page.screenshot({ path: path.join(outDir, "review-page.png"), fullPage: true });
  } finally {
    await browser.close();
  }

  await unlink(path.join(outDir, "fatal-error.json")).catch(() => {});

  console.log(JSON.stringify({
    passed: true,
    conversationId,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    semanticGate: gate,
    shotCounts: segments.map((segment) => segment.shotCount),
    imageSubmissions: 0,
    videoSubmissions: 0,
    paidRetries: 0,
    businessPriceCny: 0,
  }, null, 2));
}

main().catch(async (error) => {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const failure = {
    passed: false,
    at: new Date().toISOString(),
    error: error instanceof Error ? error.stack || error.message : JSON.stringify(error),
    imageSubmissions: 0,
    videoSubmissions: 0,
    paidRetries: 0,
  };
  await writeFile(path.join(outDir, "fatal-error.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
