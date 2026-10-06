import {
  GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
  PET_SILENT_NARRATION_PROFILE_ID,
  type GeneralScriptCharacter,
  type GeneralScriptEpisode,
  type GeneralScriptProp,
  type GeneralScriptRequest,
  type GeneralScriptResult,
  type GeneralScriptScene,
} from "./general-script-contract";

function excerpt(value: string, fallback: string, maximum = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > maximum ? normalized.slice(0, maximum) + "…" : normalized;
}

function cloneResult(result: GeneralScriptResult): GeneralScriptResult {
  return JSON.parse(JSON.stringify(result)) as GeneralScriptResult;
}

function effectiveTone(request: GeneralScriptRequest): string {
  return request.settings.tone === "custom"
    ? request.settings.customTone
    : request.settings.tone;
}

function makeEpisode(
  request: GeneralScriptRequest,
  episodeNumber: number,
  characterNames: string[],
  sceneNames: string[],
  propNames: string[],
): GeneralScriptEpisode {
  const silentNarration = request.profile.id === PET_SILENT_NARRATION_PROFILE_ID;
  const theme = excerpt(
    request.content.brief || request.content.sourceMaterial,
    "主角在日常困境中发现改变命运的线索",
  );
  const sourceHint = request.settings.creationMode === "adaptation"
    ? "本集依据用户素材中的主题和事实重新组织情节。"
    : "本集沿用原创项目设定推进核心冲突。";
  const currentMax = request.existingResult
    ? Math.max(...request.existingResult.episodes.map((episode) => episode.episodeNumber))
    : 0;
  const expectedFinalNumber = request.settings.totalEpisodes
    ?? currentMax + request.settings.episodesToGenerate;
  const finalEpisode = request.settings.isFinale && expectedFinalNumber === episodeNumber;

  if (silentNarration) {
    return {
      episodeNumber,
      title: "第" + episodeNumber + "集：动作里的答案",
      logline: "围绕“" + theme + "”用宠物的动作、表情与语义道具推进叙事。",
      content: [
        "【场景一｜" + (sceneNames[0] || "主场景") + "｜日】",
        "宠物保持闭嘴，耳朵轻轻后压，视线从空食盆移向门口；照料者蹲下后也不说话，只把磨损的物件放到它面前。",
        "【后期旁白】有些等待不会发出声音，却会留在每天重复的动作里。",
        "",
        "【场景二｜" + (sceneNames[1] || sceneNames[0] || "转折场景") + "｜夜】",
        "宠物仍不张嘴，不做任何对白口型。它先后退半步，再用鼻尖推动“" + (propNames[0] || "线索物件") + "”，物件停在灯光边缘。",
        "照料者通过视线、手势和走位回应，环境光随决定变暖。",
        "【后期旁白】" + sourceHint,
        finalEpisode
          ? "角色以拥抱和安静停留完成情感闭环，全部语言只由后期旁白承担。"
          : "门外影子掠过，宠物立刻转身注视，为下一集留下无口型的动作悬念。",
      ].join("\n"),
      endingHook: finalEpisode ? "动作与语义道具完成情感闭环。" : "宠物的视线锁定门外新线索。",
      estimatedDurationSeconds: 75,
      characterNames,
      sceneNames,
      propNames,
    };
  }

  return {
    episodeNumber,
    title: "第" + episodeNumber + "集：线索推进",
    logline: "围绕“" + theme + "”推进一次可见的选择与后果。",
    content: [
      "【场景一｜" + (sceneNames[0] || "主场景") + "｜日】",
      "主角从一个具体异常开始追查，动作和环境反应共同交代冲突。",
      "主角：我需要先确认这条线索究竟指向哪里。",
      "",
      "【场景二｜" + (sceneNames[1] || sceneNames[0] || "转折场景") + "｜夜】",
      sourceHint,
      "关键物件“" + (propNames[0] || "线索物件") + "”触发新的信息，角色作出本集最重要的决定。",
      finalEpisode
        ? "主冲突得到回应，人物完成选择，故事形成闭环。"
        : "新的风险在决定之后浮现，为下一集留下可验证的悬念。",
    ].join("\n"),
    endingHook: finalEpisode ? "核心冲突完成闭环。" : "线索指向一个尚未揭开的新目标。",
    estimatedDurationSeconds: 90,
    characterNames,
    sceneNames,
    propNames,
  };
}

