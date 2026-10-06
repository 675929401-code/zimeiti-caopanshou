import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ShortDramaProject } from "../src/lib/short-drama/contracts";
import {
  ProductionActionRequestSchema,
  ProductionExportRequestSchema,
} from "../src/lib/short-drama/production-contracts";
import {
  deriveProductionPlan,
  ProductionPlanError,
} from "../src/lib/short-drama/production-plan";

const projectRoot = process.cwd();

function fixtureProject(sourcePayload: ShortDramaProject["sourcePayload"]): ShortDramaProject {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "生产合同验证",
    description: "",
    projectType: "narrated_animation",
    status: "draft",
    sourcePayload,
    settings: {
      aspectRatio: "9:16",
      outputLanguage: "zh-CN",
      animationStyle: "商业级三维动画",
      noCharacterSpeech: true,
      defaultShotDurationSeconds: 5,
    },
    revision: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function verifyActionContracts(): void {
  assert.equal(ProductionActionRequestSchema.parse({
    action: "create_plan",
    clientRequestId: "verify:plan:0001",
  }).action, "create_plan");
  assert.equal(ProductionActionRequestSchema.safeParse({
    action: "generate_image",
    shotId: "not-a-uuid",
    clientRequestId: "verify:image:0001",
    modelId: "pm_example",
  }).success, false);
  const finalAction = ProductionActionRequestSchema.parse({
    action: "assemble_final",
    clientRequestId: "verify:final:0001",
  });
  assert.equal(finalAction.action, "assemble_final");
  if (finalAction.action === "assemble_final") assert.equal(finalAction.burnSubtitles, true);
  assert.equal(ProductionActionRequestSchema.safeParse({
    action: "generate_video",
    shotId: "00000000-0000-4000-8000-000000000002",
    clientRequestId: "verify:video:0001",
    modelId: "pm_example",
    duration: 0,
  }).success, false);
  assert.equal(ProductionExportRequestSchema.safeParse({
    jobId: "sdj_12345678",
    targetDurationSeconds: 61,
  }).success, false);
}

function verifyDeterministicPlan(): void {
  const project = fixtureProject({
    segments: [{
      segment_id: "episode-001-segment-01",
      narration: "小狗沿着雨后的街角寻找熟悉的气味。",
      semantic_job: "豆豆辨认回家的方向",
      image_prompt: "雨后街角，小狗豆豆佩戴红色项圈，暖色路灯，竖屏构图",
      video_prompt: "镜头缓慢前推，豆豆低头嗅闻后抬头望向亮灯的家门",
      target_duration_seconds: 8,
      story_beat: "hook",
      panel_count: 4,
    }],
  });
  const plan = deriveProductionPlan(project);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].segmentId, "episode-001-segment-01");
  assert.equal(plan[0].aspectRatio, "9:16");
  assert.equal(plan[0].durationSeconds, 8);
  assert.match(plan[0].imagePrompt, /红色项圈/);

  const editableEpisodeProject = fixtureProject({
    episodes: [{
      episodeNumber: 1,
      title: "雨夜归家",
      logline: "豆豆循着气味寻找家门",
      content: "雨停以后，豆豆沿着街角辨认熟悉的气味，最终看见亮着灯的家门。",
      endingHook: "门后传来熟悉的脚步声。",
      status: "confirmed",
      confirmedAt: "2026-09-15T00:00:00.000Z",
    }],
  });
  const editableEpisodePlan = deriveProductionPlan(editableEpisodeProject);
  assert.equal(editableEpisodePlan.length, 1);
  assert.match(editableEpisodePlan[0].narration, /豆豆沿着街角/);
  assert.match(editableEpisodePlan[0].imagePrompt, /完整4格动画故事板/);
  assert.match(editableEpisodePlan[0].videoPrompt, /实际镜头按动作因果组织/);

  const portraitProject = {
    ...editableEpisodeProject,
    settings: { ...editableEpisodeProject.settings, aspectRatio: "3:4" },
  } as ShortDramaProject;
  const portraitPlan = deriveProductionPlan(portraitProject);
  assert.equal(portraitPlan[0].aspectRatio, "3:4");
  assert.match(portraitPlan[0].imagePrompt, /画幅3:4/);
  assert.match(portraitPlan[0].videoPrompt, /画幅3:4/);

  assert.throws(
    () => deriveProductionPlan(fixtureProject({})),
    (error) => error instanceof ProductionPlanError
      && error.code === "PRODUCTION_PLAN_SOURCE_MISSING",
  );
}

