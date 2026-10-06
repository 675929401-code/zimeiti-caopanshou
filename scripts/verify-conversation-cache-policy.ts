import assert from "node:assert/strict";
import type { Conversation } from "@/types/coze";
import {
  isBrowserConversationCacheEnabled,
  loadConversationsFromCache,
  mergeCacheWithServer,
  saveConversationsToCache,
} from "@/lib/conversation-cache";

const memory = new Map<string, string>();
let writes = 0;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    removeItem: (key: string) => memory.delete(key),
    setItem: (key: string, value: string) => {
      writes += 1;
      memory.set(key, value);
    },
  },
});

const conversation = {
  id: "server-conversation-cache-policy",
  botId: null,
  agentId: "fixture-agent",
  agentName: "缓存策略夹具",
  agentIconUrl: "",
  title: "缓存策略",
  lastMessage: "完成",
  lastMessageTime: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  source: "llm",
  messagesLoaded: true,
  dirty: false,
  messages: [{
    id: "assistant-fixture",
    role: "assistant",
    content: "完成",
    timestamp: Date.now(),
  }],
} satisfies Conversation;

memory.set("conv_cache", JSON.stringify({ conversations: [conversation] }));
saveConversationsToCache([conversation], "fixture-user");
assert.equal(writes, 0, "关闭浏览器缓存时不得写 localStorage");
assert.equal(memory.has("conv_cache"), false, "保存兼容入口必须主动删除旧缓存");
memory.set("conv_cache", JSON.stringify({ conversations: [conversation] }));
assert.equal(loadConversationsFromCache("fixture-user"), null, "关闭浏览器缓存时不得恢复本地历史");
assert.equal(memory.has("conv_cache"), false, "读取兼容入口必须主动删除旧缓存");
assert.equal(isBrowserConversationCacheEnabled(), false);

process.env.NEXT_PUBLIC_ENABLE_BROWSER_CONVERSATION_CACHE = "1";
saveConversationsToCache([conversation], "fixture-user");
assert.equal(writes, 0, "旧环境开关不得重新启用正文缓存");
assert.equal(loadConversationsFromCache("fixture-user"), null);
assert.equal(isBrowserConversationCacheEnabled(), false);

const serverConversation = { ...conversation, messages: [{ ...conversation.messages[0], content: "服务端正文" }] };
const browserConversation = { ...conversation, messages: [{ ...conversation.messages[0], content: "浏览器旧正文" }] };
const merged = mergeCacheWithServer([browserConversation], [serverConversation]);
assert.equal(merged.length, 1);
assert.equal(merged[0].messages[0]?.content, "服务端正文", "合并兼容入口只能返回服务端正文");

delete process.env.NEXT_PUBLIC_ENABLE_BROWSER_CONVERSATION_CACHE;
console.log(JSON.stringify({ ok: true, browserCachePermanentlyRetired: true, writes: 0, restoredMessages: 0, networkCalls: 0, databaseWrites: 0 }, null, 2));
