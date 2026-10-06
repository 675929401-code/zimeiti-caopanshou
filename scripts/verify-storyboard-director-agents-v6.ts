import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STORYBOARD_3D_STYLES,
  STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_PRESET_FIELDS,
  normalizeStoryboardDirectorInput,
  estimateNarrationDuration,
  narrationExceedsGenerationUnit,
  parseSegmentedScript,
  parseStoryboardDirectorPackage,
  renderStoryboardDirectorPackage,
  validateStoryboardDirectorPackage,
  type StoryboardDirectorInput,
  type StoryboardDirectorMode,
  type StoryboardDirectorPackage,
} from "../src/lib/storyboard-director-protocol";

const TEST_SCRIPT = [
  "1.【很多主人急着出门时，会把一颗零食扔进屋里，趁金毛兴奋追过去的瞬间关门。这个动作在人看来只是省时间，狗狗却会突然回头，发现门外已经没有熟悉的脚步声。】",
  "2.【下一次零食袋刚发出沙沙声，金毛先向前迈一步，又把爪子缩回去。它盯着主人手里的零食，尾巴想摇却慢慢垂下，因为奖励已经和离开在记忆里绑在了一起。】",
  "3.【反复紧张还会影响狗狗的消化状态。它并不是故意挑食，而是压力让胃口和肠道节律变乱。这里需要让观众看懂身体机制，但画面必须温和，不能展示令人不适的解剖。】",
  "4.【后来只要主人拿包、换鞋，甚至从沙发起身，金毛都会立刻跟上。它在门口来回踱步，耳朵向后贴，胸口起伏越来越快，生怕又被一个小动作留在家里。】",
  "5.【更好的做法是平静告别，留下熟悉气味的玩具，再按约定时间回来。金毛会从守门转为嗅闻玩具，最后在听见钥匙声时抬起耳朵，重新相信离开后还会重逢。】",
].join("\n");

const CHARACTER_ASSETS = [
  "一只2岁成年金毛寻回犬，蜂蜜金长毛，中大型匀称四足体型，深棕眼睛，左耳尖有一小撮浅金毛",
  "明确成年的30岁中国女性，成熟面部比例，深棕高马尾，中等身材，雾蓝针织上衣、深色直筒裤、白色运动鞋",
];

const VISUALS = [
  { trigger: "零食突然变成离别信号", visual_form: "零食与关闭房门之间形成一条由暖橙转冷蓝的断裂轨迹", interaction: "金毛追到轨迹末端急刹并回头望向门缝" },
  { trigger: "想吃又害怕主人离开", visual_form: "零食袋与门把手之间浮现收紧的心跳波和犹豫路径", interaction: "金毛伸爪后缩回，视线在零食和门把手之间往返" },
  { trigger: "压力影响消化节律", visual_form: "身体旁展开友好半透明局部教学窗，用柔和光点演示胃部到肠道的简化节律", interaction: "金毛侧头看向教学窗，光点由顺畅变为忽快忽慢，不展示写实器官" },
  { trigger: "日常动作触发分离焦虑", visual_form: "包、鞋和起身动作依次点亮三枚警觉信号，胸口心跳环逐次加快", interaction: "金毛被每个信号吸引，踱步范围不断缩向门口" },
  { trigger: "稳定告别重建安全感", visual_form: "玩具气味轨迹与门外钥匙声波在客厅中央汇合成柔和闭环", interaction: "金毛沿气味轨迹伏下，听见声波后抬耳并向门口迈步" },
] as const;

const MODE_STYLE: Record<StoryboardDirectorMode, string> = {
  high_energy: "低机位广角、快速甩镜、强姿态剪影和弹性压缩拉伸",
  cinematic: "有动机的跟拍、动作匹配转场、前中后景连续和冷暖光影递进",
  lyrical: "缓推、主观视线、微表演、身体距离变化和柔和情绪光线",
};

const MODE_PACING = {
  high_energy: { pacing: "fast", shots: 4 },
  cinematic: { pacing: "medium", shots: 3 },
  lyrical: { pacing: "slow", shots: 2 },
} as const;

const PANEL_COUNTS = [5, 4, 5, 4, 5] as const;
const PANORAMA_ROLES = [
  "因果揭示：零食轨迹在关闭的房门前断裂，完整呈现金毛急刹回望与空走廊",
  null,
  "警示揭示：用客厅全景统合金毛、友好局部消化教学窗与压力节律变化",
  null,
  "情绪收束：门口、玩具气味轨迹与钥匙声波在同一宽幅空间中形成重逢闭环",
] as const;

