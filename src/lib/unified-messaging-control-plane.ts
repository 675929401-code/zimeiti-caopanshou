export const UNIFIED_MESSAGING_MIGRATION = "20261002150000" as const;

export const UNIFIED_MESSAGING_LEGACY_CHAINS = [
  "announcements",
  "account_notifications",
  "popup_pushes",
  "video_notifications",
] as const;

type UnknownRecord = Record<string, unknown>;

export interface UnifiedMessagingDatabaseClient {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface UnifiedMessagingCountMap {
  [key: string]: number;
}

export interface UnifiedMessagingOutboxStatus {
  pending: number;
  processing: number;
  retry: number;
  published: number;
  deadLetter: number;
  cancelled: number;
  due: number;
  oldestDueAt: string | null;
}

export interface UnifiedMessagingDatabaseStatus {
  schemaVersion: 1;
  migration: typeof UNIFIED_MESSAGING_MIGRATION;
  asOf: string;
  tableCounts: UnifiedMessagingCountMap;
  outbox: UnifiedMessagingOutboxStatus;
  deliveries: UnifiedMessagingCountMap;
  deadLetters: UnifiedMessagingCountMap;
  surfacePolicies: UnifiedMessagingCountMap;
}

export interface UnifiedMessagingStatus {
  schemaVersion: 1;
  controlPlane: "unified_messaging";
  phase: "foundation_only";
  migrationApplied: true;
  database: UnifiedMessagingDatabaseStatus;
  integration: {
    legacyHistoryMigrated: false;
    legacyProducersConnected: false;
    legacyConsumersConnected: false;
    outboxWorkerConnected: false;
    endUserSurfacesConnected: false;
    connectedLegacyChains: [];
    pendingLegacyChains: typeof UNIFIED_MESSAGING_LEGACY_CHAINS;
  };
}

export type UnifiedMessagingStatusErrorCode =
  | "UNIFIED_MESSAGING_SCHEMA_REQUIRED"
  | "UNIFIED_MESSAGING_STATUS_INVALID"
  | "UNIFIED_MESSAGING_STATUS_UNAVAILABLE";

export class UnifiedMessagingStatusError extends Error {
  readonly code: UnifiedMessagingStatusErrorCode;

  constructor(code: UnifiedMessagingStatusErrorCode, message: string) {
    super(message);
    this.name = "UnifiedMessagingStatusError";
    this.code = code;
  }
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function countMap(value: unknown, keys: readonly string[]): UnifiedMessagingCountMap {
  const source = record(value) || {};
  return Object.fromEntries(keys.map((key) => [key, count(source[key])])) as UnifiedMessagingCountMap;
}

function errorDetails(error: unknown): { code: string; message: string } {
  const value = record(error) || {};
  return {
    code: typeof value.code === "string" ? value.code : "",
    message: [value.message, value.details, value.hint]
      .filter((item): item is string => typeof item === "string")
      .join(" "),
  };
}

export function unifiedMessagingSchemaUnavailable(error: unknown): boolean {
  const detail = errorDetails(error);
  return ["42P01", "42883", "PGRST202", "PGRST204"].includes(detail.code)
    || /get_unified_messaging_status|message_(?:templates|surface_policies|campaigns|campaign_runs|deliveries|events|outbox|dead_letters)/iu.test(detail.message);
}

export function normalizeUnifiedMessagingDatabaseStatus(value: unknown): UnifiedMessagingDatabaseStatus {
  const root = record(value);
  if (!root || Number(root.schemaVersion) !== 1 || String(root.migration || "") !== UNIFIED_MESSAGING_MIGRATION) {
    throw new UnifiedMessagingStatusError(
      "UNIFIED_MESSAGING_STATUS_INVALID",
      "统一消息控制平面状态回执无效",
    );
  }

  const outboxSource = record(root.outbox) || {};
  return {
    schemaVersion: 1,
    migration: UNIFIED_MESSAGING_MIGRATION,
    asOf: typeof root.asOf === "string" ? root.asOf : new Date().toISOString(),
    tableCounts: countMap(root.tableCounts, [
      "templates",
      "surfacePolicies",
      "campaigns",
      "runs",
      "deliveries",
      "events",
      "outbox",
      "deadLetters",
    ]),
    outbox: {
      pending: count(outboxSource.pending),
      processing: count(outboxSource.processing),
      retry: count(outboxSource.retry),
      published: count(outboxSource.published),
      deadLetter: count(outboxSource.deadLetter),
      cancelled: count(outboxSource.cancelled),
      due: count(outboxSource.due),
      oldestDueAt: typeof outboxSource.oldestDueAt === "string" ? outboxSource.oldestDueAt : null,
    },
    deliveries: countMap(root.deliveries, [
      "queued",
      "fetched",
      "impression",
      "read",
      "actioned",
      "closed",
      "failed",
      "deadLetter",
      "suppressed",
      "cancelled",
    ]),
    deadLetters: countMap(root.deadLetters, ["open", "resolved", "discarded"]),
    surfacePolicies: countMap(root.surfacePolicies, ["active", "draft", "retired"]),
  };
}

export async function readUnifiedMessagingStatus(
  database: UnifiedMessagingDatabaseClient,
): Promise<UnifiedMessagingStatus> {
  const { data, error } = await database.rpc("get_unified_messaging_status");
  if (error) {
    if (unifiedMessagingSchemaUnavailable(error)) {
      throw new UnifiedMessagingStatusError(
        "UNIFIED_MESSAGING_SCHEMA_REQUIRED",
        `统一消息控制平面迁移 ${UNIFIED_MESSAGING_MIGRATION} 尚未应用`,
      );
    }
    throw new UnifiedMessagingStatusError(
      "UNIFIED_MESSAGING_STATUS_UNAVAILABLE",
      "统一消息控制平面状态暂不可用",
    );
  }

  return {
    schemaVersion: 1,
    controlPlane: "unified_messaging",
    phase: "foundation_only",
    migrationApplied: true,
    database: normalizeUnifiedMessagingDatabaseStatus(data),
    integration: {
      legacyHistoryMigrated: false,
      legacyProducersConnected: false,
      legacyConsumersConnected: false,
      outboxWorkerConnected: false,
      endUserSurfacesConnected: false,
      connectedLegacyChains: [],
      pendingLegacyChains: UNIFIED_MESSAGING_LEGACY_CHAINS,
    },
  };
}
