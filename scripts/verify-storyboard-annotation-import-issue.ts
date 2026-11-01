import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { directorAnnotationPatch, dismissStoryboardAnnotationIssuePatch, storyboardAnnotationImportState, storyboardAnnotationSubmissionIssue } from "../src/lib/storyboard-annotation-card";
import { isRestorableImageExactText, isValidImageExactText } from "../src/lib/storyboard-annotation-layout";
import { parseStoryboardAgentOutput } from "../src/lib/storyboard-agent-output";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";
import { buildLegacyStoryboardDraftDetail } from "../src/lib/storyboard-legacy-prompt-draft";
import { normalizeStoryboardDirectorInput } from "../src/lib/storyboard-director-protocol";
import { buildStoryboardPromptDraftDetail } from "../src/lib/storyboard-prompt-draft";
import { createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { StoryboardChainRequestSchema, resolveStoryboardExecutionMode, storyboardChainInputFingerprint, type StoryboardChainRequest, type StoryboardChainRun } from "../src/lib/storyboard-chain-contract";
import { storyboardChainContext, storyboardChainSnapshotMatches } from "../src/lib/storyboard-chain-controller";
import { readStoryboardRecovery, writeStoryboardRecovery, storyboardRecoveryContentFingerprint, inspectStoryboardRecoveryEdits } from "../src/lib/storyboard-workspace-recovery";

const validPrompt = ["四格故事板，底栏三行。", ...[1, 2, 3, 4].flatMap(shot => [`“中文说明${shot}”`, `SHOT 0${shot} | CAMERA: Low medium shot`, `ACTION: Dog moves ${shot}`])].join("\n");
const invalidPrompt = validPrompt.replace("ACTION: Dog moves 4", "").trim(), narration = "小狗走向主人。";
const fresh = storyboardAnnotationImportState(invalidPrompt);
assert.ok(fresh.imageAnnotationIssue); assert.equal(fresh.imageTextLayoutEnabled, false); assert.equal(fresh.imageExactText, undefined);
assert.deepEqual(storyboardAnnotationImportState("只有画面，没有注释"), {});
const valid = storyboardAnnotationImportState(validPrompt); assert.equal(valid.imageTextLayoutEnabled, true); assert.equal(valid.imageAnnotationIssue, undefined);
const card = { id: "card-annotation-1", order: 1, imagePrompt: invalidPrompt, videoPrompt: "小狗走向主人。", referenceImageUrls: [], imageStatus: "idle", videoStatus: "idle", ...fresh };
assert.match(storyboardAnnotationSubmissionIssue(card) || "", /应用导演注释.*不使用注释/u);
const dismissed = { ...card, ...dismissStoryboardAnnotationIssuePatch(card) };
assert.equal(dismissed.imageAnnotationIssue, undefined); assert.equal(dismissed.imageTextLayoutEnabled, false); assert.equal(storyboardAnnotationSubmissionIssue(dismissed), null);
assert.equal(storyboardAnnotationSubmissionIssue({ imagePrompt: invalidPrompt, imageTextLayoutEnabled: false }), null, "Historical explicit false must not gain a marker");
const repaired = { ...card, imagePrompt: validPrompt }, applied = { ...repaired, ...directorAnnotationPatch(repaired) };
assert.equal(applied.imageAnnotationIssue, undefined); assert.equal(applied.imageTextLayoutEnabled, true); assert.ok(isValidImageExactText(applied.imageExactText));
assert.equal(storyboardAnnotationSubmissionIssue(applied), null);
const identities = ["imageClientRequestId", "imageClientTraceId", "imageClientRequestFingerprint", "imageRequestSnapshot", "imageRecordId", "imageUrl", "imageRef", "imageAssetId", "imageStorageKey", "imageSubmittedAt", "imageValidatedAt", "imageAttemptOrdinal", "imageBillingState", "imagePriceCharged", "imageModelIdUsed", "videoTaskId", "videoClientRequestId", "videoUrl"];
for (const key of identities) {
  const accepted = { ...repaired, [key]: key === "imagePriceCharged" ? 0 : "accepted" };
  assert.equal(directorAnnotationPatch(accepted), null, key); assert.equal(dismissStoryboardAnnotationIssuePatch(accepted), null, key);
}
const input = normalizeStoryboardDirectorInput({ segmented_script: `1. ${narration}`, visual_asset_mode: "普通模式" });
const annotationFields = ["imageAnnotationIssue", "imageTextLayoutEnabled", "imageExactText"];
let importCases = 0;
for (const sourcePrompt of [invalidPrompt, validPrompt, "只有画面，没有注释"]) {
  const visible = `原文案内容段落 1：【${narration}】\n图片提示词：\n\`\`\`text\n${sourcePrompt}\n\`\`\`\n视频提示词：\n\`\`\`text\n小狗走向主人。\n\`\`\``;
  const imported = parseStoryboardAgentOutput(visible); assert.equal(imported.ok, true);
  if (!imported.ok) throw new Error("Visible source must remain importable");
  const message = { id: "annotation-import-message", role: "assistant", content: visible };
  const legacyDetail = buildLegacyStoryboardDraftDetail(message, input, { allowLegacy: true, submittedAt: 1, cutoff: 2 });
  const promptDetail = buildStoryboardPromptDraftDetail(message, input);
  assert.ok(legacyDetail, "Legacy source remains importable without an annotation gate");
  assert.ok(promptDetail, "Current prompt draft remains importable without an annotation gate");
  const legacyCanvas = parseStoryboardCanvasImport(legacyDetail), promptCanvas = parseStoryboardCanvasImport(promptDetail);
  assert.ok(legacyCanvas); assert.ok(promptCanvas);
  for (const segment of [imported.segments[0], legacyCanvas.segments[0], promptCanvas.segments[0]]) {
    assert.equal(segment.imagePrompt, sourcePrompt, "Every import path must preserve the complete original prompt");
    assert.equal(segment.videoPrompt, "小狗走向主人。");
    for (const field of annotationFields) assert.equal(Object.hasOwn(segment, field), false, `Import must not derive ${field}`);
    importCases++;
  }
}

const run = { id: "annotation-issue-project", title: "注释导入测试", createdAt: 1, updatedAt: 1, ratio: "16:9" as const, imageResolution: "2K", videoResolution: "720p", videoDuration: 15, imageModelId: "image-model", videoModelId: "video-model", cards: [card] };
const persisted = createStoryboardPersistenceSnapshot(run); assert.equal(persisted.cards[0].imageAnnotationIssue, fresh.imageAnnotationIssue);
const exported = JSON.parse(JSON.stringify(persisted)); assert.equal(StoryboardProjectDocument.parse(exported).cards[0].imageAnnotationIssue, fresh.imageAnnotationIssue);
const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
writeStoryboardRecovery(storage, "fixture-annotation-recovery", run); assert.equal(readStoryboardRecovery(storage, "fixture-annotation-recovery")?.run.cards[0].imageAnnotationIssue, fresh.imageAnnotationIssue);
const local = { ...run, cards: [dismissed] }, baseContentFingerprint = storyboardRecoveryContentFingerprint(run);
const merged = inspectStoryboardRecoveryEdits(run, { run: local, baseContentFingerprint }); assert.equal(merged.status, "applied"); assert.equal(merged.run.cards[0].imageAnnotationIssue, undefined); assert.equal(merged.run.cards[0].imageTextLayoutEnabled, false);
const acceptedCloud = { ...run, cards: [{ ...card, imageClientRequestId: "accepted-request" }] };
const frozen = inspectStoryboardRecoveryEdits(acceptedCloud, { run: { ...acceptedCloud, cards: [{ ...acceptedCloud.cards[0], imageAnnotationIssue: undefined, imageTextLayoutEnabled: true }] }, baseContentFingerprint: storyboardRecoveryContentFingerprint(acceptedCloud) });
assert.equal(frozen.status, "applied"); assert.equal(frozen.run.cards[0].imageAnnotationIssue, fresh.imageAnnotationIssue); assert.equal(frozen.run.cards[0].imageTextLayoutEnabled, false);
const restoredDismissed = createStoryboardPersistenceSnapshot(local); assert.equal(restoredDismissed.cards[0].imageAnnotationIssue, undefined); assert.equal(restoredDismissed.cards[0].imageTextLayoutEnabled, false);

const acceptedLegacy = "STORYBOARD_ANNOTATIONS_V1\nSHOT 01 | CAMERA: Wide\nACTION: Dog waits";
assert.equal(isValidImageExactText(acceptedLegacy), false); assert.equal(isRestorableImageExactText(acceptedLegacy), true);
const workbench = readFileSync("src/components/storyboard-workbench.tsx", "utf8"), syntax = ts.createSourceFile("workbench.tsx", workbench, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const declaration = syntax.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "isStoryboardImageRequestSnapshot"); assert.ok(declaration);
const compiled = ts.transpileModule(`${declaration.getText(syntax)}\nmodule.exports=isStoryboardImageRequestSnapshot;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const snapshotFixtureModule = { exports: undefined as unknown as (value: unknown) => boolean };
runInNewContext(compiled, { module: snapshotFixtureModule, StoryboardChainRequestSchema, isRestorableImageExactText, isWorkbenchRatio: (value: unknown) => ["16:9", "9:16", "1:1"].includes(String(value)) });
assert.equal(snapshotFixtureModule.exports({ runId: run.id, cardId: card.id, cardOrder: 1, prompt: invalidPrompt, modelId: "image-model", aspectRatio: "16:9", resolution: "2K", referenceImageUrls: [], strictSingleSubmit: true, exactText: acceptedLegacy }), true);
assert.doesNotMatch(workbench, /storyboardAnnotationSubmissionIssue|directorAnnotationPatch|dismissStoryboardAnnotationIssuePatch|导演注释预览|四格分镜注释 · 平台排版|画面精确文字/u,
  "Workbench must not add an annotation gate or a third text area");

function nodesMatching<T extends ts.Node>(guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node) { if (guard(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(syntax); return found;
}
function evaluateExpression<T = Record<string, unknown>>(expression: ts.Expression, context: Record<string, unknown>): T {
  const fixtureModule = { exports: {} as T };
  const source = ts.transpileModule(`module.exports = (${expression.getText(syntax)});`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { module: fixtureModule, ...context });
  return fixtureModule.exports;
}
const newSnapshotAssignments = nodesMatching(ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  && ts.isIdentifier(node.left) && node.left.text === "requestSnapshot" && ts.isObjectLiteralExpression(node.right));
assert.equal(newSnapshotAssignments.length, 1, "Test must exercise the actual new-image snapshot constructor");
const imageFetches = nodesMatching(ts.isCallExpression).filter(node => ts.isIdentifier(node.expression) && node.expression.text === "fetch"
  && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "/api/image/generate"
  && node.arguments[1]?.getText(syntax).includes("requestSnapshot.prompt"));
assert.equal(imageFetches.length, 1, "Test must exercise the actual storyboard image request body");
const fetchOptions = imageFetches[0].arguments[1]; assert.ok(ts.isObjectLiteralExpression(fetchOptions));
const body = fetchOptions.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(syntax) === "body");
assert.ok(body && ts.isPropertyAssignment(body) && ts.isCallExpression(body.initializer));
const payloadExpression = body.initializer.arguments[0]; assert.ok(ts.isObjectLiteralExpression(payloadExpression));
const requestContext = { clientTraceId: "fixture-trace-key", clientIdempotencyKey: "fixture-request-key" };
const createCardDeclaration = syntax.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "createCard");
assert.ok(createCardDeclaration);
const createCardModule = { exports: undefined as unknown as (order: number) => Record<string, unknown> };
runInNewContext(ts.transpileModule(`${createCardDeclaration.getText(syntax)}\nmodule.exports=createCard;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: createCardModule, createId: () => "fixture-new-card" });
const newCard = createCardModule.exports(1);
assert.notEqual(newCard.imageTextLayoutEnabled, true); assert.equal(Boolean(newCard.imageExactText), false);
let submissionCases = 0;
for (const sourcePrompt of [invalidPrompt, validPrompt, "只有画面，没有注释"]) {
  for (const legacyFields of [{}, { imageExactText: acceptedLegacy, imageTextLayoutEnabled: true, imageAnnotationIssue: "旧注释格式错误" }]) {
    const candidate = { ...newCard, ...legacyFields, imagePrompt: sourcePrompt };
    const requestSnapshot = evaluateExpression(newSnapshotAssignments[0].right, {
      card: candidate, current: run, model: { id: "image-model" }, refreshed: candidate, chainContext: undefined,
      effectiveImageRatio: () => "16:9", effectiveImageResolution: () => "2K", activeStoryboardVisualAssetRefs: () => [],
    });
    assert.equal(requestSnapshot.prompt, sourcePrompt);
    assert.equal(Object.hasOwn(requestSnapshot, "chainContext"), false, "Ordinary requests must not acquire chain context");
    assert.equal(Object.hasOwn(requestSnapshot, "exactText"), false, "Old card fields must not reactivate new-request composition");
    const payload: Record<string, unknown> = evaluateExpression(payloadExpression, { ...requestContext, requestSnapshot, recovering: false });
    assert.equal(payload.prompt, sourcePrompt); assert.equal(payload.resumeDeliveryOnly, false);
    assert.equal(Object.hasOwn(payload, "chainContext"), false, "Ordinary payload must omit chain context");
    assert.equal(Object.hasOwn(payload, "coverText"), false, "New image requests must not send a derived annotation field");
    submissionCases++;
  }
}
// Follow the real mode/qualification initializer, rather than injecting a
// context object that bypasses anchor confirmation or predecessor completion.
const chainContextDeclarations = nodesMatching(ts.isVariableDeclaration).filter(node => ts.isIdentifier(node.name) && node.name.text === "chainContext" && node.initializer);
assert.equal(chainContextDeclarations.length, 1, "Test must use actual chain context qualification");
const chainInitializer = chainContextDeclarations[0].initializer!;
const deriveChain = (current: StoryboardChainRun, cardId: string, maxReferenceImages = 2) => evaluateExpression<StoryboardChainRequest | undefined>(chainInitializer, {
  current, cardId, capabilities: { maxReferenceImages }, resolveStoryboardExecutionMode, storyboardChainContext,
});
let chainQualificationCases = 0;
for (const executionMode of ["ordinary", "reference"] as const) { assert.equal(deriveChain({ ...run, executionMode }, card.id), undefined, "non-chain modes must not inherit context"); chainQualificationCases++; }
const chainRun: StoryboardChainRun = { ...run, executionMode: "chained", chainRevision: 1, cards: [
  { id: "chain-anchor", order: 1, imagePrompt: "首段原始画面", imageStatus: "done", imageRef: { schema: "generated_image_ref.v1", recordId: "a".repeat(64) } },
  { id: "chain-previous", order: 2, imagePrompt: "前段原始画面", imageStatus: "done", imageRef: { schema: "generated_image_ref.v1", recordId: "b".repeat(64) } },
  { ...card, id: "chain-target", order: 3, imagePrompt: validPrompt },
] };
chainRun.cards[0].chainAnchorConfirmation = { schema: "storyboard_chain_anchor_confirmation.v1", recordId: "a".repeat(64), confirmedAt: 1,
  inputFingerprint: storyboardChainInputFingerprint(chainRun, chainRun.cards[0]), chainRevision: 1 };
