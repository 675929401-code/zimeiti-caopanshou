import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/app/api/video/history/route.ts", import.meta.url), "utf8");
const videoPage = readFileSync(new URL("../src/app/video/page.tsx", import.meta.url), "utf8");
const accountHistory = readFileSync(new URL("../src/components/account-video-history.tsx", import.meta.url), "utf8");
const storyboard = readFileSync(new URL("../src/components/storyboard-workbench.tsx", import.meta.url), "utf8");
const storyboardProjects = readFileSync(new URL("../src/app/api/storyboard/projects/route.ts", import.meta.url), "utf8");
const storyboardProjectContract = readFileSync(new URL("../src/lib/storyboard-project-contract.ts", import.meta.url), "utf8");

assert.match(source, /const internalPublicModelId = t\.model_id \? toPublicModelId\("video", String\(t\.model_id\)\) : "";/u);
assert.match(source, /modelId: requestSnapshot\?\.publicModelId \|\| internalPublicModelId,\s*publicModelId: requestSnapshot\?\.publicModelId \|\| internalPublicModelId,/u, "历史主模型字段和别名必须都是公开编号");
assert.doesNotMatch(source, /modelId:\s*String\(t\.model_id/u, "视频历史不得直接返回数据库模型编号");
assert.match(source, /\.eq\("user_id", userId\)/u, "视频历史必须按当前用户隔离");
assert.match(source, /surfaceFilter/u, "视频制作与数字人历史必须按工作台隔离");
assert.match(source, /createVideoAccessUrl/u, "完成结果必须返回站内授权播放地址");
assert.match(source, /classifyVideoProviderError\(rawError, publicModelName\)/u, "失败提示必须绑定原任务模型名称");
assert.match(source, /hideMediaHistoryItem/u, "移出历史必须保留原结果和账单证据");
assert.match(source, /task_label\.not\.like\.分镜工作台%/u, "普通视频数据库窗口必须排除分镜工作台任务");
assert.match(source, /!String\(task\.task_label \|\| ""\)\.startsWith\("分镜工作台"\)/u, "普通视频返回结果必须二次排除分镜任务");
assert.match(videoPage, /\/api\/video\/history\?surface=video-page&limit=100/u, "普通视频页面必须显式声明历史来源");
assert.match(videoPage, /surface: 'video-page', taskId: id/u, "普通视频重试读取必须限定普通视频来源");
assert.match(accountHistory, /onRetry\?: \(task: VideoTask\) => void/u, "账号历史必须支持由来源工作台接管安全重试");
assert.match(accountHistory, /onRetry=\{onRetry\}/u, "账号历史必须把重试处理器传给画廊");
assert.match(storyboard, /surface=storyboard-workbench&limit=100&offset=\$\{cursor\}/u, "分镜恢复必须保留来源隔离和100条分页游标");
assert.match(storyboard, /<TicketedVideo\s+url=\{card\.videoUrl\}\s+taskId=\{card\.videoTaskId\}\s+token=\{token\}/u, "分镜项目视频必须在播放组件内按稳定任务编号换取新票据");
assert.doesNotMatch(storyboard, /setPreviewMedia\(\{ url: card\.videoUrl, type: "video"/u, "分镜项目视频不得继续直接打开列表加载时的旧票据");
assert.match(storyboard, /card\.videoStatus === "failed"/u, "分镜失败历史只展示失败状态，不得从历史自动提交");
assert.match(storyboardProjects, /card\.videoTaskId = taskId/u, "项目响应必须把供应商任务编号规范成本站自有任务编号");
assert.match(storyboardProjects, /videoTaskId: String\(card\.videoTaskId \|\| ""\)/u, "项目摘要必须向前端返回稳定视频任务编号");
assert.match(storyboardProjectContract, /videoTaskId: string;/u, "项目卡摘要合同必须包含稳定视频任务编号");

async function verifyStoryboardHistoryPagination() {
  const ast = ts.createSourceFile("storyboard-workbench.tsx", storyboard, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "loadVideoHistory"
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback && ts.isArrowFunction(callback), "分页测试必须执行真实工作台回调");
  const executable = ts.transpileModule(`globalThis.loadVideoHistory = ${callback.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  type Task = { id: string; marker?: string };
  type Page = { tasks: Task[]; nextOffset: number | null };
  function harness(pages: Map<number, Page>, initial: Task[], windowSize: number) {
    const requestedOffsets: number[] = [];
    const state = { tasks: initial, nextOffset: null as number | null, error: "", loading: false };
    const runRef = { current: { id: "fixture-run", cards: [] } };
    const context = {
      storageReady: true, token: "fixture-token", AbortController,
      videoHistoryAbortRef: { current: null }, videoHistorySequenceRef: { current: 0 },
      videoHistoryIdentityRef: { current: "fixture-owner" }, videoHistoryWindowRef: { current: windowSize },
      setVideoHistoryLoading: (value: boolean) => { state.loading = value; },
      setVideoHistoryError: (value: string) => { state.error = value; },
      setVideoHistoryTasks: (update: (current: Task[]) => Task[]) => { state.tasks = update(state.tasks); },
      setVideoHistoryNextOffset: (value: number | null) => { state.nextOffset = value; },
      runRef, setHistory: (update: (current: unknown[]) => unknown[]) => update([]),
      setRun: (update: (current: typeof runRef.current) => typeof runRef.current) => { runRef.current = update(runRef.current); },
      hydrateRunVideoTasks: (run: unknown) => run,
      rememberVideoConfirmation: () => { throw new Error("Empty fixture has no card confirmation"); },
      fetch: async (value: string, options: { method?: string }) => {
        const url = new URL(value, "https://fixture.invalid");
        assert.equal(url.pathname, "/api/video/history");
        assert.equal(url.searchParams.get("surface"), "storyboard-workbench");
        assert.equal(url.searchParams.get("limit"), "100");
        assert.ok(!options.method || options.method === "GET", "历史刷新不能提交写请求");
        const offset = Number(url.searchParams.get("offset"));
        requestedOffsets.push(offset);
        const page = pages.get(offset);
        assert.ok(page, `Unexpected fixture offset ${offset}`);
        return { ok: true, json: async () => page };
      },
      loadVideoHistory: undefined as unknown as (offset?: number) => Promise<void>,
    };
    runInNewContext(executable, context);
    return { load: context.loadVideoHistory, state, requestedOffsets };
  }
  const ids = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `task-${start + index}` }));
  const refresh = harness(new Map([
    [0, { tasks: ids(0, 100), nextOffset: 100 }],
    [100, { tasks: ids(99, 100), nextOffset: 200 }],
    [200, { tasks: ids(199, 51), nextOffset: null }],
  ]), [{ id: "stale-task" }], 250);
  await refresh.load();
  assert.equal(refresh.state.error, "");
  assert.equal(refresh.state.loading, false);
  assert.deepEqual(refresh.requestedOffsets, [0, 100, 200]);
  assert.deepEqual(Array.from(refresh.state.tasks, task => task.id), ids(0, 250).map(task => task.id),
    "刷新必须合并全部分页、去除重叠ID并替换旧窗口");
  assert.equal(refresh.state.nextOffset, null);
  const more = harness(new Map([[100, { tasks: [{ id: "retained", marker: "updated" }, { id: "new-task" }], nextOffset: 200 }]]),
    [{ id: "retained", marker: "old" }, { id: "other-existing" }], 100);
  await more.load(100);
  assert.equal(more.state.error, "");
  assert.deepEqual(more.requestedOffsets, [100], "显式加载更多只读取指定页");
  assert.deepEqual(JSON.parse(JSON.stringify(more.state.tasks)),
    [{ id: "other-existing" }, { id: "retained", marker: "updated" }, { id: "new-task" }],
    "加载更多必须保留已有任务、刷新重叠记录且不重复追加");
  assert.equal(more.state.nextOffset, 200);
  console.log("video history public model/surface/fresh-ticket and RAM pagination contracts passed; 2 pagination scenarios; zero network/db/wallet/provider calls");
}

void verifyStoryboardHistoryPagination().catch(error => { console.error(error); process.exitCode = 1; });
