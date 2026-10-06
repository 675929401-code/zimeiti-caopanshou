import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Conversation } from "@/types/coze";
import { mergeCacheWithServer } from "@/lib/conversation-cache";
import {
  fingerprintPendingAudioPayload,
  readPendingAudioAttempt,
  writePendingAudioAttempt,
} from "@/features/digital-human/pending-audio-attempt";
import { readCoverGenerationState, runCoverGeneration } from "@/lib/cover-generation-attempt";
import { buildClientRequestFingerprint } from "@/lib/browser-client-attempt";
import { readGeneralScriptSubmission, saveGeneralScriptSubmission } from "@/features/general-script/submission-storage";
import { workbenchUserStorageKey } from "@/lib/workbench-user-storage";
import { parseImageWorkbenchPromptTransfer } from "@/lib/image-workbench-transfer";
import {
  BROWSER_IMAGE_ATTEMPT_TTL_MS,
  createBrowserImageAttemptReferences,
  parseBrowserImageAttemptReferences,
} from "@/lib/image-workbench-attempt-guard";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const storage = new MemoryStorage();
const sensitiveText = "这段数字人台词不能保存在浏览器草稿中";
const fingerprint = fingerprintPendingAudioPayload([sensitiveText, "voice-1", 1]);
assert.equal(fingerprint.includes(sensitiveText), false);
writePendingAudioAttempt(storage, "speech", { key: "digital-speech-12345678", fingerprint });
assert.equal(storage.getItem("speech")?.includes(sensitiveText), false);
assert.deepEqual(readPendingAudioAttempt(storage, "speech"), { key: "digital-speech-12345678", fingerprint });

storage.setItem("legacy", JSON.stringify({
  text: sensitiveText,
  voiceId: "voice-1",
  attempt: { key: "digital-speech-87654321", fingerprint: JSON.stringify([sensitiveText, "voice-1", 1]) },
}));
assert.ok(readPendingAudioAttempt(storage, "legacy"));
assert.equal(storage.getItem("legacy")?.includes(sensitiveText), false, "legacy draft must be scrubbed to a pointer");
storage.setItem("invalid-audio-pointer", "{");
assert.equal(readPendingAudioAttempt(storage, "invalid-audio-pointer"), undefined);
assert.equal(storage.getItem("invalid-audio-pointer"), null, "invalid pointer must be removed without manual cleanup");
storage.setItem("expired-audio-pointer", JSON.stringify({ version: 1, attempt: { key: "digital-speech-expired", fingerprint }, updatedAt: 0 }));
assert.equal(readPendingAudioAttempt(storage, "expired-audio-pointer"), undefined);
assert.equal(storage.getItem("expired-audio-pointer"), null, "expired pointer must be removed");

storage.setItem("cover-generation:v1:fixture-user", JSON.stringify({
  version: 1,
  pending: null,
  history: [{ status: "done", assetId: "owned-asset", historyRecordId: "server-history", prompt: sensitiveText }],
}));
assert.deepEqual(readCoverGenerationState(storage, "fixture-user"), { version: 1, pending: null, history: [] });
assert.equal(storage.getItem("cover-generation:v1:fixture-user")?.includes(sensitiveText), false, "terminal cover mirror must be scrubbed");
storage.setItem("cover-generation:v1:fixture-user", JSON.stringify({
  version: 1,
  pending: {
    clientIdempotencyKey: "cover_pending_12345678",
    clientTraceId: "cover_trace_12345678",
    updatedAt: Date.now(),
    payload: { prompt: sensitiveText, referenceImageUrls: ["data:image/png;base64,secret"] },
    task: { id: "legacy-task", prompt: sensitiveText, briefText: sensitiveText },
  },
  history: [],
}));
const restoredCoverAttempt = readCoverGenerationState(storage, "fixture-user");
assert.equal(restoredCoverAttempt.pending?.clientIdempotencyKey, "cover_pending_12345678");
assert.equal(restoredCoverAttempt.pending?.task.prompt, "", "reloaded cover pointer must not restore prompt text");
const scrubbedCoverPointer = storage.getItem("cover-generation:v1:fixture-user") || "";
for (const forbidden of [sensitiveText, "prompt", "briefText", "referenceImageUrls", "data:image", "blob:"]) {
  assert.equal(scrubbedCoverPointer.includes(forbidden), false, "cover browser pointer retained sensitive field: " + forbidden);
}