const qualifiedChain = deriveChain(chainRun, "chain-target"); assert.ok(qualifiedChain); assert.equal(StoryboardChainRequestSchema.safeParse(qualifiedChain).success, true);
assert.equal(qualifiedChain.anchor?.imageRef.recordId, "a".repeat(64)); assert.equal(qualifiedChain.previous?.imageRef.recordId, "b".repeat(64)); chainQualificationCases++;
const firstChain = deriveChain(chainRun, "chain-anchor"); assert.ok(firstChain); assert.equal(firstChain.anchor, undefined, "first chain card must not fabricate an anchor dependency"); chainQualificationCases++;
for (const unqualified of [
  { ...chainRun, cards: chainRun.cards.map((item, index) => index === 0 ? { ...item, chainAnchorConfirmation: undefined } : item) },
  { ...chainRun, chainRevision: 2 },
  { ...chainRun, cards: chainRun.cards.map((item, index) => index === 1 ? { ...item, imageStatus: "idle" } : item) },
]) { assert.throws(() => deriveChain(unqualified, "chain-target"), /确认|未完成/u, "unqualified dependency must stop before snapshot construction"); chainQualificationCases++; }
assert.throws(() => deriveChain(chainRun, "chain-target", 0), /不支持参考图/u); chainQualificationCases++;
const chainCard = chainRun.cards[2];
const chainSnapshot = evaluateExpression(newSnapshotAssignments[0].right, { card: chainCard, current: chainRun, model: { id: "image-model" }, refreshed: { ...chainCard, referenceImageUrls: [], visualAssetRefs: [] }, chainContext: qualifiedChain,
  effectiveImageRatio: () => "16:9", effectiveImageResolution: () => "2K", activeStoryboardVisualAssetRefs: () => [] });
