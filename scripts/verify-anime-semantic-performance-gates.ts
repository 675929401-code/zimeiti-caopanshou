import assert from "node:assert/strict";
import {
  AiStoryboardPlanSchema,
  auditAiStoryboardPlanUsability,
  estimateStoryboardDuration,
  normalizeStoryboardCharacterIdentities,
} from "../src/lib/canvas-prompt-presets";

const narration = "两只金毛靠近彼此时都很心动。";
const anchor = "双犬互动桃心簇";
const durationSeconds = estimateStoryboardDuration(narration);

function createPlan(overrides: Record<string, string> = {}) {
  const imagePrompt = overrides.imagePrompt || `16:9电影级3D卡通动画，客厅近景，左侧年轻浅金色金毛犬前爪微抬、耳朵向后轻压，右侧成年深金色金毛犬身体前倾、尾巴高频摆动，两犬鼻尖即将碰触；${anchor}悬浮在两只狗之间的中景留白区，三枚柔红半透明立体小桃心沿鼻尖连线形成向上的静态弧形，受右侧暖窗光照亮。前景地毯虚化，中景角色轮廓清楚，背景米白沙发与木质茶几形成空间层次。`;
  const videoPrompt = overrides.videoPrompt || `两只金毛先同时缩短前腿压低重心，随后快速抬头靠近，鼻尖碰触后又略微过冲错开；${anchor}从两犬鼻尖之间轻弹升起并扩大一次，尾巴与耳朵同步反应。镜头低机位缓慢推近，最后两犬并肩停住，桃心稳定悬停一秒。`;
  const effectsPrompt = overrides.effectsPrompt || `【语义重点】两只狗的相互心动必须直接可见【剧情表演】双方先犹豫靠近再鼻尖碰触，尾巴同步加速【叙事道具】客厅地毯与低矮茶几【环境反馈】暖窗光在两犬之间形成柔和亮区【图形特效】${anchor}【语义缺口】恋爱关系无法仅靠靠近动作唯一证明【包装决策】需要【包装类型】environment-feedback【包装锚点】${anchor}【绑定与位置】绑定两犬鼻尖之间的中景留白区【静态初态】三枚柔红立体小桃心形成向上弧线【动态延续】鼻尖碰触时轻弹升起并扩大一次`;
  return AiStoryboardPlanSchema.parse({
    promptContractVersion: "anime-director-v1",
    projectBible: {
      characters: [
        { id: "character-1", name: "年轻浅金色金毛犬", aliases: [], kind: "animal", importance: "primary", fixedAppearance: "年轻浅金色金毛犬，天然四足结构，深棕眼睛，黑色鼻头，蓬松长尾", explicitTraits: [], inferredTraits: [] },
        { id: "character-2", name: "成年深金色金毛犬", aliases: [], kind: "animal", importance: "primary", fixedAppearance: "成年深金色金毛犬，天然四足结构，琥珀眼睛，黑色鼻头，宽厚胸口和蓬松长尾", explicitTraits: [], inferredTraits: [] },
      ],
      characterBible: "两只金毛犬是不同实体，分别锁定浅金和深金毛色、年龄感、眼睛和体型，始终保持天然四足结构。",
      environmentBible: "固定现代温暖家庭客厅，米白沙发靠后墙，木质茶几位于中景右侧，浅色地毯覆盖前景，右侧窗光方向不变。",
      visualBible: "电影级高品质3D卡通动画，柔软可信毛发，经典卡通表演轮廓，暖色电影光，干净构图与清楚景深。",
      packagingBible: "包装采用半透明立体软塑料材质，柔和轮廓光，与场景透视和光照融合，不遮挡角色眼睛和剧情道具。",
      editorialBible: "每镜3至5秒，动作完成后稳定停留，现场音与动作同步，字幕与配音统一后期添加。",
      performanceMode: "comedy",
      performanceBible: "使用预备压缩、主动作过冲、第二反应和稳定收势，夸张服务关系变化，不做随机鬼脸。",
      storyPlan: {
        premise: "两只陌生金毛在客厅试探靠近，最终用鼻尖接触确认彼此好感。",
        protagonistGoal: "两只金毛都想确认对方是否愿意靠近。",
        incitingIncident: "双方隔着地毯发现彼此并同时产生好感。",
        escalation: "双方犹豫压低重心，又被彼此摇尾动作吸引。",
        turningPoint: "两只金毛同时向前并让鼻尖第一次接触。",
        resolution: "双方并肩停住，身体放松并确认彼此接受。",
        beats: [{
          order: 1,
          storyFunction: "payoff",
          event: "两只金毛结束犹豫并同时靠近确认好感。",
          entryState: "两犬分处地毯左右，重心压低且彼此观察。",
          action: "双方同时向前，鼻尖接触后轻微过冲。",
          resultState: "两犬并肩停住，尾巴同步加速摆动。",
          handoffToNext: "以双方并肩和鼻尖连线作为稳定收束。",
        }],
      },
    },
    sourceIssues: [],
    segments: [{
      narration,
      durationSeconds,
      visualShots: [{
        visualMode: "hybrid-packaging",
        durationSeconds,
        shotRole: "reaction",
        transition: "cut",
        castIds: ["character-1", "character-2"],
        visualBeat: "两只金毛犬犹豫靠近后鼻尖碰触，关系从试探变成心动",
        visibleProposition: "双方靠近和同步反应让相互心动直接可见",
        evidenceLevel: "environment_feedback",
        directorDecision: "【可见命题】两只金毛相互心动【角色目标】双方想确认彼此是否接受靠近【阻碍或异常】彼此犹豫不敢先接触【核心动作】同时蓄势靠近并鼻尖碰触后轻微过冲【可见结果】两犬并肩停住且尾巴同步加速【镜头抓手】低机位捕捉鼻尖即将接触的高张力瞬间",
        cameraPlan: "低机位近景沿鼻尖连线缓慢推近，在双方并肩时停止运动并稳定落幅。",
        keyframeMoment: imagePrompt,
        scenePrompt: "现代温暖家庭客厅，米白沙发位于后景，浅色地毯覆盖前景，木质茶几在中景右侧，午后窗光从右侧进入。",
        imagePrompt,
        videoPrompt,
        effectsPrompt,
        motionPrompt: "【入镜】两只金毛分处画面左右，前腿略弯、鼻尖相对【预备】双方同时压低重心并短暂停顿【主动作】快速抬头靠近，鼻尖碰触后轻微过冲【反应】双方耳朵弹起、尾巴同步加速，桃心簇轻弹升起【落幅】两犬并肩停住，视线转向彼此并稳定一秒",
        soundPrompt: "爪垫摩擦地毯声、尾巴扫过地毯的轻响和柔和室内环境声",
        editPrompt: "保留同步蓄势、鼻尖碰触与并肩稳定落幅，在动作停稳后切下一镜。",
        qualityCriteria: "出现说话口型、缺少蓄势或过冲、双犬身份混淆、桃心锚点未同时出现在参考图与视频时必须重生成。",
      }],
    }],
  });
}