const imageAttemptReferences = createBrowserImageAttemptReferences([{
  id: "job_opaque_12345678",
  status: "unknown",
  prompt: sensitiveText,
  generationKey: "image_request_12345678",
  generationTraceId: "image_trace_12345678",
}], 1_000);
assert.equal(imageAttemptReferences.length, 1);
const serializedImagePointers = JSON.stringify(imageAttemptReferences);
for (const forbidden of [sensitiveText, "prompt", "referenceImageUrls", "data:image", "blob:"]) {
  assert.equal(serializedImagePointers.includes(forbidden), false, "image browser pointer retained sensitive field: " + forbidden);
}
assert.equal(parseBrowserImageAttemptReferences(imageAttemptReferences, 1_001).length, 1);
assert.equal(parseBrowserImageAttemptReferences(imageAttemptReferences, 1_000 + BROWSER_IMAGE_ATTEMPT_TTL_MS + 1).length, 0);

const message = (id: string, content: string) => ({ id, role: "assistant" as const, content, timestamp: 1 });
const conversation = (id: string, messages: Conversation["messages"]): Conversation => ({
  id, botId: null, agentId: "agent-1", agentName: "服务端智能体", agentIconUrl: "", title: id,
  lastMessage: messages.at(-1)?.content || "", lastMessageTime: 1, createdAt: 1, updatedAt: 1,
  messages, messagesLoaded: true, dirty: false,
});
const merged = mergeCacheWithServer(
  [conversation("server", [message("cached-only-message", "浏览器旧消息")]), conversation("cache-only", [message("cache", "旧会话")])],
  [conversation("server", [message("server-message", "服务端消息")])],
);
assert.deepEqual(merged.map((item) => item.id), ["server"], "browser-only conversation must not return");
assert.deepEqual(merged[0].messages.map((item) => item.id), ["server-message"], "browser-only messages must not merge");

async function main() {
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: storage },
});
let observedCoverPointer = "";
await runCoverGeneration({
  userId: "new-cover-user",
  token: "fixture-token",
  payload: {
    prompt: sensitiveText,
    modelId: "pm_cover_fixture",
    mode: "local",
    style: "",
    aspectRatio: "3:4",
    resolution: "1K",
    coverText: "",
    referenceImageUrls: ["data:image/png;base64,secret"],
    referenceUsage: "general",
    historySurface: "cover-studio",
  },
  task: {
    id: "cover-task-fixture",
    ratio: "3:4",
    title: "敏感标题",
    subtitle: "",
    prompt: sensitiveText,
    briefText: sensitiveText,
    source: "生成",
    createdAt: new Date().toISOString(),
    taskNo: 1,
    status: "running",
  },
  storage,
  onState: () => {},
  fetcher: async () => {
    observedCoverPointer = storage.getItem("cover-generation:v1:new-cover-user") || "";
    return new Response(JSON.stringify({
      code: "IMAGE_MODEL_PUBLICATION_REQUIRED",
      error: "模型未发布",
      upstreamCalled: false,
      billed: false,
      taskSubmitted: false,
    }), { status: 409, headers: { "Content-Type": "application/json" } });
  },
});
for (const forbidden of [sensitiveText, "敏感标题", "prompt", "briefText", "referenceImageUrls", "data:image", "blob:"]) {
  assert.equal(observedCoverPointer.includes(forbidden), false, "new cover attempt pointer retained sensitive field: " + forbidden);
}
const generalScriptText = "通用剧本未提交正文不能写进请求指针";
const secureScriptFingerprint = await buildClientRequestFingerprint({ requirements: generalScriptText });
const scriptIdentity = { requestId: "general-script-contract-request", fingerprint: secureScriptFingerprint };
saveGeneralScriptSubmission("general-script-contract", "fixture-user", scriptIdentity);
assert.deepEqual(readGeneralScriptSubmission("general-script-contract", "fixture-user"), scriptIdentity);
assert.equal([...storage.values.values()].some((value) => value.includes(generalScriptText)), false, "submission pointer must not retain script input");
const scriptPointerKey = workbenchUserStorageKey("general-script-contract:pending-request", "fixture-user");
storage.setItem(scriptPointerKey, JSON.stringify({ version: 1, identity: scriptIdentity, updatedAt: 0 }));
assert.equal(readGeneralScriptSubmission("general-script-contract", "fixture-user"), null, "expired script pointer must be cleared");
storage.setItem(scriptPointerKey, JSON.stringify({ requestId: "general-script-legacy-request", fingerprint: JSON.stringify({ requirements: generalScriptText }) }));
assert.equal(readGeneralScriptSubmission("general-script-contract", "fixture-user"), null, "legacy raw-input pointer must be retired");
assert.equal(storage.getItem(scriptPointerKey), null);
assert.equal(parseImageWorkbenchPromptTransfer(JSON.stringify({
  version: 1,
  ownerUserId: "fixture-user",
  createdAt: 0,
  items: [{ id: "old", prompt: generalScriptText, createdAt: 0, source: "chat-code" }],
})), null, "expired prompt handoff must not be accepted from a stale browser event");