assert.equal(snapshotFixtureModule.exports(chainSnapshot), true); assert.equal(Object.hasOwn(chainSnapshot, "exactText"), false);
assert.equal(JSON.stringify(chainSnapshot.chainContext), JSON.stringify(qualifiedChain));
assert.equal(storyboardChainSnapshotMatches(chainRun, chainCard.id, chainSnapshot as unknown as Parameters<typeof storyboardChainSnapshotMatches>[2]), true);
assert.equal(snapshotFixtureModule.exports({ ...chainSnapshot, chainContext: { ...qualifiedChain, chainRevision: 0 } }), false, "invalid chain schema must fail snapshot admission"); chainQualificationCases++;
const chainPayload = evaluateExpression(payloadExpression, { ...requestContext, requestSnapshot: chainSnapshot, recovering: false });
assert.equal(JSON.stringify(chainPayload.chainContext), JSON.stringify(qualifiedChain)); assert.equal(chainPayload.prompt, validPrompt); assert.equal(Object.hasOwn(chainPayload, "coverText"), false);
const changedChainRun = { ...chainRun, cards: chainRun.cards.map(item => item.id === chainCard.id ? { ...item, imagePrompt: "新的历史后续输入" } : item) };
assert.equal(storyboardChainSnapshotMatches(changedChainRun, chainCard.id, chainSnapshot as unknown as Parameters<typeof storyboardChainSnapshotMatches>[2]), false, "changed current input must not claim a historical chain snapshot as current"); chainQualificationCases++;
const serializedChainSnapshot = JSON.stringify(chainSnapshot);
const historicalChainPayload = evaluateExpression(payloadExpression, { ...requestContext, requestSnapshot: chainSnapshot, recovering: true });
assert.equal(JSON.stringify(historicalChainPayload.chainContext), JSON.stringify(qualifiedChain), "accepted recovery retains frozen dependencies"); assert.equal(JSON.stringify(chainSnapshot), serializedChainSnapshot);
const legacySnapshot = { runId: run.id, cardId: card.id, cardOrder: 1, prompt: invalidPrompt, modelId: "image-model",
  aspectRatio: "16:9", resolution: "2K", referenceImageUrls: [], strictSingleSubmit: true, exactText: acceptedLegacy };
