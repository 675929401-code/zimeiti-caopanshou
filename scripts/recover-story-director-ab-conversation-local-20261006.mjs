import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const prefix = String(process.argv.find((value) => value.startsWith("--prefix=")) || "").slice("--prefix=".length);
const output = path.resolve(String(process.argv.find((value) => value.startsWith("--output=")) || "").slice("--output=".length));
assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
assert.ok(/^conv_ab_[a-z0-9_-]+$/iu.test(prefix), "SAFE_CONVERSATION_PREFIX_REQUIRED");
assert.ok(output.startsWith(`${path.resolve(".codex-evidence")}${path.sep}`), "EVIDENCE_OUTPUT_REQUIRED");

const headers = { Authorization: `Bearer ${token}` };
async function requestJson(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${pathname} returned ${response.status}`);
  return body;
}

const index = await requestJson("/api/conversations/history");
const matches = (index.conversations || [])
  .filter((conversation) => String(conversation.id || "").startsWith(prefix))
  .sort((left, right) => Date.parse(String(right.updated_at || 0)) - Date.parse(String(left.updated_at || 0)));
assert.equal(matches.length, 1, `EXPECTED_ONE_MATCH_FOUND_${matches.length}`);
const conversationId = String(matches[0].id);
const detail = await requestJson(`/api/conversations/history?id=${encodeURIComponent(conversationId)}`);
const messages = detail.conversation?.messages || [];
const user = messages.find((message) => message.role === "user");
const assistant = [...messages].reverse().find((message) => message.role === "assistant");
assert.ok(typeof user?.content === "string" && user.content.length > 100, "RECOVERED_USER_MESSAGE_REQUIRED");
assert.ok(typeof assistant?.content === "string" && assistant.content.length > 100, "RECOVERED_ASSISTANT_MESSAGE_REQUIRED");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const evidence = {
  schema: "story_director_ab_conversation_recovery.v1",
  recoveredAt: new Date().toISOString(),
  readOnly: true,
  providerRequests: 0,
  conversationId,
  messageCount: messages.length,
  user: { characters: user.content.length, sha256: sha256(user.content) },
  assistant: { characters: assistant.content.length, sha256: sha256(assistant.content) },
};
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "recovery.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
await fs.writeFile(path.join(output, "user-input.txt"), `${user.content}\n`, { flag: "wx" });
await fs.writeFile(path.join(output, "claude-opus-55-output.md"), `${assistant.content}\n`, { flag: "wx" });
console.log(JSON.stringify({ ...evidence, output }, null, 2));