const passingIssues = auditAiStoryboardPlanUsability(narration, createPlan(), { requireMotionChain: true, requireFinalPrompts: true });
assert.deepEqual(passingIssues, [], `合格关系包装镜头被误拒：${passingIssues.join("；")}`);
const distinctDogs = normalizeStoryboardCharacterIdentities(createPlan().projectBible!.characters, narration);
assert.equal(distinctDogs.characters.length, 2, "两只同品种但有不同稳定识别点的金毛被错误合并");
assert.notEqual(distinctDogs.characters[0]?.name, distinctDogs.characters[1]?.name, "两只金毛的可区分名称被具体化逻辑抹掉");

const speechIssues = auditAiStoryboardPlanUsability(narration, createPlan({
  videoPrompt: `两只金毛先靠近，随后成年中国女性主人面对镜头开口说话并反复张嘴讲解。镜头缓慢推近，最后稳定停留。${anchor}轻弹升起。`,
}), { requireMotionChain: true, requireFinalPrompts: true });
assert.ok(speechIssues.some((issue) => issue.includes("说话") || issue.includes("口型")), "人物说话口型没有被门禁拒绝");

const missingAnchorIssues = auditAiStoryboardPlanUsability(narration, createPlan({
  videoPrompt: "两只金毛先压低重心，随后快速靠近并鼻尖碰触，尾巴同步摆动。镜头低机位推近，最后并肩停住并稳定停留一秒。",
}), { requireMotionChain: true, requireFinalPrompts: true });
assert.ok(missingAnchorIssues.some((issue) => issue.includes("包装锚点")), "包装锚点未进入视频没有被门禁拒绝");

const mechanismNarration = "狗狗肠道堵塞时会越来越难受。";
const wrongMechanismPlan = createPlan();
wrongMechanismPlan.segments[0].narration = mechanismNarration;
wrongMechanismPlan.segments[0].durationSeconds = estimateStoryboardDuration(mechanismNarration);
wrongMechanismPlan.segments[0].visualShots[0].durationSeconds = estimateStoryboardDuration(mechanismNarration);
const mechanismIssues = auditAiStoryboardPlanUsability(mechanismNarration, wrongMechanismPlan, { requireMotionChain: true, requireFinalPrompts: true });
assert.ok(mechanismIssues.some((issue) => issue.includes("local-inset")), "肠道机理未使用局部教学窗没有被门禁拒绝");

console.log(JSON.stringify({
  passing: passingIssues.length === 0,
  distinctDogAssets: distinctDogs.characters.map((character) => ({ id: character.id, name: character.name })),
  speechRejected: speechIssues,
  missingAnchorRejected: missingAnchorIssues,
  wrongMechanismRejected: mechanismIssues,
}, null, 2));
