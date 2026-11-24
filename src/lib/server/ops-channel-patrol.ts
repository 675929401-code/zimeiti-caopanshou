import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { resolveProviderSecret } from "@/lib/provider-secret";

type Row = Record<string, unknown>;

export type PatrolAdapter = "openai-billing" | "secure-skill" | "custom";

export type PatrolModelSummary = { name: string; modelName: string; table: string };

export type PatrolChannelSummary = {
  host: string;
  origin: string;
  adapter: PatrolAdapter;
  modelCount: number;
  models: PatrolModelSummary[];
  balanceSupportedHint: boolean;
};

export type PatrolModelItem = {
  name: string;
  modelName: string;
  table: string;
  catalogVisible: boolean;
};

export type PatrolChannelResult = PatrolChannelSummary & {
  status: "ok" | "degraded" | "down" | "unknown";
  httpStatus: number | null;
  latencyMs: number | null;
  credentialReady: boolean;
  modelsVisible: number;
  modelsMissing: string[];
  modelItems: PatrolModelItem[];
  balanceUsd: number | null;
  usedUsd: number | null;
  balanceSupported: boolean;
  balanceState: "ok" | "unlimited" | "unsupported" | "missing-credential";
  error: string | null;
  checkedAt: string;
};

export type ModelFaultKind = "arrears" | "auth" | "api" | "timeout" | "catalog";

export type ModelFault = {
  model: string;
  host: string;
  kind: ModelFaultKind;
  detail: string;
  checkedAt: string;
};

export type PatrolSnapshot = {
  checkedAt: string;
  durationMs: number;
  channels: PatrolChannelResult[];
  faults?: ModelFault[];
};

const ARREARS_PATTERN = /insufficient|quota|balance|余额|欠费|额度不足|prepaid/iu;

/** Classify channel-level failures into per-model faults with a cause. */
export function computeModelFaults(channels: PatrolChannelResult[]): ModelFault[] {
  const faults: ModelFault[] = [];
  for (const channel of channels) {
    let kind: ModelFaultKind | null = null;
    let detail = "";
    if (channel.status === "down" || channel.status === "unknown") {
      if (channel.httpStatus === 401 || channel.httpStatus === 403) {
        kind = "auth";
        detail = `鉴权失败（HTTP ${channel.httpStatus}）`;
      } else if (channel.httpStatus === 402 || ARREARS_PATTERN.test(channel.error || "")) {
        kind = "arrears";
        detail = channel.error || "余额不足/欠费";
      } else if (channel.httpStatus === null) {
        kind = "timeout";
        detail = channel.error || "网络超时/不可达";
      } else if (channel.httpStatus >= 500 || channel.httpStatus === 404) {
        kind = "api";
        detail = channel.error || `上游接口异常（HTTP ${channel.httpStatus}）`;
      } else {
        kind = "api";
        detail = channel.error || `调用失败（HTTP ${channel.httpStatus}）`;
      }
    }
    if (!kind) continue;
    for (const item of channel.modelItems) {
      faults.push({ model: item.name, host: channel.host, kind, detail, checkedAt: channel.checkedAt });
    }
  }
  return faults;
}

type ModelCandidate = {
  table: "llm_models" | "video_models" | "cover_models";
  id: string;
  name: string;
  modelName: string;
  apiKey: string;
  endpoint: string;
};

const PROBE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60_000;

let snapshotCache: PatrolSnapshot | null = null;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function endpointOf(table: ModelCandidate["table"], row: Row): string {
  const endpoint = stringValue(row.api_endpoint);
  if (table === "llm_models") return stringValue(row.proxy_url) || endpoint;
  return endpoint;
}

function safeOrigin(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (!/^https?:$/u.test(url.protocol)) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function adapterFor(host: string): PatrolAdapter {
  if (host.includes("secure-skill")) return "secure-skill";
  return "openai-billing";
}

// Official first-party APIs (DeepSeek / Volcengine / DashScope / AutoDL ...) are
// deliberately excluded: they are stable direct connections, not relay stations.
// Only relay channels are part of operations patrol.
const OFFICIAL_DIRECT_HOST_SUFFIXES = [
  "deepseek.com",
  "volcengineapi.com",
  "volces.com",
  "aliyuncs.com",
  "autodl.art",
];

function isOfficialDirectHost(host: string): boolean {
  return OFFICIAL_DIRECT_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gu, "Bearer ***")
    .slice(0, 160);
}

