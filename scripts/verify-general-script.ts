import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GENERAL_SCRIPT_CONTRACT_VERSION,
  GENERAL_SCRIPT_PROFILE_ID,
  GENERAL_SCRIPT_PROFILE_VERSION,
  PET_SILENT_NARRATION_PROFILE_ID,
  parseGeneralScriptRequest,
  parseGeneralScriptResult,
  validateGeneralScriptResultForRequest,
  type GeneralScriptProfileId,
  type GeneralScriptRequest,
  type GeneralScriptResult,
} from "../src/lib/short-drama/general-script-contract";
import { createGeneralScriptFixture } from "../src/lib/short-drama/general-script-fixtures";
import { parseGeneralScriptLlmPayload } from "../src/lib/short-drama/general-script-llm";
import {
  buildGeneralScriptUserPrompt,
  getGeneralScriptPromptProfile,
} from "../src/lib/short-drama/general-script-profile";
import {
  applyProfileDefaultsToEmptyDraft,
  createDefaultGeneralScriptDraft,
} from "../src/features/general-script/types";

const repositoryRoot = process.cwd();

function rawRequest(
  profileId: GeneralScriptProfileId,
  operation: "generate" | "continue" | "rewrite",
  existingResult?: GeneralScriptResult,
): Record<string, unknown> {
  return {
    profile: {
      id: profileId,
      version: GENERAL_SCRIPT_PROFILE_VERSION,
    },
    operation,
    settings: {
      creationMode: "original",
      targetAudience: "all_ages",
      tone: profileId === PET_SILENT_NARRATION_PROFILE_ID ? "warm" : "suspense",
      customTone: "",
      genre: profileId === PET_SILENT_NARRATION_PROFILE_ID ? "宠物动画口播" : "剧情短剧",
      animationStyle: profileId === PET_SILENT_NARRATION_PROFILE_ID
        ? "商业级 3D 卡通动画"
        : "写实电影感",
      videoSize: "9:16",
      episodesToGenerate: profileId === PET_SILENT_NARRATION_PROFILE_ID
        ? 1
        : operation === "rewrite" ? 1 : 2,
      totalEpisodes: profileId === PET_SILENT_NARRATION_PROFILE_ID ? 1 : 8,
      isFinale: profileId === PET_SILENT_NARRATION_PROFILE_ID,
    },
    content: {
      title: profileId === PET_SILENT_NARRATION_PROFILE_ID ? "团团的等待" : "看不见的线索",
      brief: profileId === PET_SILENT_NARRATION_PROFILE_ID
        ? "一只小狗每天守在门口，最终通过旧项圈发现主人一直在寻找它。"
        : "主角发现工作记录被人改写，决定查清事实。",
      sourceMaterial: "",
      requirements: "每集都要有动作因果和结尾钩子。",
    },
    existingResult,
    rewriteEpisodeNumbers: operation === "rewrite" ? [1] : [],
    rewriteInstruction: operation === "rewrite" ? "增强动作因果，让语义道具承担转折。" : "",
  };
}

function fixtureFor(request: GeneralScriptRequest): GeneralScriptResult {
  return validateGeneralScriptResultForRequest(
    request,
    parseGeneralScriptResult(createGeneralScriptFixture(request)),
  );
}

async function verifyStaticContracts(): Promise<void> {
  const apiSource = await readFile(
    join(repositoryRoot, "src/app/api/short-drama/script/route.ts"),
    "utf8",
  );
  assert.match(
    apiSource,
    /process\.env\.SHORT_DRAMA_FIXTURE_MODE === "1"/,
    "fixture 模式必须只由 SHORT_DRAMA_FIXTURE_MODE=1 开启",
  );
  assert.match(
    apiSource,
    /new URL\("\/api\/llm", request\.url\)/,
    "real 模式必须复用主站 /api/llm",
  );
  assert.match(
    apiSource,
    /Authorization: authorization/,
    "real 模式必须原样转发 Authorization",
  );
  assert.doesNotMatch(
    apiSource,
    /api[_-]?key|secret/i,
    "新接口不得读取或保存模型密钥",
  );

  const petProfileText = await readFile(
    join(repositoryRoot, "prompts/short-drama/pet-silent-narration.v1.json"),
    "utf8",
  );
  for (const required of ["单条", "不张嘴", "不做对白口型", "后期旁白", "语义道具", "animationStyle", "videoSize", "protagonist"]) {
    assert.ok(petProfileText.includes(required), "宠物 Profile 缺少硬约束：" + required);
  }

  const uiSource = await readFile(
    join(repositoryRoot, "src/features/general-script/general-script-workbench.tsx"),
    "utf8",
  );
  for (const required of [
    "复制 JSON",
    "保存到影视工坊",
    "/api/short-drama/projects/import-script",
    "/storyboard-workbench?entry=short-drama&handoff=general-script",
    "clientRequestId",
    "lastExecutionMode",
    "response.ok",
    "findProjectHref",
    "executionMode !== \"real\"",
    "useSearchParams",
    "searchParams.get(\"profile\")",
    "whitelistedProfile",
    "applyProfileDefaultsToEmptyDraft",
    "createDefaultGeneralScriptDraft",
    "单条视频",
    "PET_SILENT_NARRATION_PROFILE_ID",
  ]) {
    assert.ok(uiSource.includes(required), "页面缺少能力：" + required);
  }

  const pageSource = await readFile(
    join(repositoryRoot, "src/app/tools/text/general-script/page.tsx"),
    "utf8",
  );
  assert.ok(pageSource.includes("GeneralScriptOfficial"), "通用短剧路由必须挂载当前正式工作台");
  assert.ok(pageSource.includes("AppRouteShell"), "通用短剧路由必须保留主站外壳");
  assert.ok(
    !pageSource.includes("useSearchParams") || pageSource.includes("Suspense"),
    "仅当路由页面直接使用 useSearchParams 时才必须提供 Suspense 边界",
  );
}

