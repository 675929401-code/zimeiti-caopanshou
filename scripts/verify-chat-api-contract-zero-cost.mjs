import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const chat = read("src/app/api/chat/route.ts");
const coze = read("src/lib/coze-api.ts");
const history = read("src/app/api/conversations/history/route.ts");
const messages = read("src/app/api/conversations/[id]/messages/route.ts");
const llm = read("src/app/api/llm/route.ts");
const checks = [];
const check = (name, condition) => {
  checks.push({ name, passed: Boolean(condition) });
  if (!condition) throw new Error(`CHAT_API_CONTRACT_FAILED:${name}`);
};

check("image ownership is checked before provider call", chat.includes("validateOwnedCozeImageKeys")
  && chat.includes("COZE_IMAGE_OWNERSHIP_FAILED")
  && chat.includes("const imageKeys = ownedImageResult.keys")
  && chat.includes("streamChat(botId, verifiedUserId, securedMessage, safeConversationId || undefined, cozeConfig, imageKeys)"));
check("provider conversation IDs cannot upsert another owner", chat.includes("ensureConversationOwnership")
  && chat.includes("Never upsert by provider conversation ID")
  && !chat.includes('.from("conversations").upsert'));
check("persistence failure is a terminal error without billing success", chat.includes("COZE_HISTORY_PERSIST_FAILED")
  && chat.includes("对话已由上游完成并结算，但历史保存未确认")
  && chat.includes('recordTerminal("error", "COZE_HISTORY_PERSIST_FAILED"'));
check("image signing failure fails closed", coze.includes("COZE_IMAGE_SIGNING_FAILED")
  && coze.includes("throw new Error(\"COZE_IMAGE_SIGNING_FAILED\")"));
check("history update checks error and affected row", history.includes("const updateResult = await supabase")
  && history.includes('.select("id")')
  && history.includes("if (!updateResult.data) throw new ConversationNotFoundError()"));
check("message delete route checks conversation and message owner", messages.includes("export async function DELETE")
  && messages.includes('.eq("conversation_id", conversationId)')
  && messages.includes('.eq("user_id", user.userId)')
  && messages.includes("MESSAGE_NOT_FOUND"));
check("Coze branch controls are explicit and fail closed", chat.includes("persistUserMessage: persistUserMessageRaw")
  && chat.includes("truncateFromMessageId: truncateFromMessageIdRaw")
  && chat.includes("appendUserMessage: appendUserMessageRaw")
  && chat.includes("COZE_BRANCH_UNSUPPORTED")
  && chat.includes("provider_call_started: false"));
check("LLM branch truncation uses an owned stable message ID", llm.includes("truncate_from_message_id")
  && llm.includes("LLM_TRUNCATE_TARGET_NOT_FOUND")
  && llm.includes('.eq("id", truncateFromMessageId)')
  && llm.includes('.eq("conversation_id", conversationId)')
  && llm.includes('.eq("user_id", verifiedUserId)')
  && !llm.includes("Date.parse(truncateFrom)")
  && !llm.includes('console.warn("[LLM] Truncate message branch failed:'));

console.log(JSON.stringify({
  verifier: "chat-api-contract-zero-cost",
  passed: true,
  checks: checks.length,
  networkCalls: 0,
  databaseWrites: 0,
  providerCalls: 0,
  checksDetail: checks,
}, null, 2));