function baseCharacters(silentNarration = false): GeneralScriptCharacter[] {
  if (silentNarration) {
    return [
      {
        id: "char-pet",
        name: "团团",
        role: "宠物主角",
        profile: "通过视线、耳尾变化、走位和与语义道具的互动承担主要叙事。",
        personality: "敏感、好奇、依恋但有行动力",
        appearance: "轮廓清楚的暖棕色小狗，项圈有可持续识别的磨损细节。",
        voiceDirection: "不发声、不张嘴、不做对白口型；所有语言由后期旁白完成。",
      },
      {
        id: "char-carer",
        name: "照料者",
        role: "无对白配角",
        profile: "通过手势、表情、视线和空间距离回应宠物，不承担口头对白。",
        personality: "温和、克制、观察细致",
        appearance: "简洁家居服装，手部动作清晰，面部表演自然克制。",
        voiceDirection: "不说话、不做对白口型；语言信息由后期旁白承担，只保留呼吸、脚步等非语言声音。",
      },
    ];
  }
  return [
    {
      id: "char-lead",
      name: "林岚",
      role: "主角",
      profile: "行动型观察者，面对现实压力时仍坚持查清事实。",
      personality: "克制、敏锐、有韧性",
      appearance: "利落日常装束，神态专注，具有清晰可辨的轮廓特征。",
      voiceDirection: "自然口语，中速，关键判断前短暂停顿。",
    },
    {
      id: "char-partner",
      name: "周砚",
      role: "搭档",
      profile: "为主角提供另一种判断视角，并推动关键证据进入情节。",
      personality: "谨慎、务实、有同理心",
      appearance: "简洁深色服装，表情沉稳，动作幅度较小。",
      voiceDirection: "低沉清晰，语速平稳，避免夸张表演。",
    },
  ];
}

function baseScenes(episodeNumbers: number[]): GeneralScriptScene[] {
  return [
    {
      id: "scene-workroom",
      name: "临时工作间",
      description: "可进行资料核对与人物对谈的安静空间，桌面保留可见线索。",
      time: "日间",
      atmosphere: "专注、逐步升温",
      episodeNumbers,
    },
    {
      id: "scene-corridor",
      name: "旧楼走廊",
      description: "纵深明显的过渡空间，适合发现异常与制造视线遮挡。",
      time: "夜间",
      atmosphere: "克制、悬念",
      episodeNumbers,
    },
  ];
}

function baseProps(
  episodeNumbers: number[],
  silentNarration = false,
): GeneralScriptProp[] {
  return [
    {
      id: "prop-notebook",
      name: silentNarration ? "磨损的红色项圈" : "旧笔记本",
      category: "线索道具",
      description: silentNarration
        ? "磨损程度与光线变化承载等待和被记住的语义，不作为普通装饰。"
        : "记录被涂改的时间与地点，是人物推进调查的可视化证据。",
      episodeNumbers,
    },
  ];
}

function buildInitialFixture(request: GeneralScriptRequest): GeneralScriptResult {
  const episodeNumbers = Array.from(
    { length: request.settings.episodesToGenerate },
    (_, index) => index + 1,
  );
  const silentNarration = request.profile.id === PET_SILENT_NARRATION_PROFILE_ID;
  const characters = baseCharacters(silentNarration);
  const scenes = baseScenes(episodeNumbers);
  const props = baseProps(episodeNumbers, silentNarration);
  const characterNames = characters.map((item) => item.name);
  const sceneNames = scenes.map((item) => item.name);
  const propNames = props.map((item) => item.name);
  const title = request.content.title || "线索之外";
  const premise = excerpt(
    request.content.brief || request.content.sourceMaterial,
    "普通人在一次意外发现后重新选择自己的方向",
    300,
  );

  return {
    schemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
    profileId: request.profile.id,
    operation: request.operation,
    summary: {
      title,
      protagonist: silentNarration
        ? "团团：依靠表情、动作和语义道具推进故事的宠物主角"
        : "林岚：在现实压力中仍坚持查清事实的行动型主角",
      oneSentence: premise,
      synopsis: "主角在现实困境中获得一条可验证的线索，并在搭档协助下逐步接近真相；每次选择都会带来新的代价。",
      genre: request.settings.genre,
      creationMode: request.settings.creationMode,
      targetAudience: request.settings.targetAudience,
      tone: effectiveTone(request),
      background: silentNarration
        ? "当代家庭与社区生活，以宠物和照料者的日常关系为情感基础。"
        : "当代城市生活，以普通人的工作与关系压力为故事基础。",
      setting: silentNarration
        ? "室内与社区过渡空间构成主要行动场域，语义道具和环境反馈推进叙事。"
        : "临时工作间与旧楼走廊构成主要行动空间，线索通过可见物件推进。",
      animationStyle: request.settings.animationStyle,
      videoSize: request.settings.videoSize,
      performanceMode: silentNarration ? "silent_narration" : "dialogue",
      totalEpisodes: request.settings.totalEpisodes,
      isFinale: request.settings.isFinale,
    },
    episodes: episodeNumbers.map((episodeNumber) =>
      makeEpisode(request, episodeNumber, characterNames, sceneNames, propNames),
    ),
    characters,
    scenes,
    props,
  };
}