function createPackage(mode: StoryboardDirectorMode, input: StoryboardDirectorInput): StoryboardDirectorPackage {
  const sourceSegments = parseSegmentedScript(input.segmented_script);
  const segments = sourceSegments.map((source, index) => {
    const panelCount = PANEL_COUNTS[index];
    const layout = panelCount === 5 ? "four_plus_panorama" as const : "two_by_two" as const;
    const frameLines = Array.from({ length: panelCount }, (_, frameIndex) => {
      const number = frameIndex + 1;
      return `Frame ${number}：${number === 1 ? "动作准备" : number === 2 ? "触发事件" : number === 3 ? "角色反应" : number === 4 ? "因果转折" : PANORAMA_ROLES[index]}；景别、机位、动作阶段和角色姿态均与前一格不同，道具状态和光线方向保持连续。`;
    }).join("\n");
    const imagePrompt = [
      `${input.aspect_ratio}，一张${panelCount}格连续故事板，${input.animation_style}；${panelCount === 4 ? "标准2×2四格版式（two-by-two）" : "top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel"}。`,
      `角色资产：${CHARACTER_ASSETS.join("；")}。宠物保持自然四足。`,
      `本段原文：${source.narration}`,
      `语义可视化：${VISUALS[index].visual_form}；${VISUALS[index].interaction}。`,
      frameLines,
      `第5格职责：${PANORAMA_ROLES[index] ?? "无独立宽幅叙事价值，因此不添加第5格"}。`,
      "禁止上2下3等宽、五张独立图、错序拼贴、监控图式重复视角、角色复制、肢体错误、品种或服装漂移、宠物人形化、统一棕黄滤镜、水印和口播字幕。",
    ].join("\n");
    const { pacing, shots } = MODE_PACING[mode];
    const videoPrompt = [
      `整张故事板只作为视觉素材与动作覆盖，不是切镜清单。生成约10秒正常全屏3D动画，全片${shots}个镜头，${pacing}节奏；锁定故事板角色、服装、犬种、场景、道具、材质、光影、色彩和已有语义可视化；不显示网格、分隔线、Frame编号、说明条或分屏。`,
      `角色资产：${CHARACTER_ASSETS.join("；")}。`,
      ...Array.from({ length: shots }, (_, shotIndex) => {
        const number = shotIndex + 1;
        const start = (shotIndex * (10 / shots)).toFixed(1);
        const end = ((shotIndex + 1) * (10 / shots)).toFixed(1);
        return `镜头 ${number}（${start}-${end}秒）：${MODE_STYLE[mode]}；金毛从明确四足姿势先抬头并蓄力，随后迈步或急刹，身体与耳尾产生连续反应，最后在触发物前收势；30岁中国女性用手部动作回应；道具与环境产生可见物理反馈；${VISUALS[index].interaction}；用视线、运动方向或声响交给下一镜头。`;
      }),
      "声音与口型：角色不说话，不做连续对白口型；只保留脚步、爪声、衣料、门锁和环境声；无对白、旁白、歌词、口播字幕和背景音乐。",
      ...(narrationExceedsGenerationUnit(source.narration, input.target_duration_seconds)
        ? ["本段口播超过单个生成单元容量，建议拆分为下一生成单元后再分别生成。"]
        : []),
    ].join("\n");

    const shotTimeRanges = Array.from({ length: shots }, (_, shotIndex) => ({
      shot_id: `shot_${String(shotIndex + 1).padStart(2, "0")}`,
      start_seconds: Number((shotIndex * (10 / shots)).toFixed(1)),
      end_seconds: Number(((shotIndex + 1) * (10 / shots)).toFixed(1)),
      action_beat: `第${shotIndex + 1}镜完成准备、发力、反应与收势`,
    }));

    return {
      ...source,
      target_duration_seconds: input.target_duration_seconds,
      estimated_narration_duration: estimateNarrationDuration(source.narration),
      panel_count: panelCount,
      layout,
      pacing_mode: pacing,
      actual_shot_count: shots,
      shot_time_ranges: shotTimeRanges,
      panoramic_anchor_role: PANORAMA_ROLES[index],
      continuity_links: shotTimeRanges.slice(0, -1).map((range, rangeIndex) => ({
        from_shot: range.shot_id,
        to_shot: shotTimeRanges[rangeIndex + 1].shot_id,
        link_type: "motion_match",
        description: "沿角色视线、运动方向或声响连续衔接",
      })),
      character_assets: [...CHARACTER_ASSETS],
      semantic_visualizations: [{ ...VISUALS[index] }],
      storyboard_image_prompt: imagePrompt,
      image_to_video_prompt: videoPrompt,
    };
  });
  return {
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    director_mode: mode,
    input,
    segments,
  };
}

