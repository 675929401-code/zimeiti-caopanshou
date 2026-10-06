import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const url = process.env.COZE_SUPABASE_URL;
const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error("数据库配置缺失");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const agentId = "agent-1786633444187-594spj";
const marker = "最怕听到的一句话就是";
const outDir = path.resolve(".tmp-e2e", "high-energy-weight-corrected-segments-1-2-v352-prompt-regression-20260816");

const { data: conversations, error: conversationError } = await db
  .from("conversations")
  .select("id,updated_at")
  .eq("agent_id", agentId)
  .order("updated_at", { ascending: false })
  .limit(10);
if (conversationError) throw conversationError;

let recovered;
for (const conversation of conversations || []) {
  const { data: messages, error } = await db
    .from("conversation_messages")
    .select("role,content,created_at")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const user = messages?.find(message => message.role === "user" && String(message.content || "").includes(marker));
  const assistant = [...(messages || [])].reverse().find(message => message.role === "assistant" && String(message.content || "").includes("```text"));
  if (user && assistant) {
    recovered = { conversationId: conversation.id, updatedAt: conversation.updated_at, messages, raw: String(assistant.content) };
    break;
  }
}

if (!recovered) throw new Error("未找到最近的v3.5.2平台输出");
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "recovered-platform-history.json"), `${JSON.stringify(recovered, null, 2)}\n`, "utf8");
await writeFile(path.join(outDir, "recovered-platform-agent-raw-4-code-blocks.md"), recovered.raw, "utf8");

const forbidden = [...recovered.raw.matchAll(/体态测量环|健康宣传区|PET\s*HEALTH|健康站|检测舱|扫描舱|健康终端|概念展台|室内环境声/giu)].map(match => match[0]);
console.log(JSON.stringify({
  passed: true,
  conversationId: recovered.conversationId,
  updatedAt: recovered.updatedAt,
  codeBlocks: [...recovered.raw.matchAll(/```text/gu)].length,
  forbidden,
  rawPath: path.join(outDir, "recovered-platform-agent-raw-4-code-blocks.md"),
}, null, 2));
