import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STORYBOARD_3D_STYLES,
  STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_MODES,
  STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_PRESET_FIELDS,
  STORYBOARD_TARGET_DURATIONS,
  estimateNarrationDuration,
  narrationExceedsGenerationUnit,
  normalizeStoryboardDirectorInput,
  parseSegmentedScript,
  parseStoryboardDirectorPackage,
  renderStoryboardDirectorPackage,
  storyboardShotCountRule,
  validateStoryboardDirectorPackage,
  type StoryboardActualShotCount,
  type StoryboardDirectorInput,
  type StoryboardDirectorMode,
  type StoryboardDirectorPackage,
  type StoryboardPacingMode,
  type StoryboardTargetDurationSeconds,
} from "../src/lib/storyboard-director-protocol";
import { parseStructuredAgentOutput } from "../src/lib/structured-agent-output";

function assertSqlReplaceCallsHaveThreeArguments(sql: string): void {
  for (let start = sql.indexOf("replace("); start >= 0; start = sql.indexOf("replace(", start + 1)) {
    let depth = 1;
    let commas = 0;
    let quoted = false;
    for (let index = start + "replace(".length; index < sql.length; index++) {
      const char = sql[index];
      if (char === "'") {
        if (quoted && sql[index + 1] === "'") {
          index++;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (char === "(") depth++;
      else if (char === ")") depth--;
      else if (char === "," && depth === 1) commas++;
      if (depth === 0) {
        assert.equal(commas, 2, `SQL replace() at offset ${start} must have exactly three arguments`);
        break;
      }
      assert.notEqual(index, sql.length - 1, `unclosed SQL replace() at offset ${start}`);
    }
  }
}

const ABOUT_300_CHARACTER_SCRIPT = [
  "1.【主人准备出门时，把一颗零食轻轻放到地毯上。两岁金毛先开心跑近，听见钥匙声后却突然停住，抬头看向已经转动的门把手。】",
  "2.【房门合上后，客厅安静下来。金毛叼着零食走到门边，又慢慢放下，耳朵贴向脑后，胸前浮现收紧的柔和心跳线。】",
  "3.【下一次零食袋发出沙沙声，它向前迈一步又缩回爪子。零食和门之间出现一条断开的轨迹，让观众看懂奖励为何变成了离别信号。】",
  "4.【主人后来改成平静告别，蹲下拥抱金毛，再留下带有熟悉气味的布偶。金毛先闻玩具，再趴到门边等待，呼吸逐渐平稳。】",
  "5.【傍晚钥匙声再次响起，金毛抬耳、起身、跑向门口。主人进门后先回应它的期待，离别与重逢终于形成一个稳定而温暖的闭环。】",
].join("\n");

assert.ok(ABOUT_300_CHARACTER_SCRIPT.length >= 280 && ABOUT_300_CHARACTER_SCRIPT.length <= 380);
assert.equal(parseSegmentedScript(ABOUT_300_CHARACTER_SCRIPT).length, 5);

const NARRATIONS: Record<StoryboardTargetDurationSeconds, string> = {
  8: "主人拿起钥匙准备出门，蜂蜜金色的成年金毛追到玄关后突然急刹，耳朵后贴，胸前心跳线一下收紧。",
  10: "主人拿起钥匙准备出门，蜂蜜金色的成年金毛先追到玄关，又在门把手转动时急刹，胸前心跳线逐渐收紧。",
  15: "主人拿起钥匙准备出门，蜂蜜金色的成年金毛先追到玄关，又在门把手转动时急刹。它看一眼地上的零食，再看向主人，耳朵慢慢后贴，胸前心跳线由稀疏变密，最后把爪子缩回身体下方。",
};

const MODE_RULES: Record<StoryboardDirectorMode, {
  pacing: StoryboardPacingMode;
  marker: RegExp;
  direction: string;
}> = {
  high_energy: {
    pacing: "fast",
    marker: /弹性压缩拉伸|冲击线|急刹/,
    direction: "用低机位快速跟拍，动作采用清晰的预备、爆发、急刹和弹性回震，冲击线随急刹向前甩出。",
  },
  cinematic: {
    pacing: "medium",
    marker: /空间连续|动作匹配|有动机/,
    direction: "用有动机的缓推与侧向跟拍保持玄关空间连续，以钥匙转动和金毛回头做动作匹配衔接。",
  },
  lyrical: {
    pacing: "slow",
    marker: /微表演|呼吸|关系距离/,
    direction: "用缓慢靠近的长镜头捕捉耳朵、眼神、呼吸和爪尖的微表演，让关系距离逐步收紧。",
  },
};

const CASES = [
  { mode: "high_energy", duration: 8, shots: 3, panels: 4 },
  { mode: "cinematic", duration: 8, shots: 2, panels: 4 },
  { mode: "lyrical", duration: 8, shots: 1, panels: 4 },
  { mode: "high_energy", duration: 10, shots: 4, panels: 5 },
  { mode: "cinematic", duration: 10, shots: 3, panels: 4 },
  { mode: "lyrical", duration: 10, shots: 2, panels: 4 },
  { mode: "high_energy", duration: 15, shots: 5, panels: 5 },
  { mode: "cinematic", duration: 15, shots: 4, panels: 5 },
  { mode: "lyrical", duration: 15, shots: 3, panels: 4 },
] as const satisfies ReadonlyArray<{
  mode: StoryboardDirectorMode;
  duration: StoryboardTargetDurationSeconds;
  shots: StoryboardActualShotCount;
  panels: 4 | 5;
}>;

function shotRanges(duration: StoryboardTargetDurationSeconds, count: StoryboardActualShotCount) {
  return Array.from({ length: count }, (_, index) => ({
    shot_id: `shot_${String(index + 1).padStart(2, "0")}`,
    start_seconds: Number((index * duration / count).toFixed(1)),
    end_seconds: Number(((index + 1) * duration / count).toFixed(1)),
    action_beat: index === 0
      ? "建立钥匙声与金毛注意反应"
      : index === count - 1
        ? "完成急刹、回望与情绪收势"
        : "推进追随、犹豫与身体反应",
  }));
}

function makePackage(
  mode: StoryboardDirectorMode,
  duration: StoryboardTargetDurationSeconds,
  shots: StoryboardActualShotCount,
  panels: 4 | 5,
  narration = NARRATIONS[duration],
): StoryboardDirectorPackage {
  const input: StoryboardDirectorInput = {
    schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
    segmented_script: `1.【${narration}】`,
    director_mode: mode,
    animation_style: "电影级高能3D动画喜剧",
    aspect_ratio: "16:9",
    target_duration_seconds: duration,
    special_notes: "金毛保持自然四足；中国成年女性穿雾蓝针织衫和深色直筒裤；禁止写实解剖。",
  };
  const [source] = parseSegmentedScript(input.segmented_script);
  const ranges = shotRanges(duration, shots);
  const panoramaRole = panels === 5
    ? "警示揭示：底部全宽玄关全景同时呈现关闭的门、断裂零食轨迹和金毛急刹后的完整关系"
    : null;
  const layoutLine = panels === 5
    ? "top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel"
    : "标准2×2四格版式（two-by-two）";
  const imagePrompt = [
    `16:9，一张${panels}格连续故事板，${layoutLine}，${input.animation_style}。`,
    "角色资产：2岁成年金毛寻回犬，蜂蜜金长毛，中大型匀称四足体型，深棕眼睛；32岁中国女性，深棕高马尾，雾蓝针织衫、深色直筒裤、白色运动鞋。",
    `剧情：${narration}`,
    `导演执行：${MODE_RULES[mode].direction}`,
    "语义可视化：钥匙、零食与关闭的门形成一条由暖橙转冷蓝的断裂轨迹；金毛胸前出现不遮挡身体的柔和心跳线，随紧张由疏变密，并与耳朵后贴、急刹和缩爪同步。",
    "四个动作帧依次承担准备、钥匙触发、身体反应、因果转折；每格改变景别、机位和动作阶段，场景轴线、服装、犬种和道具状态连续。",
    ...(panoramaRole ? [`第5格职责：${panoramaRole}。`] : []),
    "禁止上2下3等宽、五张独立图、错序拼贴、监控视角重复、角色复制、宠物人形化、品种和服装漂移、水印及口播字幕。",
  ].join("\n");
  const videoPrompt = [
    `目标${duration}秒，全片实际${shots}个镜头，${MODE_RULES[mode].pacing}节奏。整张故事板只是角色、空间、动作阶段和语义效果参考，不按Frame逐格切换。`,
    `锁定2岁成年蜂蜜金金毛、32岁中国女性的服装与玄关空间。${MODE_RULES[mode].direction}`,
    ...ranges.map((range, index) => `镜头 ${index + 1}（${range.start_seconds}-${range.end_seconds}秒）：先${range.action_beat}；金毛保持自然四足，耳尾、呼吸、爪步和重心连续变化；钥匙、门和心跳线产生可见物理反馈；沿视线、运动方向或钥匙声顺滑交给下一镜。`),
    "声音边界：角色不说话、无对白口型；只保留钥匙、脚步、爪声、门锁和室内环境声；无旁白、歌词、字幕和背景音乐。",
    ...(narrationExceedsGenerationUnit(narration, duration)
      ? ["本段语义超过单个时长单元容量，建议拆分为下一生成单元，不压缩成六格以上，也不为凑数量快速切镜。"]
      : []),
  ].join("\n");

  return {
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    director_mode: mode,
    input,
    segments: [{
      ...source,
      target_duration_seconds: duration,
      estimated_narration_duration: estimateNarrationDuration(narration),
      panel_count: panels,
      layout: panels === 5 ? "four_plus_panorama" : "two_by_two",
      pacing_mode: MODE_RULES[mode].pacing,
      actual_shot_count: shots,
      shot_time_ranges: ranges,
      panoramic_anchor_role: panoramaRole,
      continuity_links: ranges.slice(0, -1).map((range, index) => ({
        from_shot: range.shot_id,
        to_shot: ranges[index + 1].shot_id,
        link_type: index % 2 === 0 ? "sound_bridge" : "motion_match",
        description: index % 2 === 0 ? "钥匙声延续并引出下一动作" : "沿金毛视线和运动方向连续衔接",
      })),
      character_assets: [
        "2岁成年金毛寻回犬，蜂蜜金长毛，中大型匀称四足体型，深棕眼睛",
        "32岁中国女性，深棕高马尾，雾蓝针织衫、深色直筒裤、白色运动鞋",
      ],
      semantic_visualizations: [{
        trigger: "钥匙声让奖励变成离别预警",
        visual_form: "暖橙转冷蓝的断裂轨迹与胸前柔和心跳线",
        interaction: "轨迹止于门缝，心跳线随急刹和呼吸由疏变密",
      }],
      storyboard_image_prompt: imagePrompt,
      image_to_video_prompt: videoPrompt,
    }],
  };
}

assert.deepEqual(
  STORYBOARD_DIRECTOR_PRESET_FIELDS.map((field) => field.id),
  ["segmented_script", "director_mode", "animation_style", "aspect_ratio", "target_duration_seconds", "special_notes"],
);
assert.equal(STORYBOARD_DIRECTOR_PRESET_FIELDS[4].defaultValue, "10");
assert.deepEqual(STORYBOARD_DIRECTOR_PRESET_FIELDS[4].options, ["8", "10", "15"]);
assert.equal(STORYBOARD_3D_STYLES.length, 10);

const expectedShotRules = {
  8: {
    high_energy: { min: 2, max: 3, defaultCount: 3 },
    cinematic: { min: 2, max: 3, defaultCount: 2 },
    lyrical: { min: 1, max: 2, defaultCount: 1 },
  },
  10: {
    high_energy: { min: 3, max: 4, defaultCount: 4 },
    cinematic: { min: 2, max: 3, defaultCount: 3 },
    lyrical: { min: 1, max: 2, defaultCount: 2 },
  },
  15: {
    high_energy: { min: 4, max: 5, defaultCount: 5 },
    cinematic: { min: 3, max: 4, defaultCount: 4 },
    lyrical: { min: 2, max: 3, defaultCount: 3 },
  },
} as const;

for (const duration of STORYBOARD_TARGET_DURATIONS) {
  for (const mode of STORYBOARD_DIRECTOR_MODES) {
    assert.deepEqual(storyboardShotCountRule(duration, mode), expectedShotRules[duration][mode]);
  }
}

const results = CASES.map((testCase) => {
  const rule = storyboardShotCountRule(testCase.duration, testCase.mode);
  assert.ok(testCase.shots >= rule.min && testCase.shots <= rule.max);
  const pkg = makePackage(testCase.mode, testCase.duration, testCase.shots, testCase.panels);
  const issues = validateStoryboardDirectorPackage(pkg, pkg.input);
  assert.deepEqual(issues, [], `${testCase.mode}/${testCase.duration}s: ${issues.join(", ")}`);
  const rendered = renderStoryboardDirectorPackage(pkg);
  assert.equal((rendered.match(/```text/g) ?? []).length, 2);
  assert.equal((rendered.match(/```json/g) ?? []).length, 1);
  assert.deepEqual(parseStoryboardDirectorPackage(rendered), pkg);
  const structured = parseStructuredAgentOutput(rendered, true);
  assert.equal(structured.status, "valid");
  if (structured.status === "valid") {
    assert.equal(structured.segments[0].target_duration_seconds, testCase.duration);
    assert.equal(structured.segments[0].shot_time_ranges.length, testCase.shots);
    assert.equal(structured.segments[0].continuity_links.length, Math.max(0, testCase.shots - 1));
  }
  assert.match(pkg.segments[0].storyboard_image_prompt, MODE_RULES[testCase.mode].marker);
  assert.doesNotMatch(pkg.segments[0].image_to_video_prompt, /Frame\s*1\s*(?:至|到|-)\s*Frame\s*[45].*(?:依次|逐格)/);
  return {
    mode: testCase.mode,
    duration: testCase.duration,
    panels: testCase.panels,
    shots: testCase.shots,
    narration_estimate: pkg.segments[0].estimated_narration_duration,
  };
});

assert.equal(results.length, 9);
assert.deepEqual([...new Set(results.map((item) => item.duration))], [8, 10, 15]);
assert.ok(results.some((item) => item.panels === 4));
assert.ok(results.some((item) => item.panels === 5));

const legacyInput = normalizeStoryboardDirectorInput({
  storyboard_segmented_copy: "1.【旧模板没有时长字段，也应默认十秒。】",
  storyboard_visual_style: "温暖家庭3D动画电影",
  storyboard_aspect_ratio: "9:16 竖屏",
  storyboard_character_setting: "3岁成年拉布拉多，黑色短毛，自然四足",
  storyboard_special_requirements: "禁止真实器官",
});
assert.equal(legacyInput.target_duration_seconds, 10);
assert.equal(legacyInput.aspect_ratio, "9:16");

const legacySource = makePackage("cinematic", 10, 3, 5);
const legacyPayload = JSON.parse(JSON.stringify(legacySource)) as Record<string, unknown>;
delete (legacyPayload.input as Record<string, unknown>).target_duration_seconds;
for (const segment of legacyPayload.segments as Array<Record<string, unknown>>) {
  segment.frame_count = segment.panel_count;
  delete segment.panel_count;
  delete segment.target_duration_seconds;
  delete segment.estimated_narration_duration;
  delete segment.layout;
  delete segment.pacing_mode;
  delete segment.actual_shot_count;
  delete segment.shot_time_ranges;
  delete segment.panoramic_anchor_role;
  delete segment.continuity_links;
}
const parsedLegacy = parseStoryboardDirectorPackage(JSON.stringify(legacyPayload));
assert.ok(parsedLegacy);
assert.equal(parsedLegacy.input.target_duration_seconds, 10);
assert.equal(parsedLegacy.segments[0].panel_count, 5);
assert.equal(parsedLegacy.segments[0].actual_shot_count, 3);
assert.equal(parsedLegacy.segments[0].shot_time_ranges.at(-1)?.end_seconds, 10);

const reorderedInput = normalizeStoryboardDirectorInput({
  special_notes: "字段换序；包含反斜杠 C:\\story 和中文标点。",
  target_duration_seconds: "15秒",
  aspect_ratio: "16:9",
  animation_style: "未来科技3D动画",
  segmented_script: "1、【中文顿号编号照常解析。】",
  director_mode: "电影叙事",
});
assert.equal(reorderedInput.target_duration_seconds, 15);
assert.equal(parseSegmentedScript(reorderedInput.segmented_script).length, 1);

const overloadedNarration = "金毛在门边不断徘徊，听见钥匙声后先跑向主人，又退回零食旁边，接着看向窗外、沙发、鞋柜和门把手，胸前心跳越来越快，主人同时换鞋、拿包、关灯、检查手机并打开房门，多个因果和动作无法在十秒内清楚演完。";
assert.equal(narrationExceedsGenerationUnit(overloadedNarration, 10), true);
const overloaded = makePackage("high_energy", 10, 4, 5, overloadedNarration);
assert.equal(overloaded.segments[0].panel_count <= 5, true);
assert.match(overloaded.segments[0].image_to_video_prompt, /建议拆分为下一生成单元/);
assert.deepEqual(validateStoryboardDirectorPackage(overloaded, overloaded.input), []);

const invalidForcedCut = makePackage("high_energy", 10, 4, 5);
invalidForcedCut.segments[0].image_to_video_prompt += "\nFrame 1 至 Frame 5 依次逐格切换。";
assert.ok(validateStoryboardDirectorPackage(invalidForcedCut, invalidForcedCut.input)
  .includes("segment_001:video_prompt_forces_panel_cuts"));

const migration = readFileSync(resolve(process.cwd(), "scripts/migrations/20260814_storyboard_director_agents_v6_2.sql"), "utf8");
const rollback = readFileSync(resolve(process.cwd(), "scripts/migrations/20260814_storyboard_director_agents_v6_2_rollback.sql"), "utf8");
const backupDirectory = resolve(process.cwd(), "backups/storyboard-directors-v6.2-preflight-20260814T060331Z");
const manifest = JSON.parse(readFileSync(resolve(backupDirectory, "manifest.json"), "utf8")) as {
  agents: unknown[];
  files: Array<{ file: string; sha256: string }>;
};
assert.equal(manifest.agents.length, 3);
for (const file of manifest.files) {
  const hash = createHash("sha256").update(readFileSync(resolve(backupDirectory, file.file))).digest("hex");
  assert.equal(hash, file.sha256, `local backup hash mismatch: ${file.file}`);
}

for (const id of [
  "agent-1786633444187-594spj",
  "agent-1786642714227-e1zid1",
  "agent-1786642714448-m6iaou",
]) {
  assert.ok(migration.includes(id));
  assert.ok(rollback.includes(id));
}
for (const stableId of [
  "target_duration_seconds",
  "estimated_narration_duration",
  "panel_count",
  "layout",
  "pacing_mode",
  "actual_shot_count",
  "shot_time_ranges",
  "panoramic_anchor_role",
  "continuity_links",
]) assert.ok(migration.includes(stableId));

assert.ok(migration.startsWith("-- Compatibility migration"));
assert.match(migration, /BEGIN;/);
assert.match(migration, /COMMIT;/);
assertSqlReplaceCallsHaveThreeArguments(migration.slice(
  migration.indexOf("SET\n  system_prompt"),
  migration.indexOf("  preset_fields = jsonb_build_array"),
));
assert.ok(migration.indexOf("v6.2 前置备份/8-10-15秒适配前") < migration.indexOf("UPDATE agents AS agent"));
assert.match(migration, /ON CONFLICT \(migration_key, agent_id\) DO NOTHING/);
assert.match(migration, /jsonb_array_length\(preset_fields\) = 5/);
assert.match(migration, /'defaultValue', '10'/);
assert.match(migration, /8秒高能2至3镜、电影2至3镜、抒情1至2镜/);
assert.match(migration, /15秒高能4至5镜、电影3至4镜、抒情2至3镜/);
assert.doesNotMatch(migration, /to_jsonb\(agents\)/);
assert.doesNotMatch(migration, /['"](?:api_key|proxy_url|provider|token)['"]/i);
assert.match(rollback, /20260814_storyboard_director_agents_v6_2/);
assert.match(rollback, /DELETE FROM prompt_versions/);

console.log(JSON.stringify({
  ok: true,
  paid_model_calls: 0,
  regression_groups: results,
  legacy_default_duration: legacyInput.target_duration_seconds,
  overloaded_split_recommended: true,
  local_backup_verified_files: manifest.files.length,
  database_migration_executed: false,
}, null, 2));