const source = async (relative: string) => readFile(path.resolve(relative), "utf8");
const [officialScript, youcaiScript, legacyScript, filmStudio, submissionStorage, speech, imitation, transfer, storyboard, cover, imageWorkbench, appContext] = await Promise.all([
  source("src/features/general-script-official/general-script-official.tsx"),
  source("src/features/youcai-general-script/youcai-general-script.tsx"),
  source("src/features/general-script/general-script-workbench.tsx"),
  source("src/features/film-studio-project/film-studio-project-workbench.tsx"),
  source("src/features/general-script/submission-storage.ts"),
  source("src/features/digital-human/SpeechComposer.tsx"),
  source("src/features/digital-human/ImitationComposer.tsx"),
  source("src/lib/image-workbench-transfer.ts"),
  source("src/components/storyboard-workbench.tsx"),
  source("src/lib/cover-generation-attempt.ts"),
  source("src/components/image-workbench.tsx"),
  source("src/contexts/app-context.tsx"),
]);

for (const script of [officialScript, youcaiScript]) {
  assert.equal(script.includes("function restoreDraft("), false);
  assert.equal(/localStorage\.setItem\(storageKey,\s*JSON\.stringify\(draft\)\)/u.test(script), false);
  assert.match(script, /localStorage\.removeItem\(storageKey\)/u);
}
for (const script of [officialScript, youcaiScript, legacyScript, filmStudio]) {
  assert.match(script, /await buildClientRequestFingerprint\(/u);
}
assert.equal(legacyScript.includes("loadGeneralScriptDraft"), false);
assert.equal(legacyScript.includes("saveGeneralScriptDraft"), false);
assert.match(submissionStorage, /HASHED_FINGERPRINT_PATTERN/u);
assert.match(submissionStorage, /SUBMISSION_POINTER_TTL_MS/u);
for (const composer of [speech, imitation]) {
  assert.match(composer, /writePendingAudioAttempt\(localStorage/u);
  assert.equal(/localStorage\.setItem\(key,\s*JSON\.stringify\(next\)\)/u.test(composer), false);
}
assert.equal(transfer.includes("window.localStorage.setItem(workbenchUserStorageKey(IMAGE_WORKBENCH_TRANSFER_KEY"), false);
assert.match(transfer, /IMAGE_WORKBENCH_TRANSFER_TTL_MS/u);
assert.ok(storyboard.includes("createStoryboardPersistenceSnapshot(run)"));
assert.match(cover, /history: \[\]/u);
assert.ok(cover.includes("serializedAttemptState(reference)"));
assert.ok(cover.includes("inMemoryPendingCoverRequests"));
assert.equal(cover.includes("JSON.stringify(browserState)"), false);
assert.ok(imageWorkbench.includes("createBrowserImageAttemptReferences(jobs)"));
assert.ok(imageWorkbench.includes("parseBrowserImageAttemptReferences(parsed)"));
assert.equal(imageWorkbench.includes("JSON.stringify(unresolved)"), false);
assert.equal(appContext.includes("getCachedConversation(conversationId"), false);

console.log(JSON.stringify({
  ok: true,
  networkCalls: 0,
  providerCalls: 0,
  databaseWrites: 0,
  checks: {
    generalScriptDraftsRetired: true,
    digitalHumanPointersContainNoRawText: true,
    imageTransferSessionOnlyWithTtl: true,
    storyboardBrowserHistoryPendingOnly: true,
    coverOwnedTerminalHistoryServerOnly: true,
    coverPendingBrowserPointerIsOpaque: true,
    imagePendingBrowserPointersAreOpaqueAndExpiring: true,
    conversationCacheCannotAddMessagesOrConversations: true,
  },
}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