async function readModels(): Promise<ModelCandidate[]> {
  const db = getSupabaseAdminClient();
  const [llm, video, cover] = await Promise.all([
    db.from("llm_models").select("id,name,model_name,api_endpoint,proxy_url,api_key,is_active,is_hidden").eq("is_active", true),
    db.from("video_models").select("id,name,model_name,api_endpoint,api_key,is_active,is_hidden").eq("is_active", true),
    db.from("cover_models").select("id,name,model_name,api_endpoint,api_key,is_active,is_hidden").eq("is_active", true),
  ]);
  const candidates: ModelCandidate[] = [];
  const collect = (table: ModelCandidate["table"], rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows as Row[]) {
      if (row.is_hidden === true) continue;
      const endpoint = endpointOf(table, row);
      if (!endpoint) continue;
      const origin = safeOrigin(endpoint);
      if (!origin) continue;
      const host = new URL(origin).host;
      if (host.endsWith(".invalid")) continue;
      if (isOfficialDirectHost(host)) continue;
      candidates.push({
        table,
        id: stringValue(row.id),
        name: stringValue(row.name),
        modelName: stringValue(row.model_name),
        apiKey: stringValue(row.api_key),
        endpoint,
      });
    }
  };
  collect("llm_models", llm.data);
  collect("video_models", video.data);
  collect("cover_models", cover.data);
  return candidates;
}

function groupChannels(models: ModelCandidate[]): Map<string, { origin: string; models: ModelCandidate[] }> {
  const groups = new Map<string, { origin: string; models: ModelCandidate[] }>();
  for (const model of models) {
    const origin = safeOrigin(model.endpoint);
    if (!origin) continue;
    const host = new URL(origin).host;
    const existing = groups.get(host);
    if (existing) {
      existing.models.push(model);
      if (origin.startsWith("https://") && !existing.origin.startsWith("https://")) existing.origin = origin;
    } else {
      groups.set(host, { origin, models: [model] });
    }
  }
  return groups;
}

function resolveChannelSecret(models: ModelCandidate[]): string | null {
  for (const model of models) {
    if (!model.apiKey) continue;
    try {
      const resolved = resolveProviderSecret(model.apiKey).trim();
      if (resolved) return resolved;
    } catch {
      // Try the next model; unresolved references are reported as missing credential.
    }
  }
  return null;
}

async function readJson(response: Response): Promise<Row | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null;
  } catch {
    return null;
  }
}

