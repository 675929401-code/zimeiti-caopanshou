import "server-only";

import { createHash } from "node:crypto";
import { AGENT_NAVIGATION_OPTIONS } from "@/lib/agent-category-access";
import { normalizeAgentPresetFields } from "@/lib/agent-preset-schema";
import {
  MEMBER_FEATURE_PERMISSION_OPTIONS,
  normalizeFeatureNavigationKeys,
  normalizeMemberAgentNavigationKeys,
} from "@/lib/member-permissions";
import { readCurrentPlatformConfiguration } from "@/lib/server/platform-configuration-admin";
import { configurationSourceStatus, sharedConfigurationEnabled } from "@/storage/database/configuration-source";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type Row = Record<string, unknown>;

// Explicit projections omit credentials, actor/user IDs and mutation metadata.
const AGENT_COLUMNS = [
  "id", "name", "description", "avatar", "cover_url", "category", "source", "model", "model_id",
  "bot_id", "coze_coding_api_url", "coze_coding_project_id", "proxy_url", "system_prompt", "output_style",
  "sort_order", "is_active", "user_access", "config_revision", "preset_fields", "guide_message",
  "cost_per_message", "base_fee", "frequency_limit", "image_parsing", "file_parsing", "enable_think_tags",
  "deep_thinking_type", "deduct_deep_think", "max_context_rounds", "max_context_tokens", "max_reply_tokens",
  "timeout", "enable_web_search", "temperature", "response_format", "token_billing_enabled",
  "input_cost_per_million", "output_cost_per_million", "cached_cost_per_million", "profit_margin",
  "token_rounding_unit", "enable_knowledge_base", "knowledge_base_id",
] as const;
const CATEGORY_COLUMNS = "id,name,icon,description,sort_order,visibility,is_active";
const PACKAGE_COLUMNS = "profile_key,version,name,description,feature_navigation_keys,agent_navigation_keys,membership_status,duration_days,credits,cash_amount,sort_order,is_selectable";
const RESOURCE_COLUMNS = "resource_type,resource_key,label,route,description,sort_order";
const DISPLAY_COLUMNS = ["name", "description", "avatar", "cover_url", "category", "sort_order", "preset_fields", "guide_message"] as const;
const AGENT_CONFIGURATION_COLUMNS = AGENT_COLUMNS.filter((column) => ![
  "id", "name", "description", "avatar", "cover_url", "category", "sort_order", "config_revision", "system_prompt", "preset_fields", "guide_message",
].includes(column));

function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("NON_FINITE_CONFIGURATION_VALUE");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const row = value as Row;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  if (!["boolean", "number", "string"].includes(typeof value)) throw new Error("UNSUPPORTED_CONFIGURATION_VALUE");
  return JSON.stringify(value);
}

/** Semantic digests never include request times or release/row revision metadata. */
export function configurationIdentitySha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new Error("INVALID_CONFIGURATION_NUMBER");
  return result;
}
function pick(row: Row, columns: readonly string[]): Row {
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
}
function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function verified<T extends Row>(value: T) { return { status: "verified" as const, ...value }; }
function unavailable(errorCode: string) { return { status: "unavailable" as const, sha256: null, errorCode }; }

/** Page explicitly and fail on truncated/inconsistent catalogs rather than reporting a partial hash. */
async function rows(table: string, columns: string, key: string, filter?: (query: any) => any): Promise<Row[]> {
  const result: Row[] = [];
  let expectedCount: number | null = null;
  for (let offset = 0; offset < 100_000; offset += 500) {
    let query = getSupabaseAdminClient().from(table).select(columns, { count: "exact" }).order(key, { ascending: true });
    if (filter) query = filter(query);
    const page = await query.range(offset, offset + 499).abortSignal(AbortSignal.timeout(10_000));
    if (page.error || !Array.isArray(page.data) || !Number.isSafeInteger(page.count) || page.count < 0) throw new Error("CONFIGURATION_READ_FAILED");
    const currentCount: number = page.count;
    if (expectedCount !== null && currentCount !== expectedCount) throw new Error("CONFIGURATION_CHANGED_DURING_READ");
    expectedCount = currentCount;
    result.push(...page.data);
    if (result.length === currentCount) return result;
    if (page.data.length < 500 || result.length > currentCount) throw new Error("CONFIGURATION_READ_TRUNCATED");
  }
  throw new Error("CONFIGURATION_READ_LIMIT_EXCEEDED");
}