const serializedLegacy = JSON.stringify(legacySnapshot);
for (const recovering of [false, true]) {
  const payload: Record<string, unknown> = evaluateExpression(payloadExpression, { ...requestContext, requestSnapshot: legacySnapshot, recovering });
  assert.equal(payload.prompt, invalidPrompt); assert.equal(payload.resumeDeliveryOnly, recovering);
  assert.equal(Object.hasOwn(payload, "coverText"), recovering);
  assert.equal(Object.hasOwn(payload, "chainContext"), false, "old history without a chain must remain without a chain");
  if (recovering) assert.equal(payload.coverText, acceptedLegacy, "Accepted request recovery must retain original exact text");
}
assert.equal(JSON.stringify(legacySnapshot), serializedLegacy, "Legacy immutable snapshot must remain unchanged");
const fingerprintDeclaration = syntax.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "storyboardImageFingerprintPayload");
assert.ok(fingerprintDeclaration);
const fingerprintModule = { exports: undefined as unknown as (value: unknown) => Record<string, unknown> };
runInNewContext(ts.transpileModule(`${fingerprintDeclaration.getText(syntax)}\nmodule.exports=storyboardImageFingerprintPayload;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: fingerprintModule });
assert.equal(Object.hasOwn(fingerprintModule.exports(legacySnapshot), "chainContext"), false);
assert.equal(JSON.stringify(fingerprintModule.exports(chainSnapshot).chainContext), JSON.stringify(qualifiedChain), "chain fingerprint must bind original qualified dependencies");
assert.equal(fingerprintModule.exports(legacySnapshot).exactText, acceptedLegacy, "Old request fingerprint must still bind original exact text");
console.log(JSON.stringify({ status: "PASS", networkCalls: 0, businessWrites: 0, acceptedIdentityCases: identities.length, importCases, submissionCases, chainQualificationCases,
  checks: ["all-imports-preserve-complete-original-prompts", "no-derived-annotation-fields", "new-requests-ignore-old-card-annotation-fields", "no-third-text-area-or-annotation-gate", "actual-new-snapshot-and-post-payload", "legacy-state-and-export-preserved", "accepted-legacy-snapshot-and-fingerprint-restorable", "only-recovery-sends-original-exact-text", "real-chain-qualification-and-propagation", "unqualified-chain-stops-before-construction", "historical-chain-and-nonchain-identities-unchanged"] }));