assert.deepEqual(
  STORYBOARD_DIRECTOR_PRESET_FIELDS.map((field) => field.id),
  ["segmented_script", "director_mode", "animation_style", "aspect_ratio", "target_duration_seconds", "special_notes"],
);
assert.equal(STORYBOARD_3D_STYLES.length, 10);
assert.ok(STORYBOARD_3D_STYLES.every((style) => style.includes("3D")));

const input = normalizeStoryboardDirectorInput({
  schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
  segmented_script: TEST_SCRIPT,
  animation_style: "电影级高能3D动画喜剧",
  aspect_ratio: "16:9",
  target_duration_seconds: 10,
  special_notes: "金毛保持自然四足；禁用写实解剖。",
});
const sourceSegments = parseSegmentedScript(input.segmented_script);
assert.equal(sourceSegments.length, 5);
assert.ok(TEST_SCRIPT.length >= 280 && TEST_SCRIPT.length <= 420, "test narration should remain about 300 Chinese characters");

const legacyInput = normalizeStoryboardDirectorInput({
  storyboard_segmented_copy: TEST_SCRIPT,
  storyboard_visual_style: "温暖家庭3D动画电影",
  storyboard_aspect_ratio: "9:16 竖屏",
  storyboard_character_setting: "2岁成年金毛",
  storyboard_special_requirements: "禁止写实器官",
});
assert.equal(legacyInput.aspect_ratio, "9:16");
assert.match(legacyInput.special_notes, /2岁成年金毛.*禁止写实器官/);

const reorderedInput = normalizeStoryboardDirectorInput({
  special_notes: "包含引号“安全”与反斜杠\\测试",
  aspect_ratio: "9:16",
  segmented_script: "1、【中文顿号编号也必须识别。】\n2.【第二段包含 JSON 字符：{\"key\":\"值\"}。】",
  animation_style: "温暖家庭3D动画电影",
});
assert.equal(parseSegmentedScript(reorderedInput.segmented_script).length, 2);
assert.equal(reorderedInput.aspect_ratio, "9:16");

const results = [];
for (const mode of ["high_energy", "cinematic", "lyrical"] as const) {
  const modeInput = normalizeStoryboardDirectorInput({ ...input, director_mode: mode });
  const pkg = createPackage(mode, modeInput);
  const issues = validateStoryboardDirectorPackage(pkg, modeInput);
  assert.deepEqual(issues, [], `${mode} protocol issues: ${issues.join(", ")}`);

  const rendered = renderStoryboardDirectorPackage(pkg);
  assert.equal((rendered.match(/```text/g) ?? []).length, sourceSegments.length * 2);
  assert.equal((rendered.match(/```json/g) ?? []).length, 1);
  assert.ok(rendered.indexOf("**生图 Prompt") < rendered.indexOf("**图生视频 Prompt"));
  const parsed = parseStoryboardDirectorPackage(rendered);
  assert.deepEqual(parsed, pkg);
  assert.ok(pkg.segments.every((segment) => segment.panel_count === 4 || segment.panel_count === 5));
  assert.ok(pkg.segments.some((segment) => segment.layout === "two_by_two"));
  assert.ok(pkg.segments.some((segment) => segment.layout === "four_plus_panorama"));
  assert.ok(pkg.segments.filter((segment) => segment.panel_count === 4)
    .every((segment) => segment.panoramic_anchor_role === null));
  assert.ok(pkg.segments.filter((segment) => segment.panel_count === 5)
    .every((segment) => Boolean(segment.panoramic_anchor_role)));
  assert.ok(pkg.segments.every((segment) => segment.character_assets.join(" ").includes("2岁成年金毛寻回犬")));
  assert.ok(pkg.segments.every((segment) => !/同一只狗|同一个人/.test(
    `${segment.storyboard_image_prompt}\n${segment.image_to_video_prompt}`,
  )));
  assert.match(pkg.segments[2].storyboard_image_prompt, /局部教学窗/);
  assert.match(pkg.segments[2].storyboard_image_prompt, /不展示写实器官/);
  assert.doesNotMatch(pkg.segments[2].storyboard_image_prompt, /剖开完整身体|血液|血腥/);
  results.push({
    mode,
    segments: pkg.segments.length,
    text_blocks: sourceSegments.length * 2,
    actual_shot_count: pkg.segments[0].actual_shot_count,
  });
}

assert.deepEqual(results.map((result) => result.actual_shot_count), [4, 3, 2]);

