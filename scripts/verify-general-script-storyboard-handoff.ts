import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GENERAL_SCRIPT_HANDOFF_MAX_AGE_MS,
  GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY,
  GENERAL_SCRIPT_HANDOFF_STORAGE_KEY,
  bridgeGeneralScriptToStoryboard,
  createGeneralScriptHandoffReceipt,
  parseGeneralScriptStoryboardHandoff,
} from "../src/lib/short-drama/general-script-storyboard-bridge";
import {
  GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
  type GeneralScriptResult,
} from "../src/lib/short-drama/general-script-contract";

const NOW_MS = Date.parse("2026-08-23T04:30:00.000Z");

function makeResult(durationSeconds = 60): GeneralScriptResult {
  return {
    schemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
    profileId: "pet-silent-narration",
    operation: "generate",
    summary: {
      title: "豆豆沿着灯光回家",
      protagonist: "小狗豆豆",
      oneSentence: "走失的小狗通过气味、灯光和熟悉的红色项圈找到主人。",
      synopsis: "豆豆在雨后与主人走散，逐步确认方向并回到亮灯的家门前。",
      genre: "温情宠物动画",
      creationMode: "original",
      targetAudience: "all_ages",
      tone: "warm",
      background: "现代城市社区",
      setting: "雨后傍晚的街道与小区",
      animationStyle: "商业级风格化三维动画，暖色电影光与细腻毛发材质",
      videoSize: "9:16",
      performanceMode: "silent_narration",
      totalEpisodes: 1,
      isFinale: true,
    },
    episodes: [{
      episodeNumber: 1,
      title: "亮着灯的家",
      logline: "豆豆在雨后街道寻找回家的可见线索。",
      content: "豆豆在雨后街角停下，鼻尖贴近湿润路面辨认气味。它抬头看见远处暖黄色路灯，耳朵迅速转向熟悉的小区。红色项圈碰到金属门牌，豆豆沿着反光水迹加快脚步。家门亮起，主人跑来蹲下，豆豆摇着尾巴把额头贴向主人的手掌。",
      endingHook: "主人打开家门，暖光落在豆豆的红色项圈上。",
      estimatedDurationSeconds: durationSeconds,
      characterNames: ["豆豆", "主人"],
      sceneNames: ["雨后街角", "小区家门"],
      propNames: ["红色项圈", "金属门牌"],
    }],
    characters: [
      {
        id: "character-doudou",
        name: "豆豆",
        role: "主角",
        profile: "寻找回家的小狗",
        personality: "敏锐、勇敢、依恋主人",
        appearance: "浅棕色短毛，柯基体型，佩戴红色项圈",
        voiceDirection: "不说话，使用后期旁白",
      },
      {
        id: "character-owner",
        name: "主人",
        role: "重要角色",
        profile: "一直寻找豆豆的年轻主人",
        personality: "温柔、焦急、可靠",
        appearance: "米白雨衣、深蓝长裤、白色运动鞋",
        voiceDirection: "不说话，使用后期旁白",
      },
    ],
    scenes: [
      {
        id: "scene-rain-corner",
        name: "雨后街角",
        description: "湿润路面反射暖色路灯，路缘留有浅水迹",
        time: "傍晚",
        atmosphere: "迷茫逐步转向希望",
        episodeNumbers: [1],
      },
      {
        id: "scene-home-door",
        name: "小区家门",
        description: "门口暖灯照亮金属门牌和木质门框",
        time: "夜幕初起",
        atmosphere: "温暖安心",
        episodeNumbers: [1],
      },
    ],
    props: [
      {
        id: "prop-red-collar",
        name: "红色项圈",
        category: "角色道具",
        description: "豆豆始终佩戴的红色织物项圈",
        episodeNumbers: [1],
      },
      {
        id: "prop-door-plate",
        name: "金属门牌",
        category: "线索道具",
        description: "固定在家门旁、能够反射暖光的金属门牌",
        episodeNumbers: [1],
      },
    ],
  };
}

function makeHandoff(result: GeneralScriptResult, savedAtMs = NOW_MS): string {
  return JSON.stringify({
    schemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
    source: "/tools/text/general-script",
    savedAt: new Date(savedAtMs).toISOString(),
    result,
  });
}

