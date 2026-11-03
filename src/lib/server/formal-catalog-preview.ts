import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { displayCategory } from "../business-ip/catalog";
import { isBlockedIpAddress } from "../safe-fetch";
import { fetchPinnedPublicAddress } from "../safe-fetch-public-dns";
import { configurationSourceStatus } from "../../storage/database/configuration-source";

const ORIGINS = { local: "http://127.0.0.1:5000", official: "https://zyuani8.com" } as const;
const PATHS = { agents: "/api/bots?shape=agents", categories: "/api/categories" } as const;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_AGE_MS = 90_000;
type Source = keyof typeof ORIGINS;
type Env = Readonly<Record<string, string | undefined>>;
type PublicAgent = { id: string; name: string; category: string; displayCategory: string; isActive: boolean; userAccess: string };
type PublicCategory = { id: string; name: string; sortOrder: number; userCanUse: boolean };
type ComparisonRow = { id: string; fields: Record<string, string> };

export function formalCatalogPreviewEnabled(env: Env = process.env): boolean {
  if (env.PORT !== "5000" || env.HOSTNAME !== "127.0.0.1" || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return false;
  try {
    const identity = configurationSourceStatus(env);
    return identity.configuration === "local-acceptance" && identity.businessData === "local";
  } catch {
    return false;
  }
}

function invalid(): never { throw new Error("FORMAL_CATALOG_INVALID"); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function textField(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f]/u.test(value)) invalid();
  return value;
}

