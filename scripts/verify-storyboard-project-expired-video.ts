import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

type VideoTaskFixture = {
  id: string;
  task_id_external: string;
  model_id: string;
  status: string;
  completed_at: string;
  source_expired_at: string | null;
  history_hidden_at: string | null;
};

const routeSource = readFileSync("src/app/api/storyboard/projects/route.ts", "utf8");
assert.match(routeSource, /source_expired_at,history_hidden_at/u, "任务查询必须读取媒体可用性字段");

const compiled = ts.transpileModule(routeSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const nativeRequire = createRequire(`${process.cwd()}/scripts/verify-storyboard-project-expired-video.ts`);

function projectRow() {
  return {
    id: "storyboard-project-fixture",
    title: "零成本分镜项目",
    revision: 3,
    created_at: "2026-10-09T00:00:00.000Z",
    updated_at: "2026-10-09T01:00:00.000Z",
    card_count: 1,
    deleted: false,
    document: {
      id: "storyboard-project-fixture",
      title: "零成本分镜项目",
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_100_000,
      lastSubmittedAt: 1_760_000_100_000,
      ratio: "16:9",
      imageResolution: "2K",
      videoResolution: "1080p",
      videoDuration: 10,
      imageModelId: "fixture-image",
      videoModelId: "fixture-video",
      cards: [{
        id: "card-fixture",
        order: 1,
        imagePrompt: "fixture image",
        videoPrompt: "fixture video",
        referenceImageUrls: [],
        imageStatus: "done",
        imageUrl: "https://assets.example/storyboard.png",
        videoStatus: "done",
        videoTaskId: "provider-task-fixture",
        videoUrl: "https://old.example/video.mp4",
        videoContentUrl: "https://old.example/content.mp4",
        videoThumbnailUrl: "https://old.example/thumbnail.jpg",
      }],
    },
  };
}

function createDatabase(task: VideoTaskFixture) {
  let writes = 0;
  const row = projectRow();
  const database = {
    from(table: string) {
      const query = {
        select() { return query; },
        eq() { return query; },
        in() { return query; },
        order() { return query; },
        range() { return Promise.resolve({ data: table === "storyboard_projects" ? [row] : [], error: null }); },
        maybeSingle() {
          if (table === "storyboard_projects") return Promise.resolve({ data: row, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        update() { writes += 1; throw new Error("ZERO_COST_VERIFIER_MUST_NOT_WRITE"); },
        insert() { writes += 1; throw new Error("ZERO_COST_VERIFIER_MUST_NOT_WRITE"); },
        delete() { writes += 1; throw new Error("ZERO_COST_VERIFIER_MUST_NOT_WRITE"); },
        then<TResult1 = unknown, TResult2 = never>(
          onFulfilled?: ((value: { data: VideoTaskFixture[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          const value = { data: table === "video_tasks" ? [task] : [], error: null };
          return Promise.resolve(value).then(onFulfilled, onRejected);
        },
      };
      return query;
    },
    rpc() { writes += 1; throw new Error("ZERO_COST_VERIFIER_MUST_NOT_WRITE"); },
  };
  return { database, writes: () => writes };
}

function loadRoute(task: VideoTaskFixture) {
  const { database, writes } = createDatabase(task);
  const ticketScopes: string[] = [];
  const routeModule = { exports: {} as Record<string, unknown> };
  const requireModule = (name: string) => {
    if (name === "node:crypto" || name === "zod") return nativeRequire(name);
    if (name === "@/lib/api-middleware") return {
      withAuth: (_request: Request, callback: (user: { id: string }, db: unknown) => unknown) => callback({ id: "owner-fixture" }, database),
    };
    if (name === "@/lib/storyboard-project-contract") return {
      StoryboardProjectDocument: { parse: (value: unknown) => value },
      StoryboardProjectId: { parse: (value: unknown) => value },
      deriveStoryboardSubmittedAt: () => "2026-10-09T01:00:00.000Z",
      sortStoryboardProjectsBySubmission: (projects: unknown[]) => projects,
    };
    if (name === "@/lib/storyboard-project-video-state") return {
      collectStoryboardVideoTaskIds: (documents: Array<{ cards?: Array<{ videoTaskId?: string }> }>) => [...new Set(documents.flatMap((document) => (document?.cards || []).map((card) => card.videoTaskId).filter(Boolean)))],
      findStoryboardVideoTask: (card: { videoTaskId?: string }, tasks: VideoTaskFixture[]) => tasks.find((item) => item.id === card.videoTaskId || item.task_id_external === card.videoTaskId),
      normalizeStoryboardVideoTaskStatus: (status: unknown) => String(status) === "completed" ? "done" : null,
      reconcileStoryboardProjectVideoTasks: <T>(document: T) => structuredClone(document),
      shouldRetainStoryboardProject: () => true,
    };
    if (name === "@/storage/object") return { storageManager: { getSignedUrl: async () => "https://signed.example/image" } };
    if (name === "@/lib/video-access-ticket") return {
      createVideoAccessUrl: async (input: { scope: string }) => {
        ticketScopes.push(input.scope);
        return `/api/video/${input.scope}?media_ticket=fixture`;
      },
    };
    if (name === "@supabase/supabase-js") return {};
    throw new Error(`Unexpected route dependency: ${name}`);
  };
  new Function("require", "module", "exports", compiled)(requireModule, routeModule, routeModule.exports);
  return {
    GET: routeModule.exports.GET as (request: Request) => Promise<Response>,
    ticketScopes,
    writes,
  };
}

const baseTask: VideoTaskFixture = {
  id: "local-task-fixture",
  task_id_external: "provider-task-fixture",
  model_id: "model-fixture",
  status: "completed",
  completed_at: "2026-10-09T01:00:00.000Z",
  source_expired_at: null,
  history_hidden_at: null,
};

async function readDetail(task: VideoTaskFixture) {
  const route = loadRoute(task);
  const response = await route.GET(new Request("http://127.0.0.1/api/storyboard/projects?id=storyboard-project-fixture"));
  assert.equal(response.status, 200);
  const payload = await response.json() as { project: { document: { cards: Array<Record<string, unknown>> } } };
  return { route, card: payload.project.document.cards[0] };
}

async function main() {
  for (const fixture of [
    { field: "source_expired_at", value: "2026-10-09T02:00:00.000Z", message: /视频源已过期/u },
    { field: "history_hidden_at", value: "2026-10-09T02:00:00.000Z", message: /已从历史中移除/u },
  ] as const) {
    const task = { ...baseTask, [fixture.field]: fixture.value };
    const { route, card } = await readDetail(task);
    assert.equal(route.ticketScopes.length, 0, `${fixture.field} 不得签发任何媒体票据`);
    assert.equal(route.writes(), 0);
    assert.equal(card.videoTaskId, baseTask.id, "详细工程保留本站任务号用于追溯");
    assert.equal(card.videoStatus, "failed");
    assert.equal(card.videoRetryable, false, "不可播放结果不得被现有 UI 当作可重试任务");
    assert.match(String(card.videoError), fixture.message);
    assert.match(String(card.videoError), /不会自动重新提交/u);
    assert.equal(card.videoUrl, undefined);
    assert.equal(card.videoContentUrl, undefined);
    assert.equal(card.videoThumbnailUrl, undefined);

    const listRoute = loadRoute(task);
    const listResponse = await listRoute.GET(new Request("http://127.0.0.1/api/storyboard/projects?offset=0"));
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json() as { projects: Array<{ cards: Array<Record<string, unknown>> }> };
    const summary = listPayload.projects[0].cards[0];
    assert.equal(summary.videoTaskId, "", "最近任务不得为不可播放结果暴露可换票的任务号");
    assert.equal(summary.videoUrl, "");
    assert.equal(summary.videoThumbnailUrl, "");
    assert.equal(summary.videoStatus, "failed");
    assert.match(String(summary.videoError), fixture.message);
    assert.equal(listRoute.ticketScopes.length, 0);
    assert.equal(listRoute.writes(), 0);
  }

  const fresh = await readDetail(baseTask);
  assert.deepEqual(fresh.route.ticketScopes.sort(), ["playback", "thumbnail"], "未过期完成任务必须保留原有播放与缩略图票据");
  assert.equal(fresh.card.videoTaskId, baseTask.id);
  assert.equal(fresh.card.videoStatus, "done");
  assert.match(String(fresh.card.videoUrl), /media_ticket=fixture/u);
  assert.match(String(fresh.card.videoThumbnailUrl), /media_ticket=fixture/u);
  assert.equal(fresh.route.writes(), 0);

  console.log(JSON.stringify({
    result: "PASS",
    expiredTicketCalls: 0,
    hiddenTicketCalls: 0,
    databaseWrites: 0,
    providerCalls: 0,
    completedBehaviorPreserved: true,
  }, null, 2));
}

void main();