function dateStamp(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function probeBilling(origin: string, authorization: string): Promise<{
  supported: boolean;
  balanceState: "ok" | "unlimited" | "unsupported";
  balanceUsd: number | null;
  usedUsd: number | null;
  httpStatus: number | null;
}> {
  try {
    const subscription = await fetch(`${origin}/v1/dashboard/billing/subscription`, {
      headers: { Authorization: authorization },
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!subscription.ok) {
      return { supported: false, balanceState: "unsupported", balanceUsd: null, usedUsd: null, httpStatus: subscription.status };
    }
    const subscriptionBody = await readJson(subscription);
    const hardLimit = Number(subscriptionBody?.hard_limit_usd);
    if (!Number.isFinite(hardLimit)) {
      return { supported: false, balanceState: "unsupported", balanceUsd: null, usedUsd: null, httpStatus: subscription.status };
    }
    // New API style relays report 100000000 as "unlimited" instead of a real balance.
    if (hardLimit >= 10_000_000) {
      return { supported: false, balanceState: "unlimited", balanceUsd: null, usedUsd: null, httpStatus: subscription.status };
    }
    let usedUsd: number | null = null;
    try {
      const usage = await fetch(`${origin}/v1/dashboard/billing/usage?start_date=${dateStamp(90)}&end_date=${dateStamp(0)}`, {
        headers: { Authorization: authorization },
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (usage.ok) {
        const usageBody = await readJson(usage);
        const totalUsage = Number(usageBody?.total_usage);
        if (Number.isFinite(totalUsage)) usedUsd = totalUsage / 100;
      }
    } catch {
      // Usage is optional; balance still useful without it.
    }
    return { supported: true, balanceState: "ok", balanceUsd: hardLimit - (usedUsd ?? 0), usedUsd, httpStatus: subscription.status };
  } catch {
    return { supported: false, balanceState: "unsupported", balanceUsd: null, usedUsd: null, httpStatus: null };
  }
}

/** Optional New API user access token, one env var per host: OPS_RELAY_<HOST>_ACCESS_TOKEN. */
function balanceAccessToken(host: string): { token: string; userId: string } | null {
  const key = host.replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").toUpperCase();
  const token = String(process.env[`OPS_RELAY_${key}_ACCESS_TOKEN`] || "").trim();
  if (!token) return null;
  return { token, userId: String(process.env[`OPS_RELAY_${key}_USER_ID`] || "").trim() };
}

async function probeUserQuota(origin: string, accessToken: string, userId: string): Promise<{
  supported: boolean;
  balanceUsd: number | null;
  usedUsd: number | null;
}> {
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, "New-Api-User": userId || "1" };
    const response = await fetch(`${origin}/api/user/self`, { headers, cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { supported: false, balanceUsd: null, usedUsd: null };
    const body = await readJson(response);
    const data = body?.data && typeof body.data === "object" ? body.data as Row : null;
    const quota = Number(data?.quota);
    const usedQuota = Number(data?.used_quota);
    if (!Number.isFinite(quota)) return { supported: false, balanceUsd: null, usedUsd: null };
    return {
      supported: true,
      balanceUsd: quota / 500000,
      usedUsd: Number.isFinite(usedQuota) ? usedQuota / 500000 : null,
    };
  } catch {
    return { supported: false, balanceUsd: null, usedUsd: null };
  }
}

async function probeChannel(host: string, origin: string, models: ModelCandidate[]): Promise<PatrolChannelResult> {
  const adapter = adapterFor(host);
  const base: PatrolChannelSummary = {
    host,
    origin,
    adapter,
    modelCount: models.length,
    models: models.map((model) => ({ name: model.name, modelName: model.modelName, table: model.table })),
    balanceSupportedHint: adapter !== "secure-skill",
  };
  const checkedAt = new Date().toISOString();
  const secret = resolveChannelSecret(models);
  if (!secret) {
    return {
      ...base,
      status: "unknown",
      httpStatus: null,
      latencyMs: null,
      credentialReady: false,
      modelsVisible: 0,
      modelsMissing: [],
      modelItems: [],
      balanceUsd: null,
      usedUsd: null,
      balanceSupported: false,
      balanceState: "missing-credential",
      error: "缺少可解析的服务端凭据",
      checkedAt,
    };
  }
  const authorization = `Bearer ${secret}`;
  const startedAt = Date.now();
  let httpStatus: number | null = null;
  let modelsVisible = 0;
  const modelsMissing: string[] = [];
  const modelItems: PatrolModelItem[] = [];
  let error: string | null = null;
  try {
    const response = await fetch(`${origin}/v1/models`, {
      headers: { Authorization: authorization },
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    httpStatus = response.status;
    if (!response.ok) {
      error = `目录接口 HTTP ${response.status}`;
    } else {
      const body = await readJson(response);
      const list = Array.isArray(body?.data) ? body!.data as Row[] : [];
      const ids = new Set(list.map((item) => String(item.id || "").trim().toLowerCase()).filter(Boolean));
      modelsVisible = ids.size;
      for (const model of models) {
        const candidate = (model.modelName || model.name || model.id).toLowerCase();
        const visible = ids.has(candidate);
        if (!visible) modelsMissing.push(model.name || model.modelName || model.id);
        modelItems.push({ name: model.name || model.modelName || model.id, modelName: model.modelName, table: model.table, catalogVisible: visible });
      }
    }
  } catch (cause) {
    error = sanitizeError(cause);
  }
  const latencyMs = Date.now() - startedAt;
  const accessToken = balanceAccessToken(host);
  let balanceState: PatrolChannelResult["balanceState"] = "missing-credential";
  let balanceUsd: number | null = null;
  let usedUsd: number | null = null;
  let balanceError: string | null = null;
  if (accessToken) {
    const quota = await probeUserQuota(origin, accessToken.token, accessToken.userId);
    if (quota.supported) {
      balanceState = "ok";
      balanceUsd = quota.balanceUsd;
      usedUsd = quota.usedUsd;
    } else {
      balanceState = "missing-credential";
      balanceError = "余额凭据无效或该渠道不支持用户额度接口";
    }
  } else {
    const billing = await probeBilling(origin, authorization);
    balanceState = billing.balanceState;
    balanceUsd = billing.balanceUsd;
    usedUsd = billing.usedUsd;
    if (billing.balanceState === "unlimited") balanceError = "该渠道返回“不限额”，需配置用户 access token 才能读真实余额";
    else if (billing.balanceState === "unsupported") balanceError = adapter === "secure-skill" ? "该渠道未开放余额接口" : "余额接口不可用";
  }
  const balanceSupported = balanceState === "ok";
  const status: PatrolChannelResult["status"] = httpStatus === null
    ? "down"
    : httpStatus >= 400
      ? "down"
      : "ok";
  return {
    ...base,
    status,
    httpStatus,
    latencyMs,
    credentialReady: true,
    modelsVisible,
    modelsMissing: modelsMissing.slice(0, 20),
    modelItems,
    balanceUsd,
    usedUsd,
    balanceSupported,
    balanceState,
    error: error || balanceError,
    checkedAt,
  };
}

export async function listPatrolChannels(): Promise<{ channels: PatrolChannelSummary[]; lastRun: PatrolSnapshot | null }> {
  const groups = groupChannels(await readModels());
  const channels: PatrolChannelSummary[] = [...groups.entries()]
    .map(([host, group]) => ({
      host,
      origin: group.origin,
      adapter: adapterFor(host),
      modelCount: group.models.length,
      models: group.models.map((model) => ({ name: model.name, modelName: model.modelName, table: model.table })),
      balanceSupportedHint: adapterFor(host) !== "secure-skill",
    }))
    .sort((left, right) => right.modelCount - left.modelCount);
  return { channels, lastRun: snapshotCache };
}

export async function runChannelPatrol(force = false): Promise<PatrolSnapshot> {
  if (!force && snapshotCache && Date.now() - new Date(snapshotCache.checkedAt).getTime() < CACHE_TTL_MS) {
    return snapshotCache;
  }
  const startedAt = Date.now();
  const groups = groupChannels(await readModels());
  const channels = await Promise.all(
    [...groups.entries()].map(([host, group]) => probeChannel(host, group.origin, group.models)),
  );
  const sorted = channels.sort((left, right) => Number(right.balanceSupported) - Number(left.balanceSupported) || right.modelCount - left.modelCount);
  const snapshot: PatrolSnapshot = {
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    channels: sorted,
    faults: computeModelFaults(sorted),
  };
  snapshotCache = snapshot;
  return snapshot;
}

export function readCachedPatrolSnapshot(): PatrolSnapshot | null {
  return snapshotCache;
}

export type ArrearsProbeResult = {
  host: string;
  model: string;
  status: "ok" | "insufficient" | "auth-failed" | "error" | "skipped";
  httpStatus: number | null;
  message: string;
};

const INSUFFICIENT_PATTERN = /insufficient|quota|balance|余额|欠费|额度不足|prepaid/iu;

/**
 * Optional arrears probe: one 1-token chat completion per channel that has a
 * text model. This is the only reliable way to see "insufficient balance"
 * without a user access token; it costs a minimal amount, so it never runs by
 * default and the UI must confirm first.
 */
export async function probeChannelArrears(): Promise<{ checkedAt: string; results: ArrearsProbeResult[] }> {
  const groups = groupChannels(await readModels());
  const results: ArrearsProbeResult[] = [];
  await Promise.all([...groups.entries()].map(async ([host, group]) => {
    const textModel = group.models.find((model) => model.table === "llm_models" && model.modelName);
    if (!textModel) {
      results.push({ host, model: "", status: "skipped", httpStatus: null, message: "该渠道没有文本模型，跳过欠费探测" });
      return;
    }
    const secret = resolveChannelSecret(group.models);
    if (!secret) {
      results.push({ host, model: textModel.modelName, status: "skipped", httpStatus: null, message: "缺少可解析凭据" });
      return;
    }
    try {
      const response = await fetch(`${new URL(group.origin).origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ model: textModel.modelName, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
        cache: "no-store",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = await readJson(response);
      const message = JSON.stringify(body?.error || body?.message || "").slice(0, 160);
      const status: ArrearsProbeResult["status"] = response.ok
        ? "ok"
        : response.status === 401
          ? "auth-failed"
          : response.status === 402 || INSUFFICIENT_PATTERN.test(message)
            ? "insufficient"
            : "error";
      results.push({
        host,
        model: textModel.modelName,
        status,
        httpStatus: response.status,
        message: status === "ok" ? "可正常调用" : status === "insufficient" ? "余额不足/欠费" : message || `HTTP ${response.status}`,
      });
    } catch (cause) {
      results.push({ host, model: textModel.modelName, status: "error", httpStatus: null, message: sanitizeError(cause) });
    }
  }));
  return { checkedAt: new Date().toISOString(), results: results.sort((left, right) => left.host.localeCompare(right.host)) };
}




