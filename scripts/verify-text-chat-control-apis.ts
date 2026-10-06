import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TextChatAuthorizationMutationSchema,
  TextChatMemoryMutationSchema,
  getWeixinBindingAvailability,
} from "../src/lib/text-chat-controls";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const memoryRoute = read("src/app/api/text-chat/memories/route.ts");
const conversationRoute = read("src/app/api/text-chat/conversations/[id]/route.ts");
const weixinRoute = read("src/app/api/text-chat/weixin-binding/route.ts");
const weixinStatusRoute = read("src/app/api/text-chat/weixin-binding/status/route.ts");
const migration = read("supabase/migrations/20260825062000_text_chat_controls.sql");

assert.equal(TextChatAuthorizationMutationSchema.safeParse({ paidToolAuthorizationEnabled: true }).success, true);
assert.equal(TextChatAuthorizationMutationSchema.safeParse({ paidToolAuthorizationEnabled: "true" }).success, false);
assert.equal(TextChatMemoryMutationSchema.safeParse({ id: "not-a-uuid", content: "x" }).success, false);
assert.equal(TextChatMemoryMutationSchema.safeParse({ id: "00000000-0000-4000-8000-000000000001", content: "有效记忆" }).success, true);

for (const [name, source] of Object.entries({ memoryRoute, conversationRoute })) {
  assert.match(source, /authorizeTextChatControlRequest/u, `${name} must require current-user auth`);
  assert.doesNotMatch(source, /\/api\/llm|generate|billing|credits_charged/iu, `${name} must remain zero-cost`);
}
assert.match(memoryRoute, /\.eq\("user_id", userId\)/u, "memory mutations must scope by user_id");
assert.match(conversationRoute, /user_id: userId/u, "settings upsert must include authenticated user_id");
assert.match(conversationRoute, /requireOwnedTextChatConversation/u);
assert.match(conversationRoute, /paidToolAuthorizationEnabled/u);
assert.match(memoryRoute, /export async function PATCH/u);
assert.match(memoryRoute, /export async function DELETE/u);
assert.doesNotMatch(memoryRoute, /export async function POST/u, "public memory contract does not invent manual creation");

assert.match(weixinRoute, /binding: \{ connected: false \}/u);
assert.match(weixinRoute, /weixinBindingDisabledResponse/u);
assert.match(weixinStatusRoute, /status: "disabled"/u);
assert.equal(getWeixinBindingAvailability().enabled, false);

for (const table of ["text_chat_conversation_settings", "text_chat_memories"]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
  assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, "u"));
  assert.match(migration, new RegExp(`REVOKE ALL ON TABLE ${table} FROM anon, authenticated`, "u"));
}
assert.match(migration, /UNIQUE\(user_id, conversation_id\)/u);
assert.equal((migration.match(/user_id uuid NOT NULL/g) || []).length, 2, "control ownership type must match conversations.user_id uuid");
assert.doesNotMatch(migration, /user_id varchar/u, "do not recreate the legacy users.id varchar mismatch");

console.log(JSON.stringify({
  success: true,
  zeroCost: true,
  modelRequests: 0,
  mediaRequests: 0,
  weixinBinding: "disabled-fail-closed",
  authorization: "owned-conversation-only",
  memories: "current-user-only",
  migration: "20260825062000",
}, null, 2));
