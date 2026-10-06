/**
 * 支付待办发现定时任务（只读）。
 *
 * 该任务不持有管理员 step-up 凭据，不调用支付渠道，也不补账。它只读取
 * 近 7 天待核对订单并写入本地运维日志；真正的 Xunhu 补账只能由管理员
 * 在当前 step-up 会话中手工触发。EPay 明确为 callback-only。
 */
const fs = require("node:fs");
const path = require("node:path");

const AUTH_FILE = process.env.PAYMENT_RECONCILE_AUTH_FILE
  || "F:/总项目文件/Skill存储系统/运行数据/credentials/reconcile-auth.json";
const ORIGIN = (process.env.PAYMENT_RECONCILE_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const LOG = process.env.PAYMENT_RECONCILE_LOG
  || "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/运行日志/支付对账/支付待办发现.log";
const MAX_RESPONSE_BYTES = 128 * 1024;

async function readBoundedJson(response) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) {
    throw new Error("响应体积无效");
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("响应体积超过上限");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    throw new Error("响应不是有效 JSON");
  }
}

function timestamp() {
  return new Date().toLocaleString("sv-SE").replace("T", " ");
}

function appendLog(line) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${line}\n`, { encoding: "utf8" });
}

async function getAdminToken(credential) {
  if (typeof credential.token === "string" && credential.token.trim()) {
    return credential.token.trim();
  }
  const login = await fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: credential.username, password: credential.password }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readBoundedJson(login);
  if (!login.ok || !body.token || body.role !== "admin") {
    throw new Error("管理员只读登录失败");
  }
  return body.token;
}

(async () => {
  try {
    const credential = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    const token = await getAdminToken(credential);
    const response = await fetch(`${ORIGIN}/api/admin/payment-reconcile`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const summary = await readBoundedJson(response);
    if (!response.ok) throw new Error(`只读发现失败 HTTP ${response.status}`);
    if (summary.mode !== "read_only_discovery"
      || summary.writePerformed !== false
      || summary.providerCalls !== 0) {
      throw new Error("对账接口未证明只读，已停止任务");
    }

    const xunhu = Number(summary.xunhupay?.candidateCount || 0);
    const epay = Number(summary.epay?.candidateCount || 0);
    const line = `[${timestamp()}] 支付待办发现: HTTP ${response.status} Xunhu待人工step-up核对${xunhu} EPay仅回调待核查${epay} provider调用0 业务写入0`;
    console.log(line);
    appendLog(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = `[${timestamp()}] 支付待办发现失败: ${message.slice(0, 240)}`;
    console.error(line);
    try { appendLog(line); } catch {}
    process.exitCode = 1;
  }
})();
