import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import { videoProgressStatus, videoProgressLabel, videoSubmissionConfirmationSignal, updateVideoConfirmationMap } from '../src/lib/video-task-progress';
import { boundVideoTaskModel } from '../src/lib/video-model-selection-state';

for (const stage of ['confirming_submission', 'submission_unknown']) {
  assert.equal(videoProgressStatus({ status: 'pending', processingStage: stage }), 'pending');
  assert.equal(videoProgressLabel({ processingStage: stage }), '正在确认结果');
}
for (const stage of ['waiting_power', 'waiting_ready', 'retry_wait']) {
  assert.equal(videoProgressStatus({ status: 'queued', processingStage: stage }), 'queued');
}
for (const stage of ['dispatching', 'recovery_required', 'running']) {
  assert.equal(videoProgressStatus({ processingStage: stage }), 'processing');
}
for (const stage of ['result_staging', 'persisting', 'finalizing', 'billing']) {
  assert.equal(videoProgressStatus({ status: 'processing', processingStage: stage }), 'finalizing');
}
assert.equal(videoProgressStatus({ status: 'queued', processingStage: 'provider_wait' }), 'queued');
assert.equal(videoProgressStatus({ status: 'processing' }), 'processing');
assert.equal(videoProgressLabel({ status: 'processing' }), '生成中');
assert.equal(videoProgressStatus({ status: 'queued', submission_outcome: 'unknown' }), 'queued', 'display evidence must not change the original SSE status mapping');

const boardSource = readFileSync('src/components/storyboard-workbench.tsx', 'utf8');
const videoSource = readFileSync('src/app/video/page.tsx', 'utf8');
const boardTree = ts.createSourceFile('storyboard-workbench.tsx', boardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const videoTree = ts.createSourceFile('video-page.tsx', videoSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(tree: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  return matches;
}
function declaration(tree: ts.SourceFile, name: string): ts.VariableDeclaration {
  const matches = nodes(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name);
  assert.equal(matches.length, 1, `unique actual declaration: ${name}`);
  return matches[0] as ts.VariableDeclaration;
}
function functionText(name: string): string {
  const found = nodes(boardTree, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1);
  return found[0].getText(boardTree);
}
function evaluate<T>(expression: string, bindings: Record<string, unknown> = {}): T {
  const sandbox = { exports: {} as { subject?: T }, require: (name: string) => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`UNMOCKED_PROGRESS_DEPENDENCY:${name}`);
  }, ...bindings };
  runInNewContext(ts.transpileModule(`exports.subject = (${expression});`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, sandbox);
  return sandbox.exports.subject as T;
}
function jsx(tree: ts.SourceFile, className: string, guard = false): string {
  const matches = nodes(tree, node => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute => (
    ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === 'className'
    && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === className
  ))).filter(node => {
    if (!guard) return true;
    let branch = node;
    while (ts.isParenthesizedExpression(branch.parent)) branch = branch.parent;
    return ts.isConditionalExpression(branch.parent) && branch.parent.whenTrue === branch
      && /^isActiveVideo/u.test(branch.parent.condition.getText(tree));
  });
  assert.equal(matches.length, 1, `unique actual JSX: ${className}`);
  const node = matches[0];
  if (!guard) return node.getText(tree);
  let branch = node;
  while (ts.isParenthesizedExpression(branch.parent)) branch = branch.parent;
  assert(ts.isConditionalExpression(branch.parent) && branch.parent.whenTrue === branch);
  return `(${branch.parent.condition.getText(tree)}) ? (${node.getText(tree)}) : null`;
}