async function agents() {
  const data = await rows("agents", AGENT_COLUMNS.join(","), "id", (query) => query.is("deleted_at", null));
  const items = data.map((row) => ({
    id: text(row.id), name: text(row.name), category: text(row.category),
    isActive: row.is_active === true, userAccess: text(row.user_access), sortOrder: number(row.sort_order),
    revision: number(row.config_revision),
    promptSha256: configurationIdentitySha256(row.system_prompt ?? null),
    configurationSha256: configurationIdentitySha256(pick(row, AGENT_CONFIGURATION_COLUMNS)),
    displaySha256: configurationIdentitySha256({ ...pick(row, DISPLAY_COLUMNS), preset_fields: normalizeAgentPresetFields(row.preset_fields) }),
    modelBinding: {
      source: text(row.source), modelId: text(row.model_id), modelName: text(row.model),
      endpointSha256: configurationIdentitySha256(row.coze_coding_api_url ?? null),
      proxySha256: configurationIdentitySha256(row.proxy_url ?? null),
    },
  })).sort((left, right) => lexical(left.id, right.id));
  return verified({ count: items.length, sha256: configurationIdentitySha256(items.map(({ revision: _revision, ...semantic }) => semantic)), items });
}

async function categories() {
  const data = await rows("categories", CATEGORY_COLUMNS, "id");
  const items = data.map((row) => ({
    id: text(row.id), name: text(row.name), isActive: row.is_active === true,
    visibility: text(row.visibility), sortOrder: number(row.sort_order),
    displaySha256: configurationIdentitySha256(pick(row, ["icon", "description"])),
  })).sort((left, right) => lexical(left.id, right.id));
  return verified({ count: items.length, sha256: configurationIdentitySha256(items), items });
}

async function membershipPackages() {
  // The existing member-packages GET syncs resource rows. Read only the effective
  // active templates here, including system/non-selectable profiles; never call
  // that endpoint or inspect assignments. Stored resource definitions are also
  // read rather than upserted, so definition drift remains observable.
  const [data, resourceRows] = await Promise.all([
    rows("member_permission_profiles", PACKAGE_COLUMNS, "profile_key", (query) => query.eq("is_active", true).order("version", { ascending: true })),
    rows("member_permission_resources", RESOURCE_COLUMNS, "resource_type", (query) => query.order("resource_key", { ascending: true })),
  ]);
  const declaredKeys = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(String))].sort(lexical) : [];
  const items = data.map((row) => ({
    key: text(row.profile_key), version: number(row.version), name: text(row.name),
    isSelectable: row.is_selectable === true,
    descriptionSha256: configurationIdentitySha256(row.description ?? null),
    membershipStatus: text(row.membership_status) || "trial", durationDays: number(row.duration_days),
    credits: number(row.credits), cashAmount: number(row.cash_amount), sortOrder: number(row.sort_order),
    featureNavigationKeys: normalizeFeatureNavigationKeys(row.feature_navigation_keys),
    agentNavigationKeys: normalizeMemberAgentNavigationKeys(row.agent_navigation_keys),
    declaredFeatureNavigationKeys: declaredKeys(row.feature_navigation_keys),
    declaredAgentNavigationKeys: declaredKeys(row.agent_navigation_keys),
    ignoredFeatureNavigationKeys: declaredKeys(row.feature_navigation_keys).filter((key) => !normalizeFeatureNavigationKeys(row.feature_navigation_keys).some((effective) => effective === key)),
    ignoredAgentNavigationKeys: declaredKeys(row.agent_navigation_keys).filter((key) => !normalizeMemberAgentNavigationKeys(row.agent_navigation_keys).includes(key)),
  })).sort((left, right) => lexical(left.key, right.key) || left.version - right.version);
  const staticKnownKeys = {
    featureNavigationKeys: MEMBER_FEATURE_PERMISSION_OPTIONS.map((item) => item.key),
    agentNavigationKeys: AGENT_NAVIGATION_OPTIONS.map((item) => item.key),
  };
  const resources = resourceRows.map((row) => ({
    type: text(row.resource_type), key: text(row.resource_key), label: text(row.label), sortOrder: number(row.sort_order),
    routeSha256: configurationIdentitySha256(row.route ?? null), descriptionSha256: configurationIdentitySha256(row.description ?? null),
  })).sort((left, right) => lexical(`${left.type}:${left.key}`, `${right.type}:${right.key}`));
  const knownResources = [...staticKnownKeys.featureNavigationKeys.map((key) => `feature:${key}`), ...staticKnownKeys.agentNavigationKeys.map((key) => `agent:${key}`)].sort(lexical);
  const storedResources = resources.map((row) => `${row.type}:${row.key}`);
  const resourceDrift = {
    missingFromDatabase: knownResources.filter((key) => !storedResources.includes(key)),
    unknownInDatabase: storedResources.filter((key) => !knownResources.includes(key)),
  };
  return verified({ count: items.length, sha256: configurationIdentitySha256({
    items: items.map(({ version: _version, ...semantic }) => semantic), resources, staticKnownKeys,
  }), scope: "active-profiles", items, resources, staticKnownKeys, resourceDrift });
}

