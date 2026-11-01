import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const MOVIE_AGENT_ID = "agent-1786633444187-594spj";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function countRows(query, label) {
  const { count, error } = await query;
  assert.ifError(error);
  assert.ok(Number.isSafeInteger(count), `${label}计数不可用`);
  return count;
}

async function snapshot(db, userId, clientRequestId, recordId) {
  const [{ data: user, error: userError }, attempts, events, operations, ledger, revenue, creditTransactions] = await Promise.all([
    db.from("users").select("id,credits,cash_balance").eq("id", userId).single(),
    countRows(db.from("llm_request_attempts").select("record_id", { count: "exact", head: true }).eq("client_request_id", clientRequestId), "LLM请求"),
    countRows(db.from("llm_request_attempt_events").select("id", { count: "exact", head: true }).eq("record_id", recordId), "LLM事件"),
    countRows(db.from("wallet_operations").select("id", { count: "exact", head: true }).like("idempotency_key", `llm:${clientRequestId}:%`), "钱包操作"),
    countRows(db.from("wallet_ledger_entries").select("id", { count: "exact", head: true }).like("idempotency_key", `llm:${clientRequestId}:%`), "钱包流水"),
    countRows(db.from("revenue_records").select("id", { count: "exact", head: true }).like("task_id", `llm:${clientRequestId}:%`), "收益流水"),
    countRows(db.from("credit_transactions").select("id", { count: "exact", head: true }).eq("user_id", userId), "用户积分流水"),
  ]);
  assert.ifError(userError);
  assert.ok(user, "验收账号不存在");
  return {
    credits: Number(user.credits),
    cashBalance: Number(user.cash_balance),
    attempts,
    events,
    operations,
    ledger,
    revenue,
    creditTransactions,
  };
}

export async function main() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
  assert.equal(origin, "http://127.0.0.1:5000", "只允许验收当前5000本地实例");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
  assert.ok(token, "缺少内存管理员会话");
  const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
  const userId = String(identity?.user?.id || "");
  assert.ok(userId, "缺少验收账号ID");
  const supabaseUrl = String(process.env.COZE_SUPABASE_URL || "");
  const serviceRoleKey = String(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || "");
  assert.equal(new URL(supabaseUrl).origin, "http://127.0.0.1:54321", "必须使用本地验收数据库");
  assert.ok(serviceRoleKey, "本地service role不可用");
  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(versionResponse.status, 200, "当前5000实例版本接口不可用");
  const runtimeVersion = await versionResponse.json();
  assert.ok(runtimeVersion?.sourceVersion && runtimeVersion?.buildId, "当前5000实例缺少运行身份");

  const clientRequestId = `story-gate-live-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const recordId = sha256(`${userId}\u0000${clientRequestId}`);
  const narration = "狗".repeat(61);
  const input = [
    "segmented_script：",
    `1.【${narration}】`,
    "target_duration_seconds：10",
  ].join("\n");
  const before = await snapshot(db, userId, clientRequestId, recordId);
  assert.deepEqual(
    { attempts: before.attempts, events: before.events, operations: before.operations, ledger: before.ledger, revenue: before.revenue },
    { attempts: 0, events: 0, operations: 0, ledger: 0, revenue: 0 },
    "验收请求ID不是全新状态",
  );

  const response = await fetch(`${origin}/api/llm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": clientRequestId,
    },
    body: JSON.stringify({
      client_request_id: clientRequestId,
      agentId: MOVIE_AGENT_ID,
      agentName: "3D故事导演｜电影叙事",
      messages: [{ role: "user", content: input }],
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  const content = String(payload?.choices?.[0]?.message?.content || "");
  assert.equal(response.status, 200, `真实门禁HTTP异常:${response.status}`);
  assert.equal(response.headers.get("x-llm-guarded"), "true", "真实路由没有返回服务端门禁标记");
  assert.equal(payload?.usage?.total_tokens, 0, "门禁响应不应产生Token用量");
  assert.equal(content.split(/\r?\n/u)[0], "生成门禁：口播超时，请保持原文逐字不变后重新分段，不得删字、改写或截断");
  assert.match(content, /第1段：61个有效字 \/ 上限60字 \/ 请返回效率工具选择10秒，保持原文逐字不变，重新分段至每段不超过60个有效字/u);
  assert.doesNotMatch(content, /压缩|```|故事板|生图\s*Prompt|视频\s*Prompt|导演草案/iu);

  const after = await snapshot(db, userId, clientRequestId, recordId);
  assert.deepEqual(after, before, "真实门禁请求改变了余额或任何相关账本");
  const report = {
    schemaVersion: 1,
    task: "STORY-DIRECTOR-PROMPT-ACTIVATION-R562",
    generatedAt: new Date().toISOString(),
    origin,
    sourceVersion: runtimeVersion.sourceVersion,
    buildId: runtimeVersion.buildId,
    agentId: MOVIE_AGENT_ID,
    requestIdSha256: sha256(clientRequestId),
    status: response.status,
    guardedHeader: response.headers.get("x-llm-guarded"),
    responseFirstLine: content.split(/\r?\n/u)[0],
    overtimeSegments: 1,
    effectiveCharacters: 61,
    limit: 60,
    tokenUsage: payload.usage,
    providerRequests: 0,
    requestAttemptWrites: after.attempts,
    walletOperationWrites: after.operations,
    walletLedgerWrites: after.ledger,
    revenueWrites: after.revenue,
    balanceUnchanged: before.credits === after.credits && before.cashBalance === after.cashBalance,
    creditTransactionCountUnchanged: before.creditTransactions === after.creditTransactions,
    passed: true,
  };
  const evidenceDir = path.resolve(".codex-evidence/story-director-prompt-quality-20260929/live-route");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}