function noWhitespace(value: string): string {
  return value.replace(/\s+/gu, "");
}

function verifyBridgeAndPromptGates(): void {
  const result = makeResult(60);
  const bridge = bridgeGeneralScriptToStoryboard(result);
  const segments = bridge.workbenchImport.segments;
  const machine = bridge.handoffMetadata.animationReversePackage;

  assert.equal(bridge.preview.episodeCount, 1);
  assert.equal(bridge.preview.segmentCount, 4, "60 秒单集必须拆成 4 个生产段");
  assert.equal(segments.length, 4);
  assert.deepEqual(segments.map((segment) => segment.sourceNumber), [1, 2, 3, 4]);
  assert.equal(new Set(segments.map((segment) => segment.narration)).size, 4, "不同生产段 narration 不得重复");
  assert.equal(
    noWhitespace(segments.map((segment) => segment.narration).join("")),
    noWhitespace(result.episodes[0].content),
    "语义拆分不得丢失或重复原文案",
  );

  assert.equal(machine.artifact_type, "animation_reverse_package.v1");
  assert.equal(machine.schema_version, "1.0");
  assert.equal(machine.segments.length, segments.length);
  assert.equal(machine.validation.no_paid_execution, true);

  machine.segments.forEach((segment, index) => {
    assert.equal(segment.segment_id, `episode-001-segment-${String(index + 1).padStart(2, "0")}`);
    assert.equal(segment.narration, segments[index].narration);
    assert.equal(segment.target_duration_seconds, 15);
    assert.ok(segment.actual_shot_count >= 2 && segment.actual_shot_count <= 4);
    assert.equal(segment.validation.source_segment_index, index + 1);
    assert.equal(segment.validation.source_segment_count, 4);
    assert.equal(segment.validation.no_mouth_hard_constraint, "pass");

    assert.match(segment.image_prompt, /画幅9:16/u);
    assert.match(segment.image_prompt, /商业级风格化三维动画/u);
    assert.match(segment.image_prompt, /嘴部自然闭合/u);
    assert.doesNotMatch(segment.image_prompt, /\d+(?:\.\d+)?\s*秒|声音|音效|音乐|旁白|配音/u, "生图 Prompt 只能写可见画面");

    assert.match(segment.video_prompt, /建议时长15秒/u);
    assert.match(segment.video_prompt, /真实镜头/u);
    assert.match(segment.video_prompt, /接触|物理反馈/u);
    assert.match(segment.video_prompt, /环境声|动作接触声/u);
    assert.match(segment.video_prompt, /嘴部自然闭合/u);
    assert.match(segment.video_prompt, /后期旁白/u);
    assert.match(segment.video_prompt, /不按故事板面板逐格硬切/u);
    assert.match(segment.video_prompt, /以当前故事板为唯一视觉参考/u);
    assert.match(segment.video_prompt, /沿用其中已有的统一美术、角色、场景、道具、材质、光影、综合色彩和动作方向/u);
    assert.doesNotMatch(segment.video_prompt, /商业级风格化三维动画，暖色电影光与细腻毛发材质/u, "视频 Prompt 不应重复整套美术说明");
  });
  assert.ok(
    machine.segments.some((segment) => segment.panel_count !== segment.actual_shot_count),
    "面板数与真实镜头数必须由不同规则决定，不能整包机械相等",
  );

  const ninetySecondBridge = bridgeGeneralScriptToStoryboard(makeResult(90));
  assert.equal(ninetySecondBridge.preview.segmentCount, 6, "90 秒单集必须拆成 6 个生产段");
  assert.equal(new Set(ninetySecondBridge.workbenchImport.segments.map((item) => item.narration)).size, 6);

  const tooMany = makeResult(90);
  tooMany.episodes = Array.from({ length: 4 }, (_, index) => ({
    ...tooMany.episodes[0],
    episodeNumber: index + 1,
    title: `第${index + 1}集`,
    content: `${tooMany.episodes[0].content}第${index + 1}集以新的门牌反光作为收束。`,
  }));
  assert.throws(
    () => bridgeGeneralScriptToStoryboard(tooMany),
    /需拆成24段，请按集分批发送，未进行截断/u,
  );
}

