#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv.find((arg) => arg.startsWith("--root="))?.slice("--root=".length) || process.cwd());

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function includesAll(values, required) {
  const set = new Set(Array.isArray(values) ? values : []);
  return required.every((value) => set.has(value));
}

function textIncludesAll(text, required) {
  return required.every((value) => text.includes(value));
}

function reducerCaseBody(source, actionType) {
  const marker = `case "${actionType}"`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const remainder = source.slice(start + marker.length);
  const nextCase = remainder.search(/\n\s{4}(?:case "[^"]+"|default):/u);
  return nextCase === -1 ? source.slice(start) : source.slice(start, start + marker.length + nextCase);
}

function occurrenceCount(text, value) {
  if (!value) return 0;
  return text.split(value).length - 1;
}

function collectFiles(directory, extensions) {
  const base = path.join(root, directory);
  if (!fs.existsSync(base)) return [];
  const output = [];
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (extensions.includes(path.extname(entry.name))) {
        output.push(absolute);
      }
    }
  }
  return output;
}

const checks = [];

function addCheck(name, passed, detail, options = {}) {
  checks.push({
    name,
    passed: Boolean(passed),
    severity: passed ? "pass" : options.warning ? "warning" : "blocker",
    detail,
  });
}

let policy = null;
let packageJson = null;
let fixedDoc = "";