async function verifyFixtureRoute(requestBody: Record<string, unknown>): Promise<void> {
  const previousMode = process.env.SHORT_DRAMA_FIXTURE_MODE;
  process.env.SHORT_DRAMA_FIXTURE_MODE = "1";
  try {
    const route = await import("../src/app/api/short-drama/script/route");
    const response = await route.POST(
      new Request("http://127.0.0.1/api/short-drama/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      }),
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      ok?: boolean;
      executionMode?: string;
      result?: unknown;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.executionMode, "fixture");
    parseGeneralScriptResult(payload.result);
  } finally {
    if (previousMode === undefined) {
      delete process.env.SHORT_DRAMA_FIXTURE_MODE;
    } else {
      process.env.SHORT_DRAMA_FIXTURE_MODE = previousMode;
    }
  }

  process.env.SHORT_DRAMA_FIXTURE_MODE = "true";
  try {
    const route = await import("../src/app/api/short-drama/script/route");
    const response = await route.POST(
      new Request("http://127.0.0.1/api/short-drama/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      }),
    );
    assert.equal(
      response.status,
      401,
      "SHORT_DRAMA_FIXTURE_MODE=true 不得开启 fixture；无 Authorization 应被拒绝",
    );
  } finally {
    if (previousMode === undefined) {
      delete process.env.SHORT_DRAMA_FIXTURE_MODE;
    } else {
      process.env.SHORT_DRAMA_FIXTURE_MODE = previousMode;
    }
  }
}

async function verifyStudioImportFixture(result: GeneralScriptResult): Promise<void> {
  const previousMode = process.env.SHORT_DRAMA_FIXTURE_MODE;
  process.env.SHORT_DRAMA_FIXTURE_MODE = "1";
  try {
    const { NextRequest } = await import("next/server");
    const route = await import("../src/app/api/short-drama/projects/import-script/route");
    const response = await route.POST(
      new NextRequest("http://127.0.0.1/api/short-drama/projects/import-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: "verify-general-script-001",
          title: result.summary.title,
          result,
        }),
      }),
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      ok?: boolean;
      executionMode?: string;
      href?: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.executionMode, "fixture");
    assert.match(
      payload.href || "",
      /^\/tools\/film-studio\/projects\/fixture-[0-9a-f]{20}\?step=script$/,
    );
  } finally {
    if (previousMode === undefined) {
      delete process.env.SHORT_DRAMA_FIXTURE_MODE;
    } else {
      process.env.SHORT_DRAMA_FIXTURE_MODE = previousMode;
    }
  }
}

