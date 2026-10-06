import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const srcRoot = path.join(root, "src");
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const routeEntries = {
  video: ["src/app/video/page.tsx"],
  image: ["src/app/image-workbench/page.tsx"],
  storyboard: ["src/app/storyboard-workbench/page.tsx"],
  generalScript: ["src/app/tools/text/general-script/page.tsx"],
  digitalHuman: ["src/app/digital-human/page.tsx"],
  cover: ["src/app/cover/page.tsx"],
  extract: ["src/app/extract/page.tsx", "src/app/segmenter/page.tsx"],
  chat: [
    "src/app/tools/text/text-chat/page.tsx",
    "src/features/official-home/official-home-page.tsx",
    "src/features/official-inspiration/official-inspiration-gallery.tsx",
    "src/features/official-tool-directory/official-creation-center.tsx",
  ],
  voice: ["src/app/voice-studio/layout.tsx", "src/app/voice-studio/workspace/page.tsx"],
} as const;

const forbiddenImport = /(?:^|[/\\])(?:commerce|free-canvas)(?:[/\\]|$)|(?:^|[/\\])commerce[-_.]/iu;
const normalized = (value: string) => path.relative(root, value).replace(/\\/gu, "/");

function resolveSource(fromFile: string, specifier: string): string | null {
  if (forbiddenImport.test(specifier)) return null;
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const base = specifier.startsWith("@/")
    ? path.join(srcRoot, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  if (forbiddenImport.test(base)) return null;
  const candidates = [
    base,
    ...extensions.map((extension) => base + extension),
    ...extensions.map((extension) => path.join(base, "index" + extension)),
  ];
  for (const candidate of candidates) {
    if (forbiddenImport.test(candidate) || !existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const relative = path.relative(srcRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return candidate;
  }
  return null;
}

function importedSpecifiers(file: string, sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const result = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      result.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...result];
}

const entryFiles = Object.values(routeEntries).flat().map((entry) => path.join(root, entry));
for (const entry of entryFiles) assert.ok(existsSync(entry), `missing route entry: ${normalized(entry)}`);

const reachable = new Map<string, string>();
const queue = [...entryFiles];
while (queue.length) {
  const file = queue.pop()!;
  if (reachable.has(file)) continue;
  assert.ok(!forbiddenImport.test(file), `forbidden source entered graph: ${normalized(file)}`);
  const sourceText = readFileSync(file, "utf8");
  reachable.set(file, sourceText);
  for (const specifier of importedSpecifiers(file, sourceText)) {
    const dependency = resolveSource(file, specifier);
    if (dependency && !reachable.has(dependency)) queue.push(dependency);
  }
}

type StorageWrite = {
  file: string;
  line: number;
  storage: "local" | "session" | "safe";
  key: string;
  value: string;
};

function directStorageKind(expression: ts.Expression): StorageWrite["storage"] | null {
  if (ts.isIdentifier(expression)) {
    if (expression.text === "localStorage") return "local";
    if (expression.text === "sessionStorage") return "session";
    return null;
  }
  if (ts.isPropertyAccessExpression(expression)
    && (expression.name.text === "localStorage" || expression.name.text === "sessionStorage")) {
    return expression.name.text === "localStorage" ? "local" : "session";
  }
  return null;
}

function storageWrites(file: string, sourceText: string): StorageWrite[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const writes: StorageWrite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let storage: StorageWrite["storage"] | null = null;
      if (ts.isIdentifier(node.expression) && node.expression.text === "safeSetItem") storage = "safe";
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setItem") {
        storage = directStorageKind(node.expression.expression);
      }
      if (storage) {
        writes.push({
          file: normalized(file),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          storage,
          key: node.arguments[0]?.getText(sourceFile) || "",
          value: node.arguments[1]?.getText(sourceFile) || "",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return writes;
}

const writes = [...reachable].flatMap(([file, sourceText]) => storageWrites(file, sourceText));

const allowedLocalWrites: Array<(write: StorageWrite) => boolean> = [
  (write) => write.file === "src/components/cover-studio.tsx" && /^(?:FAVORITE_TEMPLATES_KEY|TOKEN_KEY)$/u.test(write.key),
  (write) => write.file === "src/features/official-core-routes/official-agent-route.tsx" && /^(?:PROMPT_LIBRARY_STORAGE_KEY|ASSET_FAVORITES_STORAGE_KEY)$/u.test(write.key),
  (write) => write.file === "src/hooks/use-voice-favorites.ts" && write.key === "key",
  (write) => write.file === "src/hooks/use-storyboard-projects.ts" && write.key === "versionKey",
  (write) => write.file === "src/components/vs/GlobalTaskBar.tsx" && write.key.includes("runningTaskKey") && write.value === "JSON.stringify(pointer)",
  (write) => write.file === "src/features/digital-human/VoiceClonePanel.tsx" && write.key === "key" && write.value === "original",
  (write) => write.file === "src/app/extract/page.tsx" && write.storage === "safe" && write.key === "STORAGE_KEYS.AUTH_USER",
  (write) => write.file === "src/contexts/chat-reducer.ts" && /^(?:STORAGE_KEYS\.(?:PINNED_AGENT_IDS|ACTIVE_CONVERSATION_ID|ACTIVE_VIEW|SIDEBAR_WIDTH|SIDEBAR_COLLAPSED))$/u.test(write.key),
  (write) => /src\/lib\/(?:safe-storage|utils)\.ts$/u.test(write.file) && write.key === "key",
  (write) => write.file === "src/features/general-script/submission-storage.ts"
    && (write.key === "key" || write.key.includes("encodeURIComponent(identity.requestId)"))
    && write.value === "value",
];

const allowedSessionWrites: Array<(write: StorageWrite) => boolean> = [
  (write) => write.file === "src/hooks/use-persisted-state.ts" && write.key.includes("app_state_${key}"),
  (write) => write.file === "src/components/image-workbench.tsx" && write.key === "jobsStorageKey" && write.value.includes("unresolvedReferences"),
  (write) => write.file === "src/features/official-core-routes/official-agent-route.tsx" && write.key === "MODEL_STORAGE_KEY" && /^(?:modelId|selectedModelId)$/u.test(write.value),
  (write) => /src\/lib\/(?:video-task-transfer|video-workflow-draft|image-workbench-transfer|youcai-agent-routing|youcai-agent-prefill|agent-workbench-handoff)\.ts$/u.test(write.file),
];

const unexpectedWrites = writes.filter((write) => {
  if (write.storage === "local" || write.storage === "safe") return !allowedLocalWrites.some((allow) => allow(write));
  return !allowedSessionWrites.some((allow) => allow(write));
});
assert.deepEqual(unexpectedWrites, [], `unexpected browser storage writes:\n${JSON.stringify(unexpectedWrites, null, 2)}`);

const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");
const assertTwoMinuteOnceHandoff = (relativePath: string, ttlToken: string) => {
  const code = source(relativePath);
  assert.match(code, new RegExp(`${ttlToken}\\s*=\\s*2\\s*\\*\\s*60\\s*\\*\\s*(?:1_?000|1000)`, "u"), `${relativePath} must use a two-minute TTL`);
  assert.match(code, /removeItem\(/u, `${relativePath} must consume or clear the handoff`);
  assert.doesNotMatch(code, /localStorage\.setItem/u, `${relativePath} must not persist creative content in localStorage`);
};

assertTwoMinuteOnceHandoff("src/lib/video-task-transfer.ts", "VIDEO_TASK_DRAFT_TTL_MS");
assertTwoMinuteOnceHandoff("src/lib/video-workflow-draft.ts", "VIDEO_WORKFLOW_DRAFT_TTL_MS");
assertTwoMinuteOnceHandoff("src/lib/image-workbench-transfer.ts", "IMAGE_WORKBENCH_TRANSFER_TTL_MS");
assertTwoMinuteOnceHandoff("src/lib/youcai-agent-routing.ts", "YOUCAI_PREFILL_TTL_MS");
assertTwoMinuteOnceHandoff("src/lib/youcai-agent-prefill.ts", "YOUCAI_AGENT_PREFILL_TTL_MS");
assertTwoMinuteOnceHandoff("src/lib/agent-workbench-handoff.ts", "AGENT_WORKBENCH_HANDOFF_TTL_MS");
assertTwoMinuteOnceHandoff("src/lib/extract-segment-handoff.ts", "SEGMENTER_HANDOFF_TTL_MS");

const structuredOutput = source("src/lib/structured-agent-output.ts");
assert.doesNotMatch(structuredOutput, /sessionStorage\.setItem\([\s\S]{0,160}STRUCTURED_AGENT_OUTPUT_STORAGE_KEY/u, "terminal structured agent output must remain in memory/event delivery only");
assert.doesNotMatch(structuredOutput, /STRUCTURED_AGENT_OUTPUT_STORAGE_KEY/u, "retired terminal output key must not remain reusable");

const youcaiPrefill = source("src/lib/youcai-agent-prefill.ts");
assert.match(youcaiPrefill, /const raw = window\.sessionStorage\.getItem\(candidate\.key\);\s*window\.sessionStorage\.removeItem\(candidate\.key\);/u, "agent prefill must delete before parsing");
assert.match(youcaiPrefill, /clearPriorGuestPrefill\(window\.sessionStorage\)/u, "a new prefill must delete an older guest prompt");
for (const producer of [
  "src/features/official-home/official-home-page.tsx",
  "src/features/official-inspiration/official-inspiration-gallery.tsx",
  "src/features/official-tool-directory/official-creation-center.tsx",
]) {
  const producerSource = source(producer);
  assert.match(producerSource, /storeYoucaiAgentPrefill/u, `${producer} must use the scoped handoff helper`);
  assert.doesNotMatch(producerSource, /sessionStorage\.setItem/u, `${producer} must not write a raw prompt`);
}

const conversationCache = source("src/lib/conversation-cache.ts");
assert.match(conversationCache, /isBrowserConversationCacheEnabled\(\): false \{\s*return false;/u, "browser conversation cache must remain permanently retired");
assert.doesNotMatch(conversationCache, /localStorage\.setItem|NEXT_PUBLIC_ENABLE_BROWSER_CONVERSATION_CACHE/u, "no environment switch may restore browser message caching");
assert.match(conversationCache, /loadConversationsFromCache[\s\S]*?clearConversationCache\(\);\s*return null;/u, "legacy reads must delete old cache and return no browser history");
const appContext = source("src/contexts/app-context.tsx");
assert.match(appContext, /useEffect\(\(\) => \{\s*clearConversationCache\(\);\s*\}, \[\]\);/u, "client boot must clear retired conversation cache bytes");
assert.doesNotMatch(appContext, /saveConversationsToCache|loadConversationsFromCache|mergeCacheWithServer|convCacheTimerRef/u, "app context must use server conversation history only");

const globalTask = source("src/components/vs/GlobalTaskBar.tsx");
assert.doesNotMatch(globalTask, /localStorage\.setItem\([\s\S]{0,120}JSON\.stringify\(task\)/u, "voice task text/speaker must not enter localStorage");
assert.match(globalTask, /JSON\.stringify\(pointer\)/u);
assert.ok(globalTask.includes("task.page.split(/[?#]/u)[0]"), "voice pointer source page must strip query and hash content");
const pointerType = globalTask.slice(globalTask.indexOf("type RunningTaskPointer"), globalTask.indexOf("let activeTaskInMemory"));
assert.doesNotMatch(pointerType, /\b(?:text|speaker|result|url)\b/iu, "voice pointer type must contain opaque task metadata only");

const imageAttempt = source("src/lib/image-workbench-attempt-guard.ts");
const imagePointerType = imageAttempt.slice(imageAttempt.indexOf("export type BrowserImageAttemptReference"), imageAttempt.indexOf("const OPAQUE_ID"));
assert.doesNotMatch(imagePointerType, /\b(?:prompt|url|blob|result|history)\b/iu, "image pending pointer must contain opaque IDs only");
assert.match(imageAttempt, /expiresAt/u);

const browserAttempt = source("src/lib/browser-client-attempt.ts");
const attemptType = browserAttempt.slice(browserAttempt.indexOf("type StoredClientAttempt"), browserAttempt.indexOf("export type BrowserClientAttempt"));
assert.doesNotMatch(attemptType, /\b(?:prompt|text|url|blob|result|history)\b/iu, "idempotency pointer must contain request ID/hash only");
assert.match(browserAttempt, /MAX_ATTEMPT_AGE_MS/u);

const humanState = source("src/features/digital-human/client-state.ts");
assert.match(humanState, /videoUrl:\s*undefined/u, "digital-human pending task pointer must strip result URL");
assert.match(humanState, /settled:\s*true/u, "digital-human terminal task must collapse to a settled marker");
assert.doesNotMatch(humanState.slice(humanState.indexOf("export type HumanJob"), humanState.indexOf("export const humanJobPending")), /\b(?:prompt|text|blob)\b/iu);

const imageWorkbench = source("src/components/image-workbench.tsx");
const persistedPreferenceCalls = [...imageWorkbench.matchAll(/usePersistedState(?:<[^>]+>)?\(([^,]+)/gu)].map((match) => match[1].trim());
assert.deepEqual(persistedPreferenceCalls, [
  "workbenchUserStorageKey(MODE_KEY",
  "workbenchUserStorageKey(VIDEO_PUSH_MODE_KEY",
  "workbenchUserStorageKey(RATIO_KEY",
  "workbenchUserStorageKey(MODEL_KEY",
  "workbenchUserStorageKey(RESOLUTION_KEY",
]);

console.log(JSON.stringify({
  ok: true,
  routeGroups: Object.keys(routeEntries),
  reachableSourceFiles: reachable.size,
  checkedDirectStorageWrites: writes.length,
  allowedLocalStorageClasses: ["auth", "user-favorites", "explicit-prompt-library", "ui-preferences", "opaque-pending-pointers", "revision-hints"],
  allowedSessionStorageClasses: ["two-minute-once-handoffs", "opaque-pending-pointers", "admin-model-preference", "ui-preferences"],
  commerceFilesRead: 0,
  networkRequests: 0,
  databaseWrites: 0,
  modelCalls: 0,
}, null, 2));