function releaseIdentity(row: Row) {
  return { releaseId: text(row.id), releaseVersion: number(row.release_version), snapshotSha256: text(row.snapshot_sha256), status: text(row.status) };
}

async function modelPoolRelease() {
  const current = await readCurrentPlatformConfiguration("model-pool");
  if (!current) return { status: "missing" as const, sha256: null, identity: null, errorCode: "MODEL_POOL_RELEASE_MISSING" };
  const items = current.snapshot.models.map((model) => ({
    id: model.id, kind: model.kind, name: model.name, modelName: model.modelName, provider: model.provider,
    protocol: model.protocol, catalogState: model.catalogState, sortOrder: model.sortOrder,
    endpointSha256: configurationIdentitySha256(model.endpoint),
    // References, arbitrary provider configuration and pricing are digest-only.
    configurationSha256: configurationIdentitySha256({ credentialRef: model.credentialRef ?? null, capabilities: model.capabilities, pricing: model.pricing, configuration: model.configuration }),
  })).sort((left, right) => lexical(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`));
  return verified({ count: items.length, sha256: configurationIdentitySha256(items), scope: "published-release", physicalBindingReadiness: "not-evaluated", identity: releaseIdentity(current.release), items });
}

async function workspaceModelRelease() {
  const current = await readCurrentPlatformConfiguration("workspace-models");
  if (!current) return { status: "missing" as const, sha256: null, identity: null, errorCode: "WORKSPACE_MODEL_RELEASE_MISSING" };
  return verified({
    sha256: configurationIdentitySha256({ modelPoolSnapshotSha256: current.snapshot.modelPoolRelease.snapshotSha256, surfaces: current.snapshot.surfaces }),
    scope: "published-release", physicalBindingReadiness: "not-evaluated",
    identity: releaseIdentity(current.release), modelPoolRelease: current.snapshot.modelPoolRelease, surfaces: current.snapshot.surfaces,
  });
}

function databaseTargetSha256(raw: string | undefined): string | null {
  if (!raw) return null;
  const url = new URL(raw);
  // URL credentials, query/fragment and their sensitive values are excluded.
  return configurationIdentitySha256({ origin: url.origin, pathname: url.pathname.replace(/\/+$/u, "") });
}

async function configurationSource() {
  const status = configurationSourceStatus();
  return verified({
    ...status,
    businessDatabaseSha256: databaseTargetSha256(process.env.COZE_SUPABASE_URL),
    configurationDatabaseSha256: databaseTargetSha256(sharedConfigurationEnabled() ? process.env.SHARED_CONFIGURATION_SUPABASE_URL : process.env.COZE_SUPABASE_URL),
    configurationIdSha256: process.env.SHARED_CONFIGURATION_ID ? configurationIdentitySha256(process.env.SHARED_CONFIGURATION_ID) : null,
  });
}

export async function readConfigurationIdentity() {
  const startedAt = new Date().toISOString();
  const sections = [
    ["configurationSource", configurationSource, "CONFIGURATION_SOURCE_UNAVAILABLE"],
    ["agents", agents, "AGENT_CONFIGURATION_UNAVAILABLE"],
    ["categories", categories, "CATEGORY_CONFIGURATION_UNAVAILABLE"],
    ["membershipPackages", membershipPackages, "MEMBERSHIP_PACKAGES_UNAVAILABLE"],
    ["modelPoolRelease", modelPoolRelease, "MODEL_POOL_RELEASE_UNAVAILABLE"],
    ["workspaceModelRelease", workspaceModelRelease, "WORKSPACE_MODEL_RELEASE_UNAVAILABLE"],
  ] as const;
  const results = await Promise.allSettled(sections.map(([, read]) => read()));
  const domains = Object.fromEntries(sections.map(([key, , errorCode], index) => {
    const result = results[index];
    return [key, result.status === "fulfilled" ? result.value : unavailable(errorCode)];
  }));
  return {
    schemaVersion: "configuration-identity.v1" as const,
    status: Object.values(domains).every((domain) => domain.status === "verified") ? "verified" : "incomplete",
    observedAt: new Date().toISOString(), startedAt, consistency: "independent-read-observations" as const,
    readOnly: true, scope: "owner-configuration" as const,
    policy: { businessWrites: false, configurationWrites: false, providerCalls: false, securityAuditMayAppend: true },
    ...domains,
  };
}