try {
  policy = readJson("deploy/policies/release-policy.json");
  packageJson = readJson("package.json");
  fixedDoc = readText("docs/部署闭环固定口径-2026-08-31.md");
} catch (error) {
  console.error(JSON.stringify({
    verifier: "deploy-standard",
    status: "ERROR",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(2);
}

addCheck(
  "fixed-standard-document",
  textIncludesAll(fixedDoc, [
    "代码局部更新，线上整版发布",
    "会员数据、钱包数据、用户上传素材、生成历史、服务器密钥永远不随代码覆盖",
    "直接覆盖应用程序版本，不覆盖持久化数据",
    "text/event-stream",
    "PROTECTED_ENV_FILE",
    "COS/OSS/S3 + CDN",
  ]),
  "部署闭环固定口径已声明局部修改、整版发布、数据素材不覆盖和流式门禁。",
);

addCheck(
  "source-repository-boundary",
  policy?.source?.topLevelFiles?.includes(".env.example")
    && includesAll(policy?.source?.excludeDirectoryNames, [".git", ".next", "node_modules", "logs", "tmp"])
    && includesAll(policy?.runtime?.secretPaths, [".env.local", ".env.production", ".npmrc"]),
  "源码仓只允许无密模板进入；构建产物、运行缓存和真实密钥必须排除。",
);

addCheck(
  "runtime-data-boundary",
  includesAll(policy?.runtime?.requiredServerMounts, [
    "shared/data",
    "shared/runtime",
    "shared/uploads",
    "shared/assets/releases",
    "shared/assets/current",
    "shared/logs",
    "shared/backups",
  ])
    && includesAll(policy?.runtime?.mutablePaths, ["data", "public/uploads", "backups"])
    && policy?.database?.applicationManagedMigrationsAllowed === false
    && policy?.database?.preMigrationBackupRequired === true,
  "会员、积分、生成历史、用户素材和运行态目录保持在 release 外部，数据库迁移必须独立备份后执行。",
);

addCheck(
  "public-asset-boundary",
  policy?.assets?.releaseDirectory === "shared/assets/releases"
    && policy?.assets?.currentPointer === "shared/assets/current"
    && includesAll(policy?.assets?.externalRoots, [
      "public/product-assets",
      "public/youcai-media",
      "public/short-drama",
      "public/avatars",
      "public/model-brands",
    ])
    && includesAll(policy?.assets?.requiredPaths, [
      "public/avatars/cute-semantic/agent-cute-01.webp",
      "public/short-drama/inspiration-media/v1/official-film-showcase-v1.mp4",
      "public/product-assets/youcai-demo-v1/clean-v21/graph.json",
    ]),
  "官方演示素材由 manifest 和 release 管理；用户上传/生成素材不进入源码覆盖范围。",
);

addCheck(
  "git-release-policy",
  policy?.git?.primaryBranch === "main"
    && policy?.git?.workBranchPrefix === "codex/"
    && policy?.git?.forcePushAllowed === false
    && policy?.release?.immutable === true
    && policy?.release?.atomicSwitch === true
    && Array.isArray(policy?.release?.modes)
    && policy.release.modes.includes("DOCS")
    && policy.release.modes.includes("WEB")
    && policy.release.modes.includes("FULL"),
  "Git 以精确 commit 为发布证据；禁止 force-push，服务器运行不可变 release。",
);

const scripts = packageJson.scripts || {};
addCheck(
  "operator-scripts",
  [
    "deploy:standard:verify",
    "deploy:ready",
    "deploy:close-loop",
    "deploy:env:verify",
    "release:vnext:verify",
    "verify:youcai-navigation-live",
  ].every((name) => typeof scripts[name] === "string")
    && exists("scripts/verify-release-workflow.mjs")
    && exists("scripts/verify-deployment-readiness.mjs")
    && exists("scripts/verify-llm-streaming-ui-e2e.ts"),
  "部署、发布、导航和 LLM 流式验收入口存在，可执行闭环检查。",
);

const runtimeEnv = exists("src/lib/server-runtime-env.ts") ? readText("src/lib/server-runtime-env.ts") : "";
addCheck(
  "protected-runtime-env-loader",
  textIncludesAll(runtimeEnv, [
    "PROTECTED_ENV_FILE",
    "SERVER_ENV_FILE",
    "dotenv.config",
    "override: false",
  ]),
  "服务器私有配置由 Node/dotenv 加载，避免 shell source .env.local 引发转义、注入或启动失败。",
);

const appContext = exists("src/contexts/app-context.tsx") ? readText("src/contexts/app-context.tsx") : "";
const chatReducer = exists("src/contexts/chat-reducer.ts") ? readText("src/contexts/chat-reducer.ts") : "";
const conversationCache = exists("src/lib/conversation-cache.ts") ? readText("src/lib/conversation-cache.ts") : "";
const homePage = exists("src/app/page.tsx") ? readText("src/app/page.tsx") : "";

const startConversationCase = reducerCaseBody(chatReducer, "START_CONVERSATION");
const markDirtyCase = reducerCaseBody(chatReducer, "MARK_CONVERSATION_DIRTY");
const markCleanCase = reducerCaseBody(chatReducer, "MARK_CLEAN");
const reducerConversationLifecycleGuard = textIncludesAll(startConversationCase, [
  "const nextConversation = action.payload",
  "conversation.id !== nextConversation.id",
  "activeConversationId: nextConversation.id",
  "view: \"chat\"",
])
  && textIncludesAll(markDirtyCase, [
    "c.id === action.payload",
    "{ ...c, dirty: true }",
  ])
  && textIncludesAll(markCleanCase, [
    "c.updatedAt === action.payload.updatedAt",
    "(c.title || \"\") === action.payload.title",
    "c.agentId === action.payload.agentId",
    "(c.source || \"llm\") === action.payload.source",
    "{ ...c, dirty: false }",
  ]);

const pendingLocalConversationGuard = textIncludesAll(appContext, [
  "const pendingLocalConversationsRef = useRef<Map<string, Conversation>>(new Map())",
  "pendingLocalConversationsRef.current.set(conversation.id, conversation)",
  "pendingLocalConversationsRef.current.delete(conversationId)",
  "const pendingLocalConvMap = new Map<string, Conversation>()",
  "for (const conversation of pendingLocalConversationsRef.current.values())",
  "isLocalConvId(conversation.id)",
  "conversation.dirty === true",
  "const pendingLocalConvs = [...pendingLocalConvMap.values()]",
  "const hydratedConvs = [...pendingLocalConvs, ...backfilledConvs]",
])
  && occurrenceCount(appContext, "rememberPendingLocalConversation(conversation);") >= 2;

const retiredConversationCacheGuard = textIncludesAll(conversationCache, [
  "Retired browser conversation cache.",
  "isBrowserConversationCacheEnabled(): false",
  "localStorage.removeItem(getCacheKey())",
  "saveConversationsToCache",
  "loadConversationsFromCache",
  "mergeCacheWithServer",
  "return [...server]",
  "getCachedConversation",
])
  && occurrenceCount(conversationCache, "return null;") >= 2
  && !conversationCache.includes("localStorage.setItem")
  && !conversationCache.includes("localStorage.getItem")
  && !conversationCache.includes("JSON.stringify")
  && !conversationCache.includes("JSON.parse")
  && textIncludesAll(appContext, [
    "Server is the single source of truth. No merge logic.",
    "clearConversationCache();",
    "fetch(\"/api/conversations/history\"",
  ]);

const chatViewLoadGuard = homePage.includes("import { ChatView } from \"@/components/chat-view\";")
  || (
    homePage.includes('dynamic(() => import("@/components/chat-view")')
    && homePage.includes("mod.ChatView")
  );

const chatGuardContracts = [
  ["reducer 会话生命周期", reducerConversationLifecycleGuard],
  ["未落库新会话保护", pendingLocalConversationGuard],
  ["服务端历史单一真源与旧缓存退役", retiredConversationCacheGuard],
  ["ChatView 加载入口", chatViewLoadGuard],
];
const missingChatGuardContracts = chatGuardContracts
  .filter(([, passed]) => !passed)
  .map(([label]) => label);
addCheck(
  "chat-streaming-ui-guard",
  missingChatGuardContracts.length === 0,
  missingChatGuardContracts.length === 0
    ? "新建对话、未落库会话合并、服务端历史单一真源、旧浏览器消息缓存退役和 ChatView 加载入口均受发布门禁保护。"
    : `聊天发布契约缺失：${missingChatGuardContracts.join("、")}。`,
);

const deployScriptFiles = collectFiles("scripts", [".sh", ".mjs", ".js", ".cjs"]);
const unsafeEnvSourceFiles = deployScriptFiles
  .filter((file) => /(?:^|\n)\s*(?:source|\.)\s+\.env\.local\b/u.test(fs.readFileSync(file, "utf8")))
  .map((file) => path.relative(root, file).replace(/\\/gu, "/"));
addCheck(
  "no-shell-source-env-local",
  unsafeEnvSourceFiles.length === 0,
  unsafeEnvSourceFiles.length === 0
    ? "部署脚本未发现直接 source .env.local。"
    : `发现不安全 env 加载脚本：${unsafeEnvSourceFiles.join(", ")}`,
);

const blockers = checks.filter((check) => check.severity === "blocker");
const warnings = checks.filter((check) => check.severity === "warning");
const result = {
  verifier: "deploy-standard",
  status: blockers.length === 0 ? "PASS" : "NO_GO",
  generatedAt: new Date().toISOString(),
  root,
  summary: {
    total: checks.length,
    passed: checks.filter((check) => check.severity === "pass").length,
    blockers: blockers.length,
    warnings: warnings.length,
  },
  checks,
};

console.log(JSON.stringify(result, null, 2));
process.exit(blockers.length === 0 ? 0 : 1);