const legacyPackage = createPackage("cinematic", input);
const legacyPayload = JSON.parse(JSON.stringify(legacyPackage)) as Record<string, unknown>;
for (const segment of (legacyPayload.segments as Array<Record<string, unknown>>)) {
  segment.frame_count = segment.panel_count;
  delete segment.panel_count;
  delete segment.layout;
  delete segment.pacing_mode;
  delete segment.actual_shot_count;
  delete segment.panoramic_anchor_role;
}
const parsedLegacy = parseStoryboardDirectorPackage(JSON.stringify(legacyPayload));
assert.ok(parsedLegacy, "legacy frame_count payload should remain parseable");
assert.equal(parsedLegacy.segments[0].panel_count, 5);
assert.equal(parsedLegacy.segments[0].layout, "four_plus_panorama");
assert.equal(parsedLegacy.segments[1].panoramic_anchor_role, null);

const invalidLayoutPackage = createPackage("cinematic", input);
invalidLayoutPackage.segments[0].storyboard_image_prompt += "\n上2下3五格等宽。";
assert.ok(validateStoryboardDirectorPackage(invalidLayoutPackage, input)
  .includes("segment_001:forbidden_two_plus_three_layout"));

const forcedCutsPackage = createPackage("high_energy", input);
forcedCutsPackage.segments[0].image_to_video_prompt += "\nFrame 1 至 Frame 5 依次连续逐格切换。";
assert.ok(validateStoryboardDirectorPackage(forcedCutsPackage, input)
  .includes("segment_001:video_prompt_forces_panel_cuts"));

const escapedPackage = createPackage("cinematic", {
  ...reorderedInput,
  director_mode: "cinematic",
  special_notes: `${reorderedInput.special_notes}\n${"长文本".repeat(1800)}`,
});
escapedPackage.segments[0].storyboard_image_prompt += "\n禁止把 ```text 当作输出边界。";
const escapedRendered = renderStoryboardDirectorPackage(escapedPackage);
assert.match(escapedRendered, /````text/);
assert.deepEqual(parseStoryboardDirectorPackage(escapedRendered), escapedPackage);

const migration = readFileSync(
  resolve(process.cwd(), "scripts", "migrations", "20260814_storyboard_director_agents_v6_1.sql"),
  "utf8",
);
const rollback = readFileSync(
  resolve(process.cwd(), "scripts", "migrations", "20260814_storyboard_director_agents_v6_1_rollback.sql"),
  "utf8",
);
const blockedMigration = readFileSync(
  resolve(process.cwd(), "scripts", "migrations", "20260814_storyboard_director_agents_v6.sql"),
  "utf8",
);
const promptDoc = readFileSync(
  resolve(process.cwd(), "docs", "故事版导演三卡稳定协议-v6.1.md"),
  "utf8",
);

for (const id of [
  "agent-1786633444187-594spj",
  "agent-1786642714227-e1zid1",
  "agent-1786642714448-m6iaou",
]) {
  assert.ok(migration.includes(id));
  assert.ok(rollback.includes(id));
}
for (const stableId of [
  "segmented_script",
  "animation_style",
  "aspect_ratio",
  "special_notes",
  "panel_count",
  "layout",
  "pacing_mode",
  "actual_shot_count",
  "panoramic_anchor_role",
  "storyboard_image_prompt",
  "image_to_video_prompt",
]) {
  assert.ok(migration.includes(stableId));
  assert.ok(promptDoc.includes(stableId));
}
assert.match(blockedMigration, /Blocked obsolete migration/);
assert.match(migration, /left\(\s*agent\.system_prompt/);
assert.match(migration, /strpos\(agent\.system_prompt, '# 固定输出格式'\)/);
assert.match(migration, /# 3D风格执行字典/);
assert.match(migration, /top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel/);
assert.match(migration, /故事板面板只是视觉素材与动作覆盖，不是切镜清单/);
const protocolTail = migration.match(/\$protocol\$([\s\S]*?)\$protocol\$/)?.[1] ?? "";
assert.ok(protocolTail.length > 500);
assert.doesNotMatch(protocolTail, /四格每格约2至2\.5秒；五格每格约1\.6至2\.2秒/);
assert.ok(!protocolTail.includes("不输出JSON"));
assert.ok(!migration.includes("to_jsonb(agents)"));
assert.ok(!/['"](?:api_key|proxy_url|provider)['"]/.test(migration));
assert.ok(migration.includes("ON CONFLICT (migration_key, agent_id) DO NOTHING"));
assert.ok(migration.includes("storyboard v6.1 preflight failed"));
assert.ok(migration.includes("storyboard v6.1 postcondition failed"));
assert.ok(rollback.includes("20260814_storyboard_director_agents_v6_1"));

console.log(JSON.stringify({
  ok: true,
  paid_model_calls: 0,
  narration_characters: TEST_SCRIPT.length,
  source_segments: sourceSegments.length,
  director_results: results,
  input_schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
  output_schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  style_options: STORYBOARD_3D_STYLES.length,
}, null, 2));
