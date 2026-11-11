import "server-only";
import type { AuthUser, getSupabase } from "../api-middleware";
import { PublishingAuthorizationBindingSchema, PublishingAuthorizationPlatformSchema } from "../publishing-authorization-contract";
import { PublishingError } from "./publishing-service";
import { readPublishingProviderConfiguration } from "./publishing-provider-config";
import { genericPublishingFieldPolicy } from '../publishing-generic-validation';

type DB = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;
type Configuration = { namespace: string };
export interface NativeGenericAccountsDependencies { configuration?: () => Configuration }
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const capabilities = () => ({ connect: true as const, publish: false as const, analytics: false as const, engagement: false as const });
// Provider IDs and the connection fingerprint stay on the server. The local
// owner binding remains the only account identifier exposed to the native UI.
const columns = "id,owner_id,connection_id,platform,platform_uid,account,display_name,avatar,status,revision,group_id,auth_session_id,created_at,updated_at";
function unavailable(error?: unknown): never {
  const code = object(error).code;
  if (["42P01", "PGRST202", "PGRST204", "PGRST205"].includes(String(code))) throw new PublishingError("PUBLISH_AUTH_SCHEMA_NOT_READY", "通用授权数据结构尚未初始化", 503);
  throw new PublishingError("NATIVE_GENERIC_ACCOUNTS_UNAVAILABLE", "官方授权账号暂不可确认，请稍后读取原记录", 503);
}
function accountDto(row: Row, ownerId: string, cfg: Configuration) {
  if (row.owner_id !== ownerId || row.connection_id !== cfg.namespace) unavailable();
  const checked = PublishingAuthorizationBindingSchema.safeParse({
    id: row.id, platform: row.platform, platformUid: row.platform_uid,
    ...(typeof row.account === "string" ? { account: row.account } : {}), displayName: row.display_name,
    ...(row.avatar ? { avatar: row.avatar } : {}), status: row.status, revision: row.revision,
    groupId: row.group_id ?? null, authSessionId: row.auth_session_id, connectionCurrent: true,
    capabilities: capabilities(), createdAt: row.created_at, updatedAt: row.updated_at,
  });
  if (!checked.success) unavailable();
  const binding = checked.data;
  return {
    id: binding.id, type: binding.platform, uid: binding.platformUid, nickname: binding.displayName, avatar: binding.avatar ?? "",
    // The original UI interprets 1 as an executable online account. An OAuth
    // binding currently proves connection only and therefore never claims 1.
    status: binding.status === 'active' ? 1 : 0, rank: 0, groupId: binding.groupId ?? "", clientType: "web",
    nativeAccountKind: "generic" as const, nativeTransport: "generic-oauth" as const,
    nativeBindingStatus: binding.status, nativeConnectionState: binding.status === "active" ? "official_bound" : binding.status,
    nativeDisconnected: binding.status === "disconnected", nativeBindingRevision: binding.revision,
    nativeRevision: binding.revision, nativeMetadataRevision: 0, nativeAuthSessionId: binding.authSessionId,
    authSessionId: binding.authSessionId, nativeConnectionCurrent: binding.connectionCurrent, connectionCurrent: binding.connectionCurrent,
    nativeReadOnly: !binding.connectionCurrent, nativePublishAllowed: false,
    nativeCapabilities: binding.capabilities, capabilities: binding.capabilities,
    createdAt: binding.createdAt, updatedAt: binding.updatedAt,
  };
}

/** Only current, active bindings enter the original account directory. */
export async function readNativeGenericAccounts(db: DB, user: AuthUser, dependencies: NativeGenericAccountsDependencies = {}) {
  const cfg = (dependencies.configuration ?? readPublishingProviderConfiguration)();
  const result: ReturnType<typeof accountDto>[] = [];
  for (let page = 0; ; page++) {
    const response = await db.from("pub4_account_bindings").select(columns).eq("owner_id", user.id).eq("connection_id", cfg.namespace).eq("status", "active").order("id", { ascending: true }).range(page * 100, page * 100 + 99);
    if (response.error || !Array.isArray(response.data)) unavailable(response.error);
    for (const value of response.data) {
      const row = object(value);
      if (row.status !== "active") unavailable();
      result.push(accountDto(row, user.id, cfg));
    }
    if (response.data.length < 100) return result;
  }
}

/** A stale namespace or another owner's UUID is absent from this route. */
export async function readNativeGenericAccount(db: DB, user: AuthUser, accountId: string, dependencies: NativeGenericAccountsDependencies = {}) {
  const cfg = (dependencies.configuration ?? readPublishingProviderConfiguration)();
  const response = await db.from("pub4_account_bindings").select(columns).eq("owner_id", user.id).eq("connection_id", cfg.namespace).eq("id", accountId).maybeSingle();
  if (response.error) unavailable(response.error);
  return response.data ? accountDto(object(response.data), user.id, cfg) : null;
}

/** Host readiness and current upstream capabilities are both required. */
export function projectNativeGenericPlatform(item: Row, configuration: { configured: boolean; schemaReady?: boolean; executionEnabled?: boolean; enabledPlatforms?: string[] }): Row | null {
  if (!PublishingAuthorizationPlatformSchema.safeParse(item.platform).success) return null;
  const available = item.status === "available" && item.authType === "oauth2";
  const executionReason = genericPublishingFieldPolicy(String(item.platform)).executionReason;
  const publish = !executionReason && available && configuration.configured && configuration.schemaReady === true && configuration.executionEnabled === true && configuration.enabledPlatforms?.includes(String(item.platform)) === true && object(object(item.capabilities).publish).supported === true;
  return {
    ...item, nativeAccountKind: "generic", nativeTransport: "generic-oauth", nativeExecutionBlocked: Boolean(executionReason),
    nativeConnectionAllowed: configuration.configured && available, nativePublishAllowed: publish,
    nativeCapabilities: { ...capabilities(), publish },
    nativeReason: executionReason || (!available ? "该平台当前尚未开放官方授权" : !configuration.configured ? "请先由管理员配置本站发布服务" : !configuration.schemaReady ? "此平台发布数据结构尚未部署" : !publish ? "此平台当前发布通道未开放，请保留稿件后再核对" : "发布前仍需核对账号、素材和主站执行额度"),
  };
}
