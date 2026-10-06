import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/short-drama/projects/import-script/route";
import {
  GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
  type GeneralScriptResult,
} from "../src/lib/short-drama/general-script-contract";
import {
  mapGeneralScriptResultToProject,
  parseGeneralScriptProjectImport,
  parseStrictGeneralScriptResult,
} from "../src/lib/short-drama/general-script-import";

function makeResult(): GeneralScriptResult {
  return {
    schemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
    profileId: "pet-silent-narration",
    operation: "generate",
    summary: {
      title: "小狗寻找回家路",
      protagonist: "小狗豆豆",
      oneSentence: "一只小狗凭借熟悉的气味寻找回家的方向。",
      synopsis: "豆豆在雨后与主人走散，沿着街角熟悉的气味一步步回家。",
      genre: "温情宠物动画",
      creationMode: "original",
      targetAudience: "all_ages",
      tone: "warm",
      background: "现代城市社区",
      setting: "雨后傍晚的街道与小区",
      animationStyle: "商业级三维动画",
      videoSize: "9:16",
      performanceMode: "silent_narration",
      totalEpisodes: 1,
      isFinale: true,
    },
    episodes: [{
      episodeNumber: 1,
      title: "熟悉的气味",
      logline: "豆豆在雨后的街道辨认回家的方向。",
      content: "旁白讲述豆豆依靠气味穿过街角，最终看见亮着灯的家门。",
      endingHook: "家门打开，主人冲进雨里。",
      estimatedDurationSeconds: 60,
      characterNames: ["豆豆"],
      sceneNames: ["雨后街角", "小区门口"],
      propNames: ["红色项圈"],
    }],
    characters: [{
      id: "character-doudou",
      name: "豆豆",
      role: "主角",
      profile: "与主人走散、努力寻找回家的小狗",
      personality: "勇敢、敏锐、依恋主人",
      appearance: "浅棕色短毛，佩戴红色项圈",
      voiceDirection: "角色不开口，由温暖旁白推进故事",
    }],
    scenes: [{
      id: "scene-rain-corner",
      name: "雨后街角",
      description: "湿润路面反射暖色路灯，远处车辆缓慢经过",
      time: "傍晚",
      atmosphere: "迷茫但仍有希望",
      episodeNumbers: [1],
    }],
    props: [{
      id: "prop-red-collar",
      name: "红色项圈",
      category: "角色道具",
      description: "用于保持豆豆跨镜头视觉一致性的红色项圈",
      episodeNumbers: [1],
    }],
  };
}

function requestBody(result: GeneralScriptResult) {
  return {
    clientRequestId: "verify:import:0001",
    title: "豆豆回家",
    result,
  };
}

function makeRequest(result: GeneralScriptResult): NextRequest {
  return new NextRequest("http://127.0.0.1/api/short-drama/projects/import-script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(result)),
  });
}

function verifyStrictMapping(): void {
  const result = makeResult();
  const before = JSON.stringify(result);
  const input = parseGeneralScriptProjectImport(requestBody(result));
  const mapping = mapGeneralScriptResultToProject(input);

  assert.equal(JSON.stringify(result), before, "映射不得修改通用短剧结果");
  assert.deepEqual(mapping.createRequest.sourcePayload.summary, result.summary);
  assert.deepEqual(mapping.createRequest.sourcePayload.episodes, result.episodes);
  assert.deepEqual(mapping.createRequest.sourcePayload.characters, result.characters);
  assert.deepEqual(mapping.createRequest.sourcePayload.scenes, result.scenes);
  assert.deepEqual(mapping.createRequest.sourcePayload.props, result.props);
  assert.equal(mapping.createRequest.sourcePayload.episodeCount, 1);
  assert.equal(mapping.createRequest.projectType, "pet_story");
  assert.equal(mapping.createRequest.settings.noCharacterSpeech, true);

  assert.throws(
    () => parseStrictGeneralScriptResult({ ...result, unexpected: true }),
    /包含未知字段: unexpected/,
  );
  assert.throws(
    () => parseStrictGeneralScriptResult({
      ...result,
      summary: { ...result.summary, unexpected: true },
    }),
    /result\.summary.*包含未知字段: unexpected/,
  );
  assert.throws(
    () => parseStrictGeneralScriptResult({ ...result, schemaVersion: "wrong-version" }),
    /schemaVersion 必须为 general-script-result\.v1/,
  );
  assert.throws(
    () => parseGeneralScriptProjectImport({ ...requestBody(result), extra: true }),
  );
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function setTestEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else Reflect.set(process.env, name, value);
}

async function verifyOfflineEndpoint(): Promise<void> {
  const originalFixtureMode = process.env.SHORT_DRAMA_FIXTURE_MODE;
  const originalNodeEnv = process.env.NODE_ENV;
  const result = makeResult();

  try {
    setTestEnvironment("SHORT_DRAMA_FIXTURE_MODE", "1");
    setTestEnvironment("NODE_ENV", "test");
    const firstResponse = await POST(makeRequest(result));
    const firstPayload = await responseJson(firstResponse);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstPayload.ok, true);
    assert.equal(firstPayload.executionMode, "fixture");
    assert.match(String((firstPayload.project as Record<string, unknown>).id), /^fixture-[0-9a-f]{20}$/);
    assert.match(
      String(firstPayload.href),
      /^\/tools\/film-studio\/projects\/fixture-[0-9a-f]{20}\?step=script$/,
    );

    const secondResponse = await POST(makeRequest(result));
    const secondPayload = await responseJson(secondResponse);
    assert.equal(
      (firstPayload.project as Record<string, unknown>).id,
      (secondPayload.project as Record<string, unknown>).id,
      "fixture 项目 ID 必须可重复",
    );

    setTestEnvironment("NODE_ENV", "production");
    const productionResponse = await POST(makeRequest(result));
    const productionPayload = await responseJson(productionResponse);
    assert.equal(productionResponse.status, 401);
    assert.equal(productionPayload.ok, false);
    assert.notEqual(productionPayload.executionMode, "fixture");

    setTestEnvironment("SHORT_DRAMA_FIXTURE_MODE", undefined);
    setTestEnvironment("NODE_ENV", "test");
    const defaultResponse = await POST(makeRequest(result));
    const defaultPayload = await responseJson(defaultResponse);
    assert.equal(defaultResponse.status, 401);
    assert.equal(defaultPayload.ok, false);
    assert.notEqual(defaultPayload.executionMode, "fixture");
  } finally {
    setTestEnvironment("SHORT_DRAMA_FIXTURE_MODE", originalFixtureMode);
    setTestEnvironment("NODE_ENV", originalNodeEnv);
  }
}

async function main(): Promise<void> {
  verifyStrictMapping();
  await verifyOfflineEndpoint();
  console.log("short-drama import verification passed (offline fixture only, no auth bypass by default or production)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "short-drama import verification failed");
  process.exitCode = 1;
});