const key = evaluate<(user: string, run: string, card: { id: string; videoClientRequestId?: string }, task: string) => string>(functionText('storyboardVideoConfirmationKey'));
const card = {
  id: 'card-a', order: 1, imageStatus: 'done', videoStatus: 'queued', videoTaskId: 'business-task-a',
  videoClientRequestId: 'request-a' as string | undefined, videoTaskModelId: 'model-a', videoPriceCharged: 0, videoBillingState: 'reserved',
  videoProgress: 42, videoStartedAt: 100, videoLastCheckedAt: 100,
  videoStatusDetail: 'INTERNAL_DIAGNOSTIC /v1/videos upstream pending',
};
const runRef = { current: { id: 'run-a', cards: [card] } };
const mounted = { current: true };
const owner = { current: 'user-a\0fixture-token' };
let markers = new Map<string, boolean>();
const markerDeclaration = declaration(boardTree, 'rememberVideoConfirmation');
assert(markerDeclaration.initializer && ts.isCallExpression(markerDeclaration.initializer));
const markerArrow = markerDeclaration.initializer.arguments[0];
const remember = evaluate<(run: string, card: string, task: string, data: object, client: string | undefined) => void>(markerArrow.getText(boardTree), {
  userId: 'user-a', token: 'fixture-token', runRef, scopeMountedRef: mounted, imageDownloadOwnerRef: owner,
  storyboardVideoConfirmationKey: key, updateVideoConfirmationMap,
  setVideoConfirmationTasks: (update: (current: Map<string, boolean>) => Map<string, boolean>) => { markers = update(markers); },
});
const identity = key('user-a', 'run-a', card, card.videoTaskId);
const originalCard = JSON.stringify(card);
remember('run-a', card.id, card.videoTaskId, { status: 'pending', task_submitted: null, business_task_id: card.videoTaskId }, 'request-a');
assert.equal(markers.get(identity), true, 'explicit unknown create receipt must retain neutral confirmation');
assert.equal(JSON.stringify(card), originalCard, 'presentation marker must not mutate serialized task or billing');

const condition = declaration(boardTree, 'confirmingVideoSubmission').initializer!.getText(boardTree);
const isActiveVideoStatus = (status: string) => status === 'queued' || status === 'running';
const reconciliation = evaluate<(value: typeof card) => boolean>(functionText('videoNeedsRequestReconciliation'), { isActiveVideoStatus });
const statusText = evaluate<(value: string) => string>(functionText('statusText'));
const cardStatus = evaluate<(value: typeof card) => { label: string; status: string }>(functionText('cardStatus'), { imageAttemptNeedsResolution: () => false });
const lastChecked = evaluate<(time?: number, now?: number) => string>(functionText('formatLastChecked'));
const icon = () => React.createElement('svg', { 'aria-hidden': true });
const baseBindings = () => ({
  card, userId: 'user-a', run: runRef.current, videoConfirmationTasks: markers,
  isActiveVideoStatus, videoNeedsRequestReconciliation: reconciliation, storyboardVideoConfirmationKey: key,
  statusText, cardStatus, submittedVideoTaskLabel: () => '测试视频 · 15秒', Loader2: icon, Film: icon,
  VIDEO_DELIVERY_STAGES: ['已提交', '上游生成', '接收结果', '完成'], cardVideoStageIndex: () => 0,
  formatElapsed: () => '已等待 10 秒', formatLastChecked: lastChecked, clockNow: 1_000,
});
const boardFrame = jsx(boardTree, 'sbw-loading-state sbw-realtime-state', true);
const boardHeader = jsx(boardTree, 'sbw-status-pair');
function boardMarkup(): string {
  const bindings = baseBindings();
  const confirmingVideoSubmission = evaluate<boolean>(condition, bindings);
  const scope = { ...bindings, confirmingVideoSubmission };
  return renderToStaticMarkup(evaluate<() => React.ReactNode>(`() => (<>${boardHeader}{${boardFrame}}</>)`, scope)());
}
function assertNeutral(html: string) {
  assert.match(html, /正在确认结果/u);
  assert.doesNotMatch(html, /progressbar|aria-valuenow|渲染|收到进度更新|INTERNAL_DIAGNOSTIC|上次查询|已等待|sbw-video-stage-steps|\d+%/u);
}
assertNeutral(boardMarkup());

for (let count = 0; count < 2; count += 1) {
  const before = markers;
  remember('run-a', card.id, card.videoTaskId, { status: 'pending', processingStage: 'confirming_submission', progress: null }, 'request-a');
  assert.equal(markers, before, 'repeat status must not churn the transient map');
  assertNeutral(boardMarkup());
}
const heartbeatLoop = nodes(boardTree, node => ts.isForOfStatement(node) && node.expression.getText(boardTree) === 'events')
  .find(node => node.getText(boardTree).includes('event.event === "heartbeat"'));
assert(heartbeatLoop);
let applied = 0;
let taskPatches = 0;
evaluate<() => void>(`() => { ${heartbeatLoop.getText(boardTree)} }`, {
  events: [{ event: 'heartbeat', data: '{}' }], applyStatus: () => { applied += 1; },
  patchCard: () => { taskPatches += 1; },
})();
assert.equal(applied + taskPatches, 0, 'actual heartbeat handler must not report progress or save task state');
assertNeutral(boardMarkup());