function verifyFailClosedWiring(): void {
  const service = readFileSync(
    resolve(projectRoot, "src/lib/short-drama/production-service.ts"),
    "utf8",
  );
  const repository = readFileSync(
    resolve(projectRoot, "src/lib/short-drama/production-repository.ts"),
    "utf8",
  );
  const videoGenerate = readFileSync(
    resolve(projectRoot, "src/app/api/video/generate/route.ts"),
    "utf8",
  );

  assert.match(service, /POST as generateImageRoute/);
  assert.match(service, /POST as persistImageRoute/);
  assert.match(service, /POST as generateVideoRoute/);
  assert.match(service, /GET as pollVideoRoute/);
  assert.doesNotMatch(service, /api\/video\/(?:status|stream)\/route/);
  assert.match(service, /VIDEO_REFERENCE_REQUIRED/);
  assert.match(service, /isPersistentVideoUri/);
  assert.match(service, /short-drama-film-studio/);
  assert.match(service, /assertProductionMigrationReady/);
  assert.match(repository, /MIGRATION_NOT_READY/);
  assert.match(repository, /partially deployed migration/);
  assert.match(repository, /short_drama_jobs/);
  assert.match(repository, /short_drama_assets/);
  assert.match(repository, /short_drama_settlements/);
  assert.doesNotMatch(videoGenerate, /CHANNEL_HEALTH_UNAVAILABLE/);
  assert.doesNotMatch(videoGenerate, /CHANNEL_HEALTH_UNVERIFIED/);
  assert.match(videoGenerate, /evaluateVideoChannelCircuit/);
  assert.match(videoGenerate, /validateVideoInputContract/);
  assert.match(videoGenerate, /reference_image_urls/);
}

function verifyWorkbenchWiring(): void {
  const workbench = readFileSync(
    resolve(projectRoot, "src/features/film-studio-project/film-studio-project-workbench.tsx"),
    "utf8",
  );
  const panel = readFileSync(
    resolve(projectRoot, "src/features/film-studio-project/film-studio-production-panel.tsx"),
    "utf8",
  );
  const repository = readFileSync(
    resolve(projectRoot, "src/lib/short-drama/production-repository.ts"),
    "utf8",
  );
  const videoCapabilities = readFileSync(
    resolve(projectRoot, "src/lib/short-drama/film-video-capabilities.ts"),
    "utf8",
  );

  assert.match(workbench, /FilmStudioProductionPanel/);
  assert.doesNotMatch(workbench, /UnconnectedStage/);
  assert.doesNotMatch(workbench, /分镜生产 API 尚未接通|成片与导出 API 尚未接通/);
  assert.match(panel, /action:\s*"create_plan"/);
  assert.match(panel, /action:\s*"generate_image"/);
  assert.match(panel, /buildFilmVideoSubmission/);
  assert.match(videoCapabilities, /action:\s*"generate_video"/);
  assert.match(panel, /action:\s*"assemble_final"/);
  assert.match(panel, /action:\s*"poll_job"/);
  assert.match(panel, /submittedAtDifference\s*\|\|\s*right\.id\.localeCompare\(left\.id\)/);
  assert.match(repository, /from\("short_drama_jobs"\)[\s\S]*?order\("created_at", \{ ascending: false \}\)[\s\S]*?order\("id", \{ ascending: false \}\)/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /MIGRATION_NOT_READY/);
  assert.ok(panel.includes('fetch(`${endpoint}/export`,'));
  assert.match(panel, /stableUri/);
  assert.match(panel, /统一成片已完成并写入稳定存储/);
  assert.match(panel, /film-studio-final-master/);
  assert.doesNotMatch(panel, /全片拼接、转场、字幕、音轨混合与统一成片任务尚未接入/);
}

function main(): void {
  verifyActionContracts();
  verifyDeterministicPlan();
  verifyFailClosedWiring();
  verifyWorkbenchWiring();
  console.log("short-drama production verification passed (offline only, no network, no database writes, no paid model calls)");
}

main();
