import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canvasScopedStorageKey,
  resolveCanvasAuthenticatedUserId,
  resolveCanvasStorageScope,
  rotateCanvasAnonymousScope,
  type CanvasStorageLike,
} from "../src/lib/canvas-storage-scope";
import {
  createCanvasSessionId,
  prependFreshCanvasCopy,
  restoreActiveCanvasSession,
} from "../src/lib/canvas-session-lifecycle";
import {
  acknowledgeCanvasShowcaseReference,
  canvasShowcaseHandoffKey,
  readCanvasShowcaseReference,
  saveCanvasShowcaseReference,
} from "../src/features/official-inspiration/canvas-handoff";
import { CANVAS_SHARE_SHOWCASES } from "../src/features/official-inspiration/canvas-showcase-data";

class MemoryStorage implements CanvasStorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  keys() {
    return [...this.values.keys()];
  }
}

type TestNode = { id: string; prompt: string };
type TestSession = {
  id: string;
  sourceReferenceId: string;
  nodes: TestNode[];
  edges: Array<{ id: string; source: string; target: string }>;
};

const projectRoot = process.cwd();
const storage = new MemoryStorage();
const sessionsBaseKey = "ai-creation-studio-free-canvas-sessions-v1";
const activeBaseKey = "ai-creation-studio-free-canvas-active-session-v1";
const tokenSentinel = [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify({ userId: "user-a", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
  "never-write-this-token-into-a-canvas-key",
].join(".");

const resolvedUserA = resolveCanvasAuthenticatedUserId({
  token: tokenSentinel,
  appUserId: "stale-user",
  cachedAuthUser: JSON.stringify({ id: "also-stale" }),
});
assert.equal(resolvedUserA, "user-a", "current token claim must win over stale client caches");
const userAScope = resolveCanvasStorageScope(storage, resolvedUserA);
const userASessionsKey = canvasScopedStorageKey(sessionsBaseKey, userAScope);
storage.setItem(userASessionsKey, JSON.stringify([{ id: "a-private-canvas" }]));

const anonymousAfterLogout = resolveCanvasStorageScope(storage, null);
assert.match(anonymousAfterLogout, /^anonymous-/u);
assert.notEqual(anonymousAfterLogout, userAScope, "logout must stop addressing the authenticated user's namespace");
assert.equal(
  storage.getItem(canvasScopedStorageKey(sessionsBaseKey, anonymousAfterLogout)),
  null,
  "post-logout anonymous scope must not inherit user A sessions",
);
assert.equal(
  resolveCanvasStorageScope(storage, null),
  anonymousAfterLogout,
  "the explicit anonymous principal must survive a refresh",
);
const rotatedAnonymous = rotateCanvasAnonymousScope(storage);
assert.notEqual(rotatedAnonymous, anonymousAfterLogout, "explicit logout/disconnect rotation must create a new anonymous principal");

const userBScope = resolveCanvasStorageScope(storage, "user-b");
const userBSessionsKey = canvasScopedStorageKey(sessionsBaseKey, userBScope);
assert.notEqual(userBSessionsKey, userASessionsKey);
assert.equal(storage.getItem(userBSessionsKey), null, "user B must not inherit user A sessions");
assert.ok(
  storage.keys().every((key) => !key.includes(tokenSentinel) && !key.includes("never-write-this-token")),
  "tokens must never be embedded in Canvas storage keys",
);

const showcaseId = "canvas-showcase-78f7a4a9ce11-paper-fox-adventure";
const showcase = CANVAS_SHARE_SHOWCASES.find((item) => item.id === showcaseId);
assert.ok(showcase, "showcase fixture must exist");
const replayStorage = new MemoryStorage();
assert.equal(saveCanvasShowcaseReference(showcase, replayStorage), true, "copy CTA must save a replayable graph");
const anonymousImport = readCanvasShowcaseReference(showcaseId, replayStorage);
assert.equal(anonymousImport?.workflow?.nodes.length, showcase.nodes.length);
assert.equal(anonymousImport?.workflow?.edges.length, showcase.edges.length);
assert.ok(
  replayStorage.getItem(canvasShowcaseHandoffKey(showcaseId)),
  "anonymous import must not consume the only replay before account persistence",
);
const authenticatedReplay = readCanvasShowcaseReference(showcaseId, replayStorage);
assert.deepEqual(
  authenticatedReplay?.workflow,
  anonymousImport?.workflow,
  "authenticated scope must be able to replay the exact anonymous import graph without creating a second handoff",
);
assert.equal(
  acknowledgeCanvasShowcaseReference(showcaseId, replayStorage),
  true,
  "the handoff may be acknowledged after the account copy is durable",
);
assert.equal(
  readCanvasShowcaseReference(showcaseId, replayStorage),
  null,
  "a durable account copy must clear the replay so refresh cannot import a duplicate",
);
const currentSnapshot: Pick<TestSession, "sourceReferenceId" | "nodes" | "edges"> = {
  sourceReferenceId: showcaseId,
  nodes: [
    { id: `showcase:${showcaseId}:node-1`, prompt: "current public snapshot" },
    { id: `showcase:${showcaseId}:node-2`, prompt: "independent media node" },
  ],
  edges: [{ id: "edge-1", source: `showcase:${showcaseId}:node-1`, target: `showcase:${showcaseId}:node-2` }],
};
const makeCopy = (suffix: string): TestSession => ({
  id: createCanvasSessionId(() => suffix),
  sourceReferenceId: currentSnapshot.sourceReferenceId,
  nodes: currentSnapshot.nodes.map((node) => ({ ...node })),
  edges: currentSnapshot.edges.map((edge) => ({ ...edge })),
});

const firstCopyResult = prependFreshCanvasCopy<TestSession>([], () => makeCopy("copy-one"));
const firstWithSentinel: TestSession = {
  ...firstCopyResult.activeSession,
  nodes: [
    ...firstCopyResult.activeSession.nodes,
    { id: "old-sentinel", prompt: "must not leak into the next copy" },
  ],
};
const sessionsAfterEditingFirst = [firstWithSentinel];
const secondCopyResult = prependFreshCanvasCopy(sessionsAfterEditingFirst, () => makeCopy("copy-two"));
assert.notEqual(secondCopyResult.activeSession.id, firstWithSentinel.id, "each copy click must create a distinct canvasId");
assert.equal(
  secondCopyResult.activeSession.nodes.some((node) => node.id === "old-sentinel"),
  false,
  "the second copy must come from the current handoff snapshot, not the edited first copy",
);
assert.equal(
  secondCopyResult.sessions.find((session) => session.id === firstWithSentinel.id)?.nodes.some((node) => node.id === "old-sentinel"),
  true,
  "the independent first copy may remain in history without contaminating the active second copy",
);

const userBActiveKey = canvasScopedStorageKey(activeBaseKey, userBScope);
storage.setItem(userBSessionsKey, JSON.stringify(secondCopyResult.sessions));
storage.setItem(userBActiveKey, secondCopyResult.activeSession.id);
const reloadedSessions = JSON.parse(storage.getItem(userBSessionsKey) || "[]") as TestSession[];
const restored = restoreActiveCanvasSession(reloadedSessions, storage.getItem(userBActiveKey));
assert.equal(restored?.id, secondCopyResult.activeSession.id, "refresh must restore the exact newly copied canvasId");
assert.deepEqual(restored?.nodes, currentSnapshot.nodes, "refresh must restore the same-case graph without the old sentinel");

const manualCanvasSource = fs.readFileSync(path.join(projectRoot, "src/components/manual-canvas.tsx"), "utf8");
const freeCanvasShellSource = fs.readFileSync(path.join(projectRoot, "src/components/free-canvas-shell.tsx"), "utf8");
const legacyWorkspaceSource = fs.readFileSync(path.join(projectRoot, "src/app/youcai/tools/canvas/workspace/[showcaseId]/page.tsx"), "utf8");
const zeroCostRuntimeSource = fs.readFileSync(path.join(projectRoot, "scripts/verify-youcai-canvas-runtime-zero-cost.ts"), "utf8");
assert.match(manualCanvasSource, /prependFreshCanvasCopy\(sessions, createImportedSession\)/u);
assert.match(
  manualCanvasSource,
  /const remoteCanvases:[\s\S]*?fetch\(`\/api\/canvas\?includeDocuments=1&limit=50&offset=\$\{nextOffset\}`[\s\S]*?restoreActiveCanvasSession\(sessions, null\)[\s\S]*?setCanvasSessions\(sessions\)[\s\S]*?setHydrated\(true\)/u,
  "authenticated Canvas hydration must restore the server-owned session before marking the UI hydrated",
);
assert.doesNotMatch(manualCanvasSource, /existingImportedSession|matchesReference/u);
assert.doesNotMatch(
  manualCanvasSource,
  /localStorage\.(?:getItem|setItem)\((?:GRAPH_STORAGE_KEY|CANVAS_SESSIONS_KEY|ACTIVE_CANVAS_SESSION_KEY|CANVAS_RUN_HISTORY_KEY|CANVAS_DIAGNOSTICS_KEY)/u,
  "Canvas content keys must never be read or written without the current storage scope",
);
assert.match(
  freeCanvasShellSource,
  /key=\{`\$\{canvasStorageScope\}:\$\{expectedShowcaseId \|\| canvasHandoff\?\.inspirationId \|\| "default"\}`\}/u,
  "Canvas identity and imported showcase identity must both remount the isolated workspace",
);
assert.match(freeCanvasShellSource, /storageScope=\{canvasStorageScope!\}/u);
assert.match(freeCanvasShellSource, /logout\(\)/u);
assert.match(freeCanvasShellSource, /consumeCanvasShowcaseReference\(expectedShowcaseId\)/u);
assert.match(freeCanvasShellSource, /initialDraft=\{canvasDraft\}/u);
assert.match(freeCanvasShellSource, /onReferencePersisted=\{handleReferencePersisted\}/u);
assert.match(manualCanvasSource, /onLocalDraftChange\(\{[\s\S]*referenceId,[\s\S]*session:/u);
assert.match(manualCanvasSource, /if \(session\.sourceReferenceId\) onReferencePersisted\?\.\(session\.sourceReferenceId\)/u);
const anonymousHydrationBlock = manualCanvasSource.match(/if \(!token\) \{([\s\S]*?)setMemoryOnlySession\(memoryOnlyNotice, "blocked"\);/u)?.[1] || "";
assert.ok(anonymousHydrationBlock, "anonymous hydration branch must remain explicit");
assert.doesNotMatch(
  anonymousHydrationBlock,
  /onRequireLogin/u,
  "anonymous local editing must not auto-open the full-screen login modal",
);
assert.match(legacyWorkspaceSource, /<CanvasShowcaseEditorEntry showcase=\{showcase\} \/>/u);
assert.doesNotMatch(legacyWorkspaceSource, /redirect\(`\/youcai\/share\/canvas\//u);
assert.doesNotMatch(
  zeroCostRuntimeSource,
  /addStyleTag|modal-backdrop\{display:\s*none/u,
  "runtime acceptance must never hide a blocking login overlay with injected CSS",
);
assert.match(zeroCostRuntimeSource, /copied\.transientModalDismissed/u);
assert.match(zeroCostRuntimeSource, /copied\.interaction\.textEdited/u);
assert.match(zeroCostRuntimeSource, /copied\.interaction\.nodeDragged/u);

console.log(JSON.stringify({
  ok: true,
  noModelCalls: true,
  noDatabaseWrites: true,
  authenticatedScopes: { userA: userAScope, userB: userBScope },
  anonymousScopes: { afterLogout: anonymousAfterLogout, rotated: rotatedAnonymous },
  copyCanvasIds: [firstWithSentinel.id, secondCopyResult.activeSession.id],
  replayedShowcaseId: authenticatedReplay?.inspirationId,
  refreshedCanvasId: restored?.id,
  refreshedNodeCount: restored?.nodes.length,
}, null, 2));