markers = new Map();
remember('run-a', card.id, card.videoTaskId, { status: 'pending', taskIdExternal: '' }, 'request-a');
assertNeutral(boardMarkup());
assert.equal(videoSubmissionConfirmationSignal({ status: 'pending' }), undefined, 'missing fields are not rejection evidence');
assert.equal(videoSubmissionConfirmationSignal({ status: 'queued', taskIdExternal: '' }), undefined, 'empty external alone must not misclassify a dispatch queue');
assert.equal(videoSubmissionConfirmationSignal({ status: 'queued', processingStage: 'waiting_power', taskIdExternal: '' }), false);
remember('run-a', card.id, card.videoTaskId, { status: 'queued', processingStage: 'waiting_power' }, 'request-a');
assert.equal(markers.has(identity), false, 'a local queue is not irreversible provider acceptance');
remember('run-a', card.id, card.videoTaskId, { status: 'pending', processingStage: 'submission_unknown' }, 'request-a');
assertNeutral(boardMarkup());
remember('run-a', card.id, card.videoTaskId, { status: 'queued', taskIdExternal: 'provider-task-a' }, 'request-a');
assert.equal(markers.get(identity), false);
assert.match(boardMarkup(), /排队中/u);
assert.doesNotMatch(boardMarkup(), /正在确认结果/u);
remember('run-a', card.id, card.videoTaskId, { status: 'pending', processingStage: 'confirming_submission' }, 'request-a');
assert.equal(markers.get(identity), false, 'late pending must not regress a provider-confirmed task');

for (const status of ['running', 'done', 'failed', 'cancelled', 'finalizing']) {
  markers = new Map([[identity, true]]);
  remember('run-a', card.id, card.videoTaskId, { status }, 'request-a');
  assert.equal(markers.get(identity), false, `${status} must clear old confirmation`);
  assert.equal(videoSubmissionConfirmationSignal({ status, processingStage: 'confirming_submission' }), false);
  card.videoStatus = status === 'finalizing' ? 'running' : status;
  assert.doesNotMatch(boardMarkup(), /正在确认结果/u, 'running and terminal DOM must not retain confirmation');
  card.videoStatus = 'queued';
}
for (const changed of ['owner', 'run', 'card', 'client', 'task'] as const) {
  markers = new Map();
  const old = { id: card.id, client: card.videoClientRequestId, task: card.videoTaskId };
  if (changed === 'owner') owner.current = 'user-b\0fixture-token';
  if (changed === 'run') runRef.current.id = 'run-b';
  if (changed === 'card') card.id = 'card-b';
  if (changed === 'client') card.videoClientRequestId = 'request-b';
  if (changed === 'task') card.videoTaskId = 'business-task-b';
  remember('run-a', old.id, old.task, { status: 'pending', processingStage: 'confirming_submission' }, old.client);
  assert.equal(markers.size, 0, `late snapshot must not cross ${changed} identity`);
  owner.current = 'user-a\0fixture-token'; runRef.current.id = 'run-a';
  card.id = old.id; card.videoClientRequestId = old.client; card.videoTaskId = old.task;
}
assert.equal(JSON.stringify(card), originalCard, 'display-only transitions must leave IDs/status/money/retry facts untouched');
const historyMarkerLoop = nodes(boardTree, node => ts.isForOfStatement(node) && node.expression.getText(boardTree) === 'runRef.current.cards')
  .find(node => node.getText(boardTree).includes('rememberVideoConfirmation'));
assert(historyMarkerLoop);
markers = new Map();
card.videoTaskId = '';
evaluate<() => void>(`() => { ${historyMarkerLoop.getText(boardTree)} }`, {
  runRef, tasks: [{ id: 'business-task-a', taskIdExternal: 'provider-restored-task', clientRequestId: 'request-a', status: 'queued' }],
  rememberVideoConfirmation: remember,
})();
card.videoTaskId = 'provider-restored-task';
const restoredIdentity = key('user-a', 'run-a', card, card.videoTaskId);
assert.equal(markers.get(restoredIdentity), false, 'legacy history marker must use the same external tracking ID as hydration');
remember('run-a', card.id, card.videoTaskId, { status: 'pending', processingStage: 'confirming_submission' }, 'request-a');
assert.equal(markers.get(restoredIdentity), false, 'late pending cannot regress the restored external task');
card.videoTaskId = 'business-task-a';
markers = new Map();
card.videoClientRequestId = undefined;
evaluate<() => void>(`() => { ${historyMarkerLoop.getText(boardTree)} }`, {
  runRef, tasks: [{ id: 'business-task-a', taskIdExternal: '', clientRequestId: 'request-a', status: 'pending' }],
  rememberVideoConfirmation: remember,
})();
assert.equal(markers.get(key('user-a', 'run-a', card, card.videoTaskId)), true,
  'an exact restored task must recover confirmation when the old card omitted its client request field');
