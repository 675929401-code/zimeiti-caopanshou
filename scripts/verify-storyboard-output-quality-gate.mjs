#!/usr/bin/env node
/**
 * Static Storyboard Output Quality Gate v1.
 * Contract inspection only: no model, provider, media, billing, or browser calls.
 *
 * Usage:
 *   pnpm exec node scripts/verify-storyboard-output-quality-gate.mjs <output.json>
 *   pnpm exec node scripts/verify-storyboard-output-quality-gate.mjs --self-test
 *   ... <output.json> --report <report.json>
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = "storyboard_output_quality_gate.v1";
const DEFAULT_MAX_INITIAL_IMAGES = 2;
const STYLE_MARKER = /(?:动画|风格|3D|二维|卡通|电影级|cinematic|animation|style|render)/iu;
const SCENE_MARKER = /(?:场景|室内|室外|户外|室内外|客厅|卧室|厨房|浴室|门口|公园|街道|医院|商店|location|scene|interior|exterior|outdoor|indoor)/iu;
const TEXT_GUARD = /(?:无|不要|不得|禁止|不出现|不含|without|no)\s*(?:任何)?\s*(?:可读)?\s*(?:文字|字幕|标题|注释|标签|字母|数字|logo|水印|watermark)|(?:无字(?:图形|牌面|包装|画面)|可读文字数量为零|文字数量为0|零文字|no\s+readable\s+text)/iu;
const POSITIVE_TEXT = /(?:生成|包含|添加|出现|显示|写上|带有|加入|include|add|show|display)\S{0,12}(?:文字|字幕|标题|注释|标签|字母|数字|logo|水印|watermark)/giu;
const VIDEO_IMAGE_REFERENCE = /(?:(?:完整|当前|这张|该张)(?:的)?\s*(?:四格|五格|4格|5格)故事板|完整故事板|整张故事板|one\s+complete\s+storyboard|sole\s+image\s+reference|完整画面参考)/iu;
const TIMELINE_MARKER = /(?:\d+(?:\.\d+)?\s*(?:秒|s)?\s*(?:至|到|-|–|—)\s*\d+(?:\.\d+)?\s*(?:秒|s)?|\d+(?:\.\d+)?\s*秒)/iu;
const CAMERA_MARKER = /(?:镜头|机位|推近|拉远|跟拍|摇镜|横移|俯拍|仰拍|定镜|切换|camera|pan|tilt|dolly|tracking|zoom)/iu;
const END_MARKER = /(?:收束|落幅|停在|停留|最后|结尾|终止|结束状态|end\s*state|resolve|settle|hold\s+on)/iu;
const SOUND_MARKER = /(?:环境声|现场声|动作声|脚步声|呼吸声|水声|门声|无对白|不说话|sound|audio|diegetic)/iu;
const PANEL_FOUR = /(?:四格|4格|2\s*[x×]\s*2|two\s*by\s*two|2x2)/iu;
const PANEL_FIVE = /(?:五格|5格|四格.{0,12}(?:底部|下方).{0,12}(?:全宽|全景)|2\s*[x×]\s*2.{0,20}(?:底部|下方).{0,20}(?:全宽|全景)|four[_ -]?plus[_ -]?panorama)/iu;
const PANORAMA = /(?:底部|下方).{0,20}(?:全宽|全景|panorama)|(?:全宽|全景|panorama).{0,20}(?:底部|下方)/iu;
const WARDROBE_MARKER = /(?:时尚|学院|校服|preppy|smart\s*casual|针织|衬衫|西装|风衣|夹克|百褶|乐福|长裙|半裙|高领|材质|配饰|鞋|裤|裙|上衣|外套)/iu;
const LEGACY_WARDROBE = /(?:黄色?\s*(?:卫衣|上衣).{0,12}(?:蓝色?\s*)?牛仔裤|yellow\s+hoodie.{0,20}jeans|固定(?:黄色|黄)\s*(?:卫衣|上衣).{0,12}牛仔裤)/iu;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function firstDefined() {
  for (const value of arguments) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}
function normalized(value) {
  return asString(value).toLowerCase().replace(/\s+/gu, "");
}
function hasText(value, pattern) {
  return pattern.test(asString(value));
}
function deepOutputRoot(raw) {
  let current = asObject(raw);
  for (const field of ["machine_payload", "machinePayload", "project", "output", "result"]) {
    if (current[field] && typeof current[field] === "object" && !Array.isArray(current[field])) current = current[field];
  }
  return current;
}
function normalizeAssetPlan(root) {
  const raw = asObject(firstDefined(root.visualAssetPlan, root.visual_asset_plan, root.assetPlan, root.asset_plan));
  const assets = asArray(raw.assets).map((asset) => {
    const item = asObject(asset);
    return {
      id: asString(firstDefined(item.id, item.assetId, item.asset_id)),
      role: asString(firstDefined(item.role, item.assetRole, item.asset_role)),
      name: asString(item.name),
      identityLock: asString(firstDefined(item.identityLock, item.identity_lock)),
      sceneId: asString(firstDefined(item.sceneId, item.scene_id)),
    };
  });
  const rawPolicy = asObject(firstDefined(raw.generationPolicy, raw.generation_policy));
  const generationPolicy = Object.keys(rawPolicy).length > 0 ? {
    maxInitialImages: Number(firstDefined(rawPolicy.maxInitialImages, rawPolicy.max_initial_images, DEFAULT_MAX_INITIAL_IMAGES)),
    initialRequiredAssetIds: asArray(firstDefined(rawPolicy.initialRequiredAssetIds, rawPolicy.initial_required_asset_ids)).map(asString).filter(Boolean),
    initialDeferredAssetIds: asArray(firstDefined(rawPolicy.initialDeferredAssetIds, rawPolicy.initial_deferred_asset_ids)).map(asString).filter(Boolean),
    environmentAnchorPolicy: asString(firstDefined(rawPolicy.environmentAnchorPolicy, rawPolicy.environment_anchor_policy)),
    firstRoundRule: asString(firstDefined(rawPolicy.firstRoundRule, rawPolicy.first_round_rule)),
  } : null;
  const wardrobe = asObject(firstDefined(raw.wardrobe, raw.wardrobePlan, raw.wardrobe_plan, root.wardrobePlan, root.wardrobe_plan));
  return {
    mode: asString(firstDefined(raw.mode, root.visualAssetMode, root.visual_asset_mode)),
    assets,
    generationPolicy,
    wardrobe: {
      baseLook: asString(firstDefined(wardrobe.baseLook, wardrobe.base_look)),
      continuityRule: asString(firstDefined(wardrobe.continuityRule, wardrobe.continuity_rule)),
      changeEvents: asArray(firstDefined(wardrobe.changeEvents, wardrobe.change_events)),
    },
  };
}
function normalizeSegment(segment, index, root) {
  const item = asObject(segment);
  const beats = asArray(firstDefined(item.beats, item.shots));
  const panelMode = asString(firstDefined(item.panelMode, item.panel_mode, root.panelMode, root.panel_mode));
  const rawCount = firstDefined(item.panelCount, item.panel_count, beats.length || undefined);
  const panelCount = Number(rawCount);
  const imagePrompt = asString(firstDefined(item.storyboardImagePrompt, item.imagePrompt, item.storyboard_image_prompt, item.image_prompt));
  const videoPrompt = asString(firstDefined(item.videoPrompt, item.imageToVideoPrompt, item.image_to_video_prompt));
  const refs = asArray(firstDefined(item.visualAssetRefs, item.visual_asset_refs)).map((ref) => {
    const value = asObject(ref);
    return {
      assetId: asString(firstDefined(value.assetId, value.asset_id, value.id)),
      role: asString(value.role),
      sceneId: asString(firstDefined(value.sceneId, value.scene_id)),
    };
  });
  return {
    index: index + 1,
    order: Number(firstDefined(item.order, item.sourceNumber, item.source_number, index + 1)),
    narration: asString(firstDefined(item.narration, item.sourceText, item.source_text)),
    panelMode,
    panelCount: Number.isFinite(panelCount) ? panelCount : null,
    bottomPanelRole: asString(firstDefined(item.bottomPanelRole, item.bottom_panel_role)),
    styleLock: asString(firstDefined(item.styleLock, item.style_lock)),
    sceneLock: asString(firstDefined(item.sceneLock, item.scene_lock)),
    sceneId: asString(firstDefined(item.sceneId, item.scene_id)),
    imagePrompt,
    videoPrompt,
    refs,
    qualityChecks: asArray(firstDefined(item.qualityChecks, item.quality_checks)),
    qualityScore: Number(firstDefined(item.qualityScore, item.quality_score, NaN)),
    qualityVerdict: asString(firstDefined(item.qualityVerdict, item.quality_verdict)),
  };
}
function outputModel(raw) {
  const root = deepOutputRoot(raw);
  const assetPlan = normalizeAssetPlan(root);
  const sceneAnchors = asArray(firstDefined(root.scenePlan, root.scene_plan, root.environmentGroups, root.environment_groups)).map((scene) => {
    const item = asObject(scene);
    return {
      anchorRequired: Boolean(firstDefined(item.anchorRequired, item.anchor_required, false)),
      anchorAssetId: asString(firstDefined(item.anchorAssetId, item.anchor_asset_id)),
    };
  });
  return {
    root,
    assetPlan,
    sceneAnchors,
    segments: asArray(root.segments).map((segment, index) => normalizeSegment(segment, index, root)),
    panelMode: asString(firstDefined(root.panelMode, root.panel_mode)),
    version: asString(root.version),
  };
}
function lockCoverage(prompt, lock, marker) {
  const p = normalized(prompt);
  const l = normalized(lock);
  if (!l) return false;
  if (p.includes(l)) return true;
  const prefix = l.slice(0, Math.min(8, l.length));
  if (prefix.length >= 4 && p.includes(prefix)) return true;
  return marker.test(prompt) && p.includes(l.slice(0, Math.min(4, l.length)));
}
function panelModeOf(segment, model) {
  if (segment.panelMode) return segment.panelMode;
  if (segment.panelCount === 4) return "fixed-4";
  if (segment.panelCount === 5) return "fixed-5";
  return model.panelMode;
}
function negativeTextGuard(prompt) {
  return hasText(prompt, TEXT_GUARD);
}
function positiveTextRequest(prompt) {
  const source = asString(prompt);
  for (const match of source.matchAll(POSITIVE_TEXT)) {
    const start = Number(match.index || 0);
    const prefix = source.slice(Math.max(0, start - 6), start);
    if (/(?:不|无|勿|禁止|不得|避免|without|no)\s*$/iu.test(prefix)) continue;
    return true;
  }
  return false;
}
function addCheck(list, id, passed, weight, severity, detail) {
  list.push({ id, passed: Boolean(passed), weight, severity, detail });
}
function checkPanel(segment, model) {
  const mode = panelModeOf(segment, model);
  const image = segment.imagePrompt;
  const count = segment.panelCount;
  if (mode === "fixed-4" || count === 4) {
    const passed = PANEL_FOUR.test(image) && !PANORAMA.test(image) && !/(?:五格|5格)/iu.test(image) && (count === null || count === 4);
    return { passed, detail: passed ? "fixed-4/2×2，无底部全景格" : "四格必须是2×2且不得声明底部全景格" };
  }
  if (mode === "fixed-5" || count === 5) {
    const passed = PANEL_FIVE.test(image) && PANORAMA.test(image) && (count === null || count === 5);
    return { passed, detail: passed ? "fixed-5=2×2+底部全宽语义格" : "五格必须声明2×2+底部全宽/全景语义格" };
  }
  return { passed: false, detail: "缺少 fixed-4/fixed-5 或 panelCount" };
}
function scoreChecks(checks) {
  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const score = total > 0 ? Math.round((earned / total) * 1000) / 10 : 0;
  const criticalFailures = checks.filter((check) => !check.passed && check.severity === "critical").map((check) => check.id);
  const status = criticalFailures.length > 0 ? "fail" : score >= 90 ? "pass" : "revise";
  return {
    score,
    status,
    criticalFailures,
    passedChecks: checks.filter((check) => check.passed).length,
    totalChecks: checks.length,
  };
}
function evaluate(raw) {
  const model = outputModel(raw);
  const checks = [];
  const plan = model.assetPlan;
  const selectedMode = plan.mode === "selected";
  addCheck(checks, "segments_present", model.segments.length > 0, 8, "critical", model.segments.length > 0 ? model.segments.length + " 个分段" : "没有分段");
  addCheck(checks, "visual_asset_plan_present", selectedMode ? plan.assets.length > 0 : true, 5, "warning", selectedMode ? "视觉资产 " + plan.assets.length + " 个" : "视觉资产模式为 off，资产门禁未启用");
  const ids = new Set(plan.assets.map((asset) => asset.id).filter(Boolean));
  addCheck(checks, "visual_asset_ids_unique", !selectedMode || (ids.size === plan.assets.length && ids.size > 0), 4, "critical", !selectedMode ? "visualAssetMode=off，不进入资产生成门" : (ids.size === plan.assets.length && ids.size > 0 ? "资产 id 唯一" : "资产 id 缺失或重复"));
  const policy = plan.generationPolicy;
  if (selectedMode) {
    addCheck(checks, "generation_policy_present", Boolean(policy), 7, "critical", policy ? "首轮生成策略已声明" : "selected 模式缺少 generationPolicy");
    if (policy) {
      const required = policy.initialRequiredAssetIds;
      const deferred = policy.initialDeferredAssetIds;
      const unknownRequired = required.filter((id) => !ids.has(id));
      const unknownDeferred = deferred.filter((id) => !ids.has(id));
      const overlap = required.filter((id) => deferred.includes(id));
      const budgetOk = Number.isInteger(policy.maxInitialImages) && policy.maxInitialImages >= 0 && policy.maxInitialImages <= 16;
      addCheck(checks, "generation_policy_budget", budgetOk, 5, "critical", budgetOk ? "maxInitialImages=" + policy.maxInitialImages : "maxInitialImages 必须是 0..16 的整数");
      addCheck(checks, "generation_policy_asset_sets", unknownRequired.length === 0 && unknownDeferred.length === 0 && overlap.length === 0, 6, "critical", unknownRequired.length || unknownDeferred.length || overlap.length ? "required/deferred 无效：" + [...unknownRequired, ...unknownDeferred, ...overlap].join(",") : "required/deferred 引用合法且互斥");
      const identityAndAnchors = plan.assets.filter((asset) => /^(?:character|pet|人物|宠物)$/iu.test(asset.role) || asset.anchorRequired).map((asset) => asset.id).filter(Boolean).concat(model.sceneAnchors.filter((scene) => scene.anchorRequired).map((scene) => scene.anchorAssetId).filter(Boolean));
      const missingRequired = identityAndAnchors.filter((id) => !required.includes(id));
      addCheck(checks, "generation_policy_required_coverage", missingRequired.length === 0, 6, "critical", missingRequired.length ? "首轮策略漏掉人物/宠物或必需环境锚点：" + missingRequired.join(",") : "首轮策略覆盖人物、宠物与必需环境锚点");
      const countOk = required.length <= policy.maxInitialImages;
      addCheck(checks, "generation_policy_first_round_count", countOk, 8, "critical", countOk ? "首轮最多 " + policy.maxInitialImages + " 张，声明必需 " + required.length + " 张" : "首轮必需 " + required.length + " 张超过上限 " + policy.maxInitialImages);
      const noPerSegment = !/per[-_ ]?segment|每段(?:自动|各自).{0,8}生成环境图/iu.test(policy.firstRoundRule) && /(?:never|不得|不(?:要|按)).{0,12}(?:每段|segment)/iu.test(policy.firstRoundRule);
      addCheck(checks, "generation_policy_no_per_segment_auto_gen", noPerSegment, 4, "warning", policy.firstRoundRule ? "首轮规则已提供" : "首轮规则未明确禁止按分段生成环境图");
    }
  }
  const wardrobeText = [plan.wardrobe.baseLook, plan.wardrobe.continuityRule].concat(plan.assets.map((asset) => asset.identityLock)).join("；");
  addCheck(checks, "wardrobe_plan_explicit", selectedMode ? Boolean(plan.wardrobe.baseLook && plan.wardrobe.continuityRule) : true, 5, "warning", selectedMode ? (plan.wardrobe.baseLook && plan.wardrobe.continuityRule ? "着装计划含文案派生造型与连续性规则" : "缺少 wardrobe.baseLook 或 continuityRule") : "未启用视觉资产模式");
  addCheck(checks, "wardrobe_style_intent", selectedMode ? WARDROBE_MARKER.test(wardrobeText) : true, 3, "warning", selectedMode ? (WARDROBE_MARKER.test(wardrobeText) ? "着装包含时尚/学院风或明确服装材质与单品" : "着装描述过于泛化，未体现时尚/学院风或明确单品") : "未启用视觉资产模式");
  addCheck(checks, "wardrobe_legacy_default_absent", !LEGACY_WARDROBE.test(wardrobeText), 5, "critical", LEGACY_WARDROBE.test(wardrobeText) ? "仍使用固定黄上衣/牛仔裤旧默认" : "未发现固定黄上衣/牛仔裤旧默认");
  for (const [index, segment] of model.segments.entries()) {
    const label = "segment_" + String(index + 1).padStart(2, "0");
    addCheck(checks, label + ".narration_present", Boolean(segment.narration), 3, "critical", segment.narration ? "口播段落存在" : "缺少口播段落");
    addCheck(checks, label + ".image_prompt_present", segment.imagePrompt.length >= 80, 5, "critical", segment.imagePrompt.length >= 80 ? "生图提示词 " + segment.imagePrompt.length + " 字符" : "生图提示词缺失或过短");
    addCheck(checks, label + ".video_prompt_present", segment.videoPrompt.length >= 80, 5, "critical", segment.videoPrompt.length >= 80 ? "视频提示词 " + segment.videoPrompt.length + " 字符" : "视频提示词缺失或过短");
    addCheck(checks, label + ".image_style_lock", Boolean(segment.styleLock) && lockCoverage(segment.imagePrompt, segment.styleLock, STYLE_MARKER), 5, "warning", Boolean(segment.styleLock) && lockCoverage(segment.imagePrompt, segment.styleLock, STYLE_MARKER) ? "生图提示词包含紧凑风格锁" : "生图提示词缺少 styleLock 或未重复风格锚点");
    addCheck(checks, label + ".image_scene_lock", Boolean(segment.sceneLock) && lockCoverage(segment.imagePrompt, segment.sceneLock, SCENE_MARKER), 5, "warning", Boolean(segment.sceneLock) && lockCoverage(segment.imagePrompt, segment.sceneLock, SCENE_MARKER) ? "生图提示词包含紧凑场景锁" : "生图提示词缺少 sceneLock 或未重复场景锚点");
    addCheck(checks, label + ".video_style_lock", Boolean(segment.styleLock) && lockCoverage(segment.videoPrompt, segment.styleLock, STYLE_MARKER), 4, "warning", Boolean(segment.styleLock) && lockCoverage(segment.videoPrompt, segment.styleLock, STYLE_MARKER) ? "视频提示词重复风格漂移保护" : "视频提示词缺少风格漂移保护");
    addCheck(checks, label + ".video_scene_lock", Boolean(segment.sceneLock) && lockCoverage(segment.videoPrompt, segment.sceneLock, SCENE_MARKER), 4, "warning", Boolean(segment.sceneLock) && lockCoverage(segment.videoPrompt, segment.sceneLock, SCENE_MARKER) ? "视频提示词重复场景锁" : "视频提示词缺少场景锁");
    const imageGuard = negativeTextGuard(segment.imagePrompt);
    const imageNoPositiveText = !positiveTextRequest(segment.imagePrompt);
    addCheck(checks, label + ".image_pure_visual_no_text", imageGuard && imageNoPositiveText, 6, "critical", imageGuard && imageNoPositiveText ? "纯视觉模式：明确禁止可读文字且无正向文字生成指令" : "生图提示词缺少纯视觉无字门禁或含正向文字生成指令");
    addCheck(checks, label + ".video_no_text_pollution", !positiveTextRequest(segment.videoPrompt), 3, "critical", !positiveTextRequest(segment.videoPrompt) ? "视频提示词无文字污染指令" : "视频提示词包含文字生成指令");
    const panel = checkPanel(segment, model);
    addCheck(checks, label + ".panel_layout", panel.passed, 7, "critical", panel.detail);
    const knownRefs = segment.refs.length > 0 && segment.refs.every((ref) => ids.has(ref.assetId));
    addCheck(checks, label + ".visual_asset_refs_known", selectedMode ? knownRefs : true, 6, "critical", selectedMode ? (knownRefs ? "所有视觉资产引用均在计划内" : "存在缺失或未知视觉资产引用") : "未启用视觉资产模式");
    const environmentRefs = segment.refs.filter((ref) => /environment|环境/iu.test(ref.role));
    const scoped = environmentRefs.every((ref) => ref.sceneId && (!segment.sceneId || ref.sceneId === segment.sceneId));
    addCheck(checks, label + ".environment_ref_scene_scoped", environmentRefs.length === 0 || scoped, 3, "warning", environmentRefs.length === 0 ? "本段无需环境资产引用" : scoped ? "环境资产按 sceneId 绑定" : "环境资产缺少或错配 sceneId");
    const videoComplete = VIDEO_IMAGE_REFERENCE.test(segment.videoPrompt);
    addCheck(checks, label + ".video_complete_storyboard_reference", videoComplete, 5, "critical", videoComplete ? "视频使用完整故事板单图作为唯一参考" : "视频提示词未声明完整故事板单图参考边界");
    addCheck(checks, label + ".video_timeline", TIMELINE_MARKER.test(segment.videoPrompt), 4, "warning", TIMELINE_MARKER.test(segment.videoPrompt) ? "包含秒级时间线" : "缺少秒级时间线");
    addCheck(checks, label + ".video_camera", CAMERA_MARKER.test(segment.videoPrompt), 3, "warning", CAMERA_MARKER.test(segment.videoPrompt) ? "包含镜头/机位执行" : "缺少镜头运动或机位");
    addCheck(checks, label + ".video_end_state", END_MARKER.test(segment.videoPrompt), 4, "critical", END_MARKER.test(segment.videoPrompt) ? "包含结束状态/落幅" : "缺少视频结束状态");
    addCheck(checks, label + ".video_sound", SOUND_MARKER.test(segment.videoPrompt), 2, "warning", SOUND_MARKER.test(segment.videoPrompt) ? "包含物理现场声边界" : "缺少现场声/无对白边界");
    addCheck(checks, label + ".quality_checks_declared", segment.qualityChecks.length > 0, 2, "warning", segment.qualityChecks.length > 0 ? "质量检查已声明" : "缺少机器可读质量检查");
    const scorePass = Number.isInteger(segment.qualityScore) && segment.qualityScore >= 90 && segment.qualityScore <= 100 && segment.qualityVerdict === "pass";
    addCheck(checks, label + ".quality_score_gate", scorePass, 5, "critical", scorePass ? `质量评分 ${segment.qualityScore}/100，判定 pass` : "质量评分必须为90-100且 qualityVerdict=pass");
  }
  const summary = scoreChecks(checks);
  return {
    schemaVersion: SCHEMA_VERSION,
    evaluatedAt: new Date().toISOString(),
    source: "static contract inspection; no model call, no media generation, no billing",
    status: summary.status,
    score: summary.score,
    passedChecks: summary.passedChecks,
    totalChecks: summary.totalChecks,
    criticalFailures: summary.criticalFailures,
    failedChecks: checks.filter((check) => !check.passed).map((check) => ({ id: check.id, severity: check.severity, detail: check.detail })),
    model: {
      version: model.version || null,
      segmentCount: model.segments.length,
      panelMode: model.panelMode || null,
      visualAssetMode: plan.mode || null,
      visualAssetCount: plan.assets.length,
      initialRequiredAssetCount: plan.generationPolicy ? plan.generationPolicy.initialRequiredAssetIds.length : null,
      maxInitialImages: plan.generationPolicy ? plan.generationPolicy.maxInitialImages : null,
    },
    checks,
  };
}
function fixture() {
  const styleLock = "电影级3D卡通动画，柔和电影光影，干净材质";
  const sceneLock = "scene_home，室内客厅，窗边与沙发固定锚点";
  return {
    version: "storyboard-director-v2.6.0",
    panelMode: "fixed-4",
    visualAssetPlan: {
      mode: "selected",
      assets: [
        { id: "character_main", role: "character", identityLock: "短黑发、学院风针织外套与乐福鞋" },
        { id: "pet_main", role: "pet", identityLock: "金毛犬、红色项圈" },
      ],
      generationPolicy: {
        maxInitialImages: 2,
        initialRequiredAssetIds: ["character_main", "pet_main"],
        initialDeferredAssetIds: [],
        environmentAnchorPolicy: "per-scene-when-required",
        firstRoundRule: "人物和宠物各一张首轮参考；不得按每段生成环境图。",
      },
      wardrobe: {
        baseLook: "文案派生的学院风针织外套、百褶裙与乐福鞋",
        continuityRule: "同一场景锁定造型，明确换场才换装",
      },
    },
    segments: [{
      order: 1,
      narration: "主人观察宠物状态。",
      panelMode: "fixed-4",
      panelCount: 4,
      styleLock: styleLock,
      sceneLock: sceneLock,
      storyboardImagePrompt: "完整四格2x2故事板；" + styleLock + "；" + sceneLock + "；人物与宠物保持身份参考；无任何可读文字、字幕、标题或水印。",
      videoPrompt: "从完整四格故事板单图开始，保持" + styleLock + "与" + sceneLock + "；0至3秒镜头推近，3至7秒跟拍主体动作，7至10秒停在稳定收束状态；保留脚步声与呼吸声，无对白。",
      visualAssetRefs: [{ assetId: "character_main", role: "character" }, { assetId: "pet_main", role: "pet" }],
      qualityChecks: [{ checkId: "scene_binding", status: "pass" }],
      qualityScore: 95,
      qualityVerdict: "pass",
    }],
  };
}
async function parseArgs() {
  const args = process.argv.slice(2);
  const selfTest = args.includes("--self-test");
  const reportIndex = args.indexOf("--report");
  const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : "";
  const inputPath = args.find((arg) => !arg.startsWith("--") && arg !== reportPath);
  return { selfTest: selfTest, inputPath: inputPath, reportPath: reportPath };
}
async function main() {
  const args = await parseArgs();
  if (args.selfTest) {
    const good = evaluate(fixture());
    assert.equal(good.status, "pass", JSON.stringify(good.failedChecks, null, 2));
    const bad = fixture();
    bad.visualAssetPlan.generationPolicy.maxInitialImages = 1;
    bad.segments[0].storyboardImagePrompt = bad.segments[0].storyboardImagePrompt.replace("无任何可读文字、字幕、标题或水印。", "添加醒目标题文字。");
    const badResult = evaluate(bad);
    assert.equal(badResult.status, "fail");
    console.log(JSON.stringify({ passed: true, schemaVersion: SCHEMA_VERSION, selfTest: { passScore: good.score, failStatus: badResult.status, failCritical: badResult.criticalFailures } }, null, 2));
    return;
  }
  if (!args.inputPath) {
    console.error("Usage: pnpm exec node scripts/verify-storyboard-output-quality-gate.mjs <output.json> [--report <report.json>]");
    process.exitCode = 2;
    return;
  }
  const source = JSON.parse(await fs.readFile(path.resolve(args.inputPath), "utf8"));
  const report = evaluate(source);
  if (args.reportPath) {
    const destination = path.resolve(args.reportPath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "fail") process.exitCode = 2;
  else if (report.status === "revise") process.exitCode = 1;
}
main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 2;
});