function digest(value: unknown): string {
  // Key ordering inside a projected public JSON field is not a settings change.
  const canonical = JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sortedUnique<T extends { id: string }>(rows: T[]) {
  if (new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  return rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

// These are fields already emitted by the anonymous public route. Hash free
// text/URLs/opaque bindings in-process; the diagnostic returns changed field names only.
const AGENT_DETAIL_FIELDS = [
  "description", "icon_url", "source", "bot_id", "model", "sort_order", "cost_per_message", "base_fee",
  "preset_fields", "model_id", "cover_url", "enable_think_tags", "deep_thinking_type",
  "enable_web_search", "guide_message", "response_format", "token_billing_enabled", "output_style",
] as const;

function project(source: Source, catalog: unknown, categoryCatalog: unknown) {
  const bots = record(catalog);
  const categoryRows = record(categoryCatalog).categories;
  if (bots.navigationKeys !== null || !Array.isArray(bots.agents) || !Array.isArray(categoryRows)) invalid();
  const categories = sortedUnique(categoryRows.map((entry): PublicCategory => {
    const row = record(entry);
    const name = textField(row.name);
    if (name.trim() === "自用" || !["normal", "view_only"].includes(String(row.visibility))
      || row.is_active !== true || typeof row.user_can_use !== "boolean" || row.user_can_use !== (row.visibility !== "view_only")
      || typeof row.sort_order !== "number" || !Number.isFinite(row.sort_order)) invalid();
    return { id: textField(row.id), name, sortOrder: row.sort_order, userCanUse: row.user_can_use };
  }));
  const categoryNames = new Set(categories.map(row => row.name));
  if (categoryNames.size !== categories.length) invalid();
  const comparisons: ComparisonRow[] = [];
  const agents = sortedUnique(bots.agents.map((entry): PublicAgent => {
    const row = record(entry);
    const id = textField(row.id);
    const name = textField(row.name);
    const category = textField(row.category);
    const userAccess = textField(row.user_access);
    if (!categoryNames.has(category) || row.deleted_at !== null || typeof row.is_active !== "boolean"
      || !["available", "view_only"].includes(userAccess)) invalid();
    const group = displayCategory({ id, name, category });
    const details = Object.fromEntries(AGENT_DETAIL_FIELDS.map(key => [key, digest(row[key] ?? null)]));
    comparisons.push({ id, fields: { name, category, displayCategory: group, isActive: String(row.is_active), userAccess, ...details } });
    return { id, name, category, displayCategory: group, isActive: row.is_active, userAccess };
  }));
  sortedUnique(comparisons);
  const groupCounts: Record<string, number> = Object.create(null);
  for (const agent of agents) groupCounts[agent.displayCategory] = (groupCounts[agent.displayCategory] || 0) + 1;
  return {
    comparisons,
    snapshot: { source, origin: ORIGINS[source], capturedAt: new Date().toISOString(), digest: digest({ comparisons, categories }),
      count: agents.length, groupCounts, categories, agents },
  };
}

function diffRows(local: ComparisonRow[], official: ComparisonRow[]) {
  const localMap = new Map(local.map(row => [row.id, row.fields]));
  const officialMap = new Map(official.map(row => [row.id, row.fields]));
  const onlyLocal = [...localMap.keys()].filter(id => !officialMap.has(id));
  const onlyOfficial = [...officialMap.keys()].filter(id => !localMap.has(id));
  const changed = local.flatMap(row => {
    const match = officialMap.get(row.id);
    const fields = match ? Object.keys(row.fields).filter(key => row.fields[key] !== match[key]) : [];
    return fields.length ? [{ id: row.id, fields }] : [];
  });
  return { onlyLocal, onlyOfficial, changed };
}

async function readJson(response: Response) {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") || "")
    || !response.body) {
    await response.body?.cancel();
    throw new Error("FORMAL_CATALOG_RESPONSE_INVALID");
  }
  const date = Date.parse(response.headers.get("date") || "");
  const age = Number(response.headers.get("age") || 0);
  if (!Number.isFinite(date) || Math.abs(Date.now() - date) > MAX_RESPONSE_AGE_MS
    || !Number.isFinite(age) || age < 0 || age * 1000 > MAX_RESPONSE_AGE_MS) {
    await response.body.cancel();
    throw new Error("FORMAL_CATALOG_RESPONSE_STALE");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("FORMAL_CATALOG_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

type CatalogRead = (url: URL, init: RequestInit) => Promise<Response>;

function officialReadWithPin(address: string): CatalogRead {
  const family = isIP(address);
  if (!family || isBlockedIpAddress(address)) throw new Error("FORMAL_CATALOG_ORIGIN_PIN_INVALID");
  return (url, init) => fetchPinnedPublicAddress(url, { address, family }, init);
}

export async function readFormalCatalogPreview(env: Env = process.env, read: CatalogRead = fetch) {
  if (!formalCatalogPreviewEnabled(env)) throw new Error("FORMAL_CATALOG_LOCAL_ONLY");
  const pin = env.FORMAL_CATALOG_ORIGIN_IP?.trim();
  const officialRead = pin ? officialReadWithPin(pin) : read;
  async function capture(source: Source) {
    const get = source === "official" ? officialRead : read;
    const readPath = async (path: (typeof PATHS)[keyof typeof PATHS]) => {
      const result = await get(new URL(path, ORIGINS[source]), {
        method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(12_000),
      });
      return readJson(result);
    };
    const [agents, categories] = await Promise.all([readPath(PATHS.agents), readPath(PATHS.categories)]);
    return project(source, agents, categories);
  }
  const [local, official] = await Promise.all([capture("local"), capture("official")]);
  const diff = diffRows(local.comparisons, official.comparisons);
  const categoryRows = (categories: PublicCategory[]) => categories.map(row => ({
    id: row.id, fields: { name: row.name, sortOrder: String(row.sortOrder), userCanUse: String(row.userCanUse) },
  }));
  return {
    ok: true as const, schema: "formal-catalog-preview/v1" as const, capturedAt: new Date().toISOString(), scope: "public" as const,
    digestKind: "observed-public-projection-sha256" as const, local: local.snapshot, official: official.snapshot,
    diff: { ...diff, categories: diffRows(categoryRows(local.snapshot.categories), categoryRows(official.snapshot.categories)),
      same: local.snapshot.digest === official.snapshot.digest },
  };
}

export type FormalCatalogPreview = Awaited<ReturnType<typeof readFormalCatalogPreview>>;