function buildContinuationFixture(request: GeneralScriptRequest): GeneralScriptResult {
  const result = cloneResult(request.existingResult as GeneralScriptResult);
  const currentMax = Math.max(...result.episodes.map((episode) => episode.episodeNumber));
  const newNumbers = Array.from(
    { length: request.settings.episodesToGenerate },
    (_, index) => currentMax + index + 1,
  );

  const silentNarration = request.profile.id === PET_SILENT_NARRATION_PROFILE_ID;
  if (result.characters.length === 0) result.characters = baseCharacters(silentNarration);
  if (result.scenes.length === 0) result.scenes = baseScenes([]);
  if (result.props.length === 0) result.props = baseProps([], silentNarration);

  const characterNames = result.characters.slice(0, 2).map((item) => item.name);
  const sceneNames = result.scenes.slice(0, 2).map((item) => item.name);
  const propNames = result.props.slice(0, 1).map((item) => item.name);
  result.episodes.push(
    ...newNumbers.map((number) =>
      makeEpisode(request, number, characterNames, sceneNames, propNames),
    ),
  );

  for (const scene of result.scenes) {
    if (sceneNames.includes(scene.name)) {
      scene.episodeNumbers = Array.from(new Set([...scene.episodeNumbers, ...newNumbers])).sort(
        (a, b) => a - b,
      );
    }
  }
  for (const prop of result.props) {
    if (propNames.includes(prop.name)) {
      prop.episodeNumbers = Array.from(new Set([...prop.episodeNumbers, ...newNumbers])).sort(
        (a, b) => a - b,
      );
    }
  }

  result.operation = request.operation;
  result.profileId = request.profile.id;
  result.summary.totalEpisodes = request.settings.totalEpisodes;
  result.summary.isFinale = request.settings.isFinale;
  result.summary.creationMode = request.settings.creationMode;
  result.summary.genre = request.settings.genre;
  result.summary.tone = effectiveTone(request);
  result.summary.targetAudience = request.settings.targetAudience;
  result.summary.animationStyle = request.settings.animationStyle;
  result.summary.videoSize = request.settings.videoSize;
  result.summary.performanceMode = silentNarration ? "silent_narration" : "dialogue";
  return result;
}

function buildRewriteFixture(request: GeneralScriptRequest): GeneralScriptResult {
  const result = cloneResult(request.existingResult as GeneralScriptResult);
  const targets = new Set(request.rewriteEpisodeNumbers);
  const instruction = excerpt(request.rewriteInstruction, "增强冲突与动作因果", 500);

  result.episodes = result.episodes.map((episode) => {
    if (!targets.has(episode.episodeNumber)) return episode;
    return {
      ...episode,
      title: episode.title + "（重写）",
      logline: episode.logline + " 本次重点：" + instruction,
      content: [
        episode.content,
        "",
        "【重写落实】",
        instruction,
        "角色的新选择通过动作、环境反馈与后果被明确呈现。",
      ].join("\n"),
      endingHook: request.settings.isFinale
        ? "重写后的冲突形成闭环。"
        : "重写后的选择引出更明确的下一步风险。",
    };
  });
  result.operation = request.operation;
  result.profileId = request.profile.id;
  result.summary.totalEpisodes = request.settings.totalEpisodes;
  result.summary.isFinale = request.settings.isFinale;
  result.summary.creationMode = request.settings.creationMode;
  result.summary.genre = request.settings.genre;
  result.summary.tone = effectiveTone(request);
  result.summary.targetAudience = request.settings.targetAudience;
  result.summary.animationStyle = request.settings.animationStyle;
  result.summary.videoSize = request.settings.videoSize;
  result.summary.performanceMode = request.profile.id === PET_SILENT_NARRATION_PROFILE_ID
    ? "silent_narration"
    : "dialogue";
  return result;
}

export function createGeneralScriptFixture(request: GeneralScriptRequest): GeneralScriptResult {
  if (request.operation === "continue") return buildContinuationFixture(request);
  if (request.operation === "rewrite") return buildRewriteFixture(request);
  return buildInitialFixture(request);
}