assertNeutral(boardMarkup());
card.videoClientRequestId = 'request-a';
markers = new Map();
evaluate<() => void>(`() => { ${historyMarkerLoop.getText(boardTree)} }`, {
  runRef, tasks: [{ id: 'business-task-a', taskIdExternal: '', clientRequestId: 'request-b', status: 'pending' }],
  rememberVideoConfirmation: remember,
})();
assert.equal(markers.size, 0, 'two explicit conflicting client request identities must not be merged');
assert.match(lastChecked(1_000, 1_001), /上次查询/u);
assert.doesNotMatch(lastChecked(1_000, 1_001), /进度|回报/u);

const videoFrame = jsx(videoTree, 'space-y-2.5', true);
const task = { status: 'pending', processingStage: 'confirming_submission', progress: 42, statusDetail: 'INTERNAL_DIAGNOSTIC',
  submittedAt: 1, lastSyncedAt: 2, taskId: 'business-task-a', localId: 1, modelId: 'model-a' };
const videoBindings = {
  task, isActiveVideoTaskStatus: (status: string) => ['pending', 'queued', 'processing', 'generating', 'finalizing'].includes(status),
  videoProgressLabel, Loader2: icon, Square: icon, models: [], boundVideoTaskModel,
  cancelTask: () => { throw new Error('DOM_RENDER_MUST_NOT_CANCEL_TASK'); }, nowTick: 10_000,
  confirmingVideoSubmission: videoSubmissionConfirmationSignal(task) === true,
};
assertNeutral(renderToStaticMarkup(evaluate<() => React.ReactNode>(`() => (${videoFrame})`, videoBindings)()));

const ackDeclaration = declaration(videoTree, 'confirmationPending');
let ackBlock: ts.Node = ackDeclaration;
while (!ts.isBlock(ackBlock)) ackBlock = ackBlock.parent;
for (const unknown of [true, false]) {
  let nextTasks: Array<Record<string, unknown>> = [{ localId: 1, clientRequestId: 'request-a', processingStage: 'submission_unknown' }];
  const notices: string[] = [];
  evaluate<() => void>(`() => ${ackBlock.getText(videoTree)}`, {
    data: { status: 'pending', task_submitted: unknown ? null : true, business_task_id: 'business-task-a',
      submission_outcome: unknown ? 'unknown' : 'accepted', message: 'INTERNAL_DIAGNOSTIC' },
    videoSubmissionConfirmationSignal, taskId: 'business-task-a', localId: 1, clientRequestId: 'request-a',
    task: { cardIndex: 1 }, currentModel: { id: 'model-a', name: '测试模型' },
    selectedModel: { modelName: '测试模型' }, selectedModelId: 'model-a',
    videoCacheSubmissionBinding: () => 'business-task-a',
    setTasks: (update: (tasks: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) => { nextTasks = update(nextTasks); },
    toast: { info: (message: string) => { notices.push(message); } },
    syncTaskToConversation: () => undefined, refreshHistoryFirstPage: () => undefined,
  })();
  assert.equal(nextTasks[0].status, 'queued', 'existing internal creation status remains queued');
  assert.equal(nextTasks[0].taskId, 'business-task-a');
  assert.equal(nextTasks[0].businessTaskId, 'business-task-a');
  assert.equal(nextTasks[0].clientRequestId, 'request-a');
  assert.equal(nextTasks[0].processingStage, unknown ? 'confirming_submission' : undefined);
  if (unknown) assert.equal(notices[0], '正在确认结果');
  assert.doesNotMatch(notices.join(' '), /INTERNAL_DIAGNOSTIC/u);
}
console.log(JSON.stringify({ passed: true, actualJsxSurfaces: 2, actualMarkerIdentityCases: 5,
  neutralConfirmation: true, repeatedStatusAndHeartbeatDoNotReportProgress: true, oldHistoryRestoration: true,
  confirmedProviderAndTerminalDoNotRegress: true, transientStateDoesNotMutateTask: true,
  actualCreateAckDisplayCases: 2, originalInternalStatusMappingPreserved: true,
  legacyMissingClientAndConflictingClientCases: 2,
  realNetworkRequests: 0, generationPosts: 0, actualDatabaseWrites: 0 }, null, 2));