function verifyHandoffLifecycle(): void {
  const result = makeResult(60);
  const raw = makeHandoff(result);
  const valid = parseGeneralScriptStoryboardHandoff(raw, { nowMs: NOW_MS + 1_000 });
  if (!valid.ok) throw new Error(`有效 fixture 被拒绝：${valid.error}`);
  assert.equal(valid.ok, true);
  assert.equal(valid.value.bridge.preview.segmentCount, 4);

  const malformedJson = parseGeneralScriptStoryboardHandoff("{not-json", { nowMs: NOW_MS });
  assert.deepEqual({ ok: malformedJson.ok, code: malformedJson.ok ? "" : malformedJson.code }, { ok: false, code: "malformed" });

  const damagedResult = JSON.parse(raw) as Record<string, unknown>;
  damagedResult.result = { ...(damagedResult.result as Record<string, unknown>), unexpected: true };
  const malformedShape = parseGeneralScriptStoryboardHandoff(JSON.stringify(damagedResult), { nowMs: NOW_MS });
  assert.deepEqual({ ok: malformedShape.ok, code: malformedShape.ok ? "" : malformedShape.code }, { ok: false, code: "malformed" });

  const expired = parseGeneralScriptStoryboardHandoff(raw, {
    nowMs: NOW_MS + GENERAL_SCRIPT_HANDOFF_MAX_AGE_MS + 1,
  });
  assert.deepEqual({ ok: expired.ok, code: expired.ok ? "" : expired.code }, { ok: false, code: "expired" });

  const receipt = createGeneralScriptHandoffReceipt(valid.value, NOW_MS + 2_000);
  const repeated = parseGeneralScriptStoryboardHandoff(raw, {
    nowMs: NOW_MS + 3_000,
    consumedReceiptRaw: JSON.stringify(receipt),
  });
  assert.deepEqual({ ok: repeated.ok, code: repeated.ok ? "" : repeated.code }, { ok: false, code: "already_consumed" });
  assert.equal(makeHandoff(result), raw, "重复消费检查不得删除或改写源 handoff");
}

function verifyUiContractMarkers(): void {
  const component = readFileSync(new URL("../src/components/storyboard-workbench.tsx", import.meta.url), "utf8");
  assert.match(component, /searchParams\.get\("entry"\) === "short-drama"/u);
  assert.match(component, /searchParams\.get\("handoff"\) === "general-script"/u);
  assert.match(component, /data-testid="general-script-handoff-preview"/u);
  assert.match(component, /data-testid="general-script-handoff-confirm"/u);
  assert.match(component, /"general-script-imported-card"/u);
  assert.match(component, /确认导入（不生成）/u);
  assert.match(component, /无对白口型（嘴部自然闭合）/u);
  assert.match(component, /sessionStorage\.getItem\(handoffStorageKey\)/u, "工作台必须从账号隔离的同标签页暂存读取 handoff");
  assert.match(component, /sessionStorage\.removeItem\(handoffStorageKey\)/u, "handoff 必须读取一次即清除");
  assert.doesNotMatch(component, /localStorage\.setItem\([\s\S]{0,160}GENERAL_SCRIPT_HANDOFF/u, "工作台不得把 handoff 或回执写入长期存储");

  const bridgeSource = readFileSync(new URL("../src/lib/short-drama/general-script-storyboard-bridge.ts", import.meta.url), "utf8");
  assert.doesNotMatch(bridgeSource, /\bfetch\s*\(/u, "纯桥接不得访问网络");
  assert.equal(GENERAL_SCRIPT_HANDOFF_STORAGE_KEY, "short_drama_general_script_handoff_v1");
  assert.equal(GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY, "short_drama_general_script_handoff_consumed_v1");
  assert.equal(GENERAL_SCRIPT_HANDOFF_MAX_AGE_MS, 2 * 60 * 1_000, "同标签页交接最多保留 2 分钟");
}

function main(): void {
  verifyBridgeAndPromptGates();
  verifyHandoffLifecycle();
  verifyUiContractMarkers();
  console.log("general-script -> storyboard handoff verification passed (offline only; no model, billing, database, or network calls)");
}

main();