async function main(): Promise<void> {
  assert.equal(GENERAL_SCRIPT_CONTRACT_VERSION, "general-script-contract.v1");

  const generalProfile = getGeneralScriptPromptProfile(GENERAL_SCRIPT_PROFILE_ID);
  const petProfile = getGeneralScriptPromptProfile(PET_SILENT_NARRATION_PROFILE_ID);
  assert.equal(generalProfile.version, "1.0.0");
  assert.equal(petProfile.version, "1.0.0");
  assert.notEqual(generalProfile.systemPrompt, petProfile.systemPrompt);

  const generalDefaultDraft = createDefaultGeneralScriptDraft(GENERAL_SCRIPT_PROFILE_ID);
  assert.equal(generalDefaultDraft.episodesToGenerate, 5);
  assert.equal(generalDefaultDraft.totalEpisodes, "");
  assert.equal(generalDefaultDraft.isFinale, false);

  const petDefaultDraft = createDefaultGeneralScriptDraft(PET_SILENT_NARRATION_PROFILE_ID);
  assert.equal(petDefaultDraft.episodesToGenerate, 1);
  assert.equal(petDefaultDraft.totalEpisodes, "1");
  assert.equal(petDefaultDraft.isFinale, true);
  assert.equal(petDefaultDraft.genre, "宠物动画口播");

  const preservedMeaningfulDraft = applyProfileDefaultsToEmptyDraft(
    {
      ...generalDefaultDraft,
      brief: "这是已经填写的有效草稿，不得覆盖用户集数设置。",
      episodesToGenerate: 3,
      totalEpisodes: "12",
      isFinale: false,
    },
    PET_SILENT_NARRATION_PROFILE_ID,
  );
  assert.equal(preservedMeaningfulDraft.profileId, PET_SILENT_NARRATION_PROFILE_ID);
  assert.equal(preservedMeaningfulDraft.episodesToGenerate, 3);
  assert.equal(preservedMeaningfulDraft.totalEpisodes, "12");
  assert.equal(preservedMeaningfulDraft.isFinale, false);

  const initialRequest = parseGeneralScriptRequest(
    rawRequest(GENERAL_SCRIPT_PROFILE_ID, "generate"),
  );
  const initialResult = fixtureFor(initialRequest);
  assert.equal(initialResult.episodes.length, 2);
  assert.ok(initialResult.summary.protagonist.includes("林岚"));
  assert.equal(initialResult.episodes[0]?.episodeNumber, 1);
  assert.ok(initialResult.characters.length > 0);
  assert.ok(initialResult.scenes.length > 0);
  assert.ok(initialResult.props.length > 0);

  const continueRequest = parseGeneralScriptRequest(
    rawRequest(GENERAL_SCRIPT_PROFILE_ID, "continue", initialResult),
  );
  const continueResult = fixtureFor(continueRequest);
  assert.deepEqual(
    continueResult.episodes.map((episode) => episode.episodeNumber),
    [1, 2, 3, 4],
  );

  const petInitialRequest = parseGeneralScriptRequest(
    rawRequest(PET_SILENT_NARRATION_PROFILE_ID, "generate"),
  );
  const petInitialResult = fixtureFor(petInitialRequest);
  assert.equal(petInitialResult.episodes.length, 1);
  assert.equal(petInitialResult.summary.totalEpisodes, 1);
  assert.equal(petInitialResult.summary.isFinale, true);
  assert.equal(petInitialResult.summary.performanceMode, "silent_narration");
  assert.ok(petInitialResult.summary.protagonist.includes("团团"));
  assert.equal(petInitialResult.summary.animationStyle, "商业级 3D 卡通动画");
  assert.equal(petInitialResult.summary.videoSize, "9:16");
  assert.ok(
    petInitialResult.episodes.every((episode) => episode.content.includes("【后期旁白】")),
  );
  assert.ok(
    petInitialResult.characters.every((character) =>
      character.voiceDirection.includes("口型")
      && character.voiceDirection.includes("旁白"),
    ),
  );

  const rewriteRequest = parseGeneralScriptRequest(
    rawRequest(PET_SILENT_NARRATION_PROFILE_ID, "rewrite", petInitialResult),
  );
  const rewriteResult = fixtureFor(rewriteRequest);
  assert.deepEqual(
    rewriteResult.episodes.map((episode) => episode.episodeNumber),
    petInitialResult.episodes.map((episode) => episode.episodeNumber),
  );
  assert.match(rewriteResult.episodes[0]?.title || "", /重写/);

  const prompt = buildGeneralScriptUserPrompt(petInitialRequest);
  assert.ok(prompt.includes("商业级 3D 卡通动画"));
  assert.ok(prompt.includes("9:16"));
  assert.ok(prompt.includes("团团的等待"));

  const parsedFromLlmShape = parseGeneralScriptLlmPayload({
    choices: [
      {
        message: {
          content: JSON.stringify(petInitialResult),
        },
      },
    ],
  });
  assert.equal(parsedFromLlmShape.profileId, PET_SILENT_NARRATION_PROFILE_ID);

  const finaleRaw = rawRequest(PET_SILENT_NARRATION_PROFILE_ID, "generate");
  const finaleSettings = finaleRaw.settings as Record<string, unknown>;
  finaleSettings.totalEpisodes = null;
  finaleSettings.isFinale = true;
  const finaleRequest = parseGeneralScriptRequest(finaleRaw);
  const finaleResult = fixtureFor(finaleRequest);
  assert.notEqual(finaleResult.episodes[0]?.endingHook, "核心冲突完成闭环。");
  assert.match(finaleResult.episodes[finaleResult.episodes.length - 1]?.endingHook || "", /闭环/);

  await verifyFixtureRoute(rawRequest(GENERAL_SCRIPT_PROFILE_ID, "generate"));
  await verifyStudioImportFixture(petInitialResult);
  await verifyStaticContracts();

  console.log("verify-general-script: PASS");
  console.log("checked: generate, continue, rewrite, single-video pet defaults, preserved meaningful draft, prompt profiles, auth forwarding, studio import fixture");
  console.log("network calls: 0");
}

main().catch((error: unknown) => {
  console.error("verify-general-script: FAIL");
  console.error(error);
  process.exitCode = 1;
});
