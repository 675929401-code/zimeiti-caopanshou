import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { HOME_QUICK_TOOLS, IMAGE_SKILLS, SCENARIOS } from '../components/commerce-agent/catalog';

type Row = Record<string, unknown>;
type CacheState = { value?: PublishedHomeCatalog; checkedAt: number; error?: string };
const globalState = globalThis as unknown as { commerceHomeCatalogCache?: CacheState };
const cache = (globalState.commerceHomeCatalogCache ||= { checkedAt: 0 });
const CACHE_MS = 15_000;

export type HomeCatalogKind = 'scenario' | 'image_skill' | 'quick_tool';
export type HomeScenario = (typeof SCENARIOS)[number];
export type HomeImageSkill = (typeof IMAGE_SKILLS)[number];
export type HomeQuickTool = (typeof HOME_QUICK_TOOLS)[number] & { icon: string };
export type PublishedHomeCatalog = {
  scenarios: HomeScenario[];
  imageSkills: HomeImageSkill[];
  quickTools: HomeQuickTool[];
  publishedEntries: number;
  checkedAt: number;
};
export type HomeCatalogEntryRow = {
  entryKind: HomeCatalogKind;
  entryKey: string;
  draftPayload: Record<string, unknown> | null;
  publishedPayload: Record<string, unknown> | null;
  publishedVersion: number;
  status: 'active' | 'disabled';
  changeNote: string;
  updatedAt: string;
  publishedAt: string | null;
};

const QUICK_TOOL_ICONS = ['canvas', 'editor', 'enhance', 'watermark', 'subtitle', 'character'];
const BASELINE_KEYS: Record<HomeCatalogKind, readonly string[]> = {
  scenario: SCENARIOS.map((item) => item.id),
  image_skill: IMAGE_SKILLS.map((item) => item.id),
  // 稳定英文 key 承担持久化主键；中文名只是显示文案。
  quick_tool: QUICK_TOOL_ICONS,
};
const PAYLOAD_KEYS: Record<HomeCatalogKind, ReadonlySet<string>> = {
  scenario: new Set(['name', 'description', 'image', 'prompt', 'stages', 'sortOrder', 'hidden']),
  image_skill: new Set(['name', 'description', 'category', 'sortOrder', 'hidden']),
  quick_tool: new Set(['name', 'sortOrder', 'hidden']),
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw Error('字段必须为文本');
  const cleaned = value.trim();
  if (cleaned.length > max) throw Error(`字段超过 ${max} 字`);
  return cleaned;
}
export function validateHomeCatalogPayload(kind: HomeCatalogKind, raw: unknown): Record<string, unknown> {
  const input = object(raw);
  const allowed = PAYLOAD_KEYS[kind];
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw Error(`不支持的展示字段 ${key}`);
  const payload: Record<string, unknown> = {};
  const name = text(input.name, 40);
  if (name !== undefined) {
    if (!name) throw Error('名称不能为空');
    payload.name = name;
  }
  const description = text(input.description, 120);
  if (description !== undefined) payload.description = description;
  const category = text(input.category, 40);
  if (category !== undefined) {
    if (!category) throw Error('分类不能为空');
    payload.category = category;
  }
  const image = text(input.image, 500);
  if (image !== undefined) {
    if (image && !image.startsWith('/')) throw Error('图片地址必须是站内路径');
    payload.image = image;
  }
  const prompt = text(input.prompt, 2000);
  if (prompt !== undefined) payload.prompt = prompt;
  if (input.stages !== undefined) {
    if (!Array.isArray(input.stages) || input.stages.length > 10) throw Error('步骤最多 10 条');
    payload.stages = input.stages.map((stage) => {
      const value = text(stage, 60);
      if (!value) throw Error('步骤不能为空');
      return value;
    });
  }
  if (input.sortOrder !== undefined) {
    const sortOrder = Number(input.sortOrder);
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999) throw Error('排序必须是 0-999 的整数');
    payload.sortOrder = sortOrder;
  }
  if (input.hidden !== undefined) {
    if (typeof input.hidden !== 'boolean') throw Error('隐藏标记必须为布尔值');
    payload.hidden = input.hidden;
  }
  if (!Object.keys(payload).length) throw Error('草稿内容为空');
  return payload;
}
export function homeCatalogBaselineKeys(kind: HomeCatalogKind): readonly string[] {
  return BASELINE_KEYS[kind];
}

type EntryRecord = {
  entry_kind: HomeCatalogKind;
  entry_key: string;
  draft_payload: unknown;
  published_payload: unknown;
  published_version: number;
  status: 'active' | 'disabled';
  change_note: string;
  updated_at: string;
  published_at: string | null;
};

function rowToEntry(row: EntryRecord): HomeCatalogEntryRow {
  return {
    entryKind: row.entry_kind,
    entryKey: row.entry_key,
    draftPayload: row.draft_payload ? object(row.draft_payload) : null,
    publishedPayload: row.published_payload ? object(row.published_payload) : null,
    publishedVersion: Number(row.published_version) || 0,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    changeNote: String(row.change_note || ''),
    updatedAt: String(row.updated_at || ''),
    publishedAt: row.published_at ? String(row.published_at) : null,
  };
}

function overlay<T extends Record<string, unknown>>(baseline: T, payload: Record<string, unknown> | null): T {
  if (!payload) return baseline;
  const merged = { ...baseline };
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'sortOrder' || key === 'hidden') continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}
function ordered<T>(items: { value: T; index: number; payload: Record<string, unknown> | null }[]): T[] {
  return items
    .filter((item) => item.payload?.hidden !== true)
    .sort((a, b) => {
      const left = typeof a.payload?.sortOrder === 'number' ? (a.payload.sortOrder as number) : a.index;
      const right = typeof b.payload?.sortOrder === 'number' ? (b.payload.sortOrder as number) : b.index;
      return left - right || a.index - b.index;
    })
    .map((item) => item.value);
}

function buildPublished(entries: HomeCatalogEntryRow[], checkedAt: number): PublishedHomeCatalog {
  const published = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (entry.status !== 'active' || !entry.publishedPayload) continue;
    published.set(`${entry.entryKind}:${entry.entryKey}`, entry.publishedPayload);
  }
  const scenarios = ordered(
    SCENARIOS.map((value, index) => {
      const payload = published.get(`scenario:${value.id}`) || null;
      return { value: overlay(value as unknown as Record<string, unknown>, payload) as unknown as HomeScenario, index, payload };
    }),
  );
  const imageSkills = ordered(
    IMAGE_SKILLS.map((value, index) => {
      const payload = published.get(`image_skill:${value.id}`) || null;
      return { value: overlay(value as unknown as Record<string, unknown>, payload) as unknown as HomeImageSkill, index, payload };
    }),
  );
  const quickTools = ordered(
    HOME_QUICK_TOOLS.map((value, index) => {
      const payload = published.get(`quick_tool:${QUICK_TOOL_ICONS[index]}`) || null;
      const withIcon = { ...value, icon: `/commerce/home-tools/${QUICK_TOOL_ICONS[index] || 'canvas'}.svg` } as HomeQuickTool;
      return { value: overlay(withIcon as unknown as Record<string, unknown>, payload) as unknown as HomeQuickTool, index, payload };
    }),
  );
  return { scenarios, imageSkills, quickTools, publishedEntries: published.size, checkedAt };
}

async function loadEntries(): Promise<HomeCatalogEntryRow[]> {
  const { data, error } = await getSupabaseAdminClient().from('commerce_home_catalog_entries').select('*');
  if (error) {
    // Table not yet migrated locally must never break the member homepage.
    if (String(error.code) === '42P01' || /does not exist/i.test(error.message)) return [];
    throw Error(`HOME_CATALOG_UNAVAILABLE:${error.message}`);
  }
  return ((data || []) as EntryRecord[]).map(rowToEntry);
}

export async function primePublishedHomeCatalog(options: { force?: boolean } = {}): Promise<PublishedHomeCatalog> {
  if (!options.force && cache.value && !cache.error && Date.now() - cache.checkedAt < CACHE_MS) return cache.value;
  try {
    const value = buildPublished(await loadEntries(), Date.now());
    cache.value = value;
    cache.checkedAt = Date.now();
    cache.error = undefined;
    return value;
  } catch (error) {
    cache.checkedAt = Date.now();
    cache.error = error instanceof Error ? error.message : 'HOME_CATALOG_UNAVAILABLE';
    // Fail open to the code baseline: display config must not block creation.
    return buildPublished([], Date.now());
  }
}
export function invalidateHomeCatalog(): void {
  cache.checkedAt = 0;
}

export async function homeCatalogAdminOverview() {
  const entries = await loadEntries();
  const byKey = new Map(entries.map((entry) => [`${entry.entryKind}:${entry.entryKey}`, entry]));
  const groups = (Object.keys(BASELINE_KEYS) as HomeCatalogKind[]).map((kind) => ({
    kind,
    items: BASELINE_KEYS[kind].map((key) => ({
      key,
      baseline: kind === 'scenario'
        ? object(SCENARIOS.find((item) => item.id === key))
        : kind === 'image_skill'
          ? object(IMAGE_SKILLS.find((item) => item.id === key))
          : object(HOME_QUICK_TOOLS[QUICK_TOOL_ICONS.indexOf(key)]),
      entry: byKey.get(`${kind}:${key}`) || null,
    })),
  }));
  return { groups, unknownEntries: entries.filter((entry) => !BASELINE_KEYS[entry.entryKind].includes(entry.entryKey)) };
}

function assertBaselineKey(kind: HomeCatalogKind, key: string): void {
  if (!BASELINE_KEYS[kind]?.includes(key)) throw Error('条目键不在基线目录中；新增功能卡片请走卡片中心');
}

export async function saveHomeCatalogDraft(actorId: string, raw: Row) {
  const kind = String(raw.kind || '') as HomeCatalogKind;
  const key = String(raw.key || '').trim();
  if (!PAYLOAD_KEYS[kind]) throw Error('条目类型无效');
  assertBaselineKey(kind, key);
  const payload = validateHomeCatalogPayload(kind, raw.payload);
  const db = getSupabaseAdminClient();
  const existing = await db.from('commerce_home_catalog_entries').select('*').eq('entry_kind', kind).eq('entry_key', key).maybeSingle();
  if (existing.error) throw Error(`读取条目失败：${existing.error.message}`);
  const now = new Date().toISOString();
  const changeNote = String(raw.changeNote || '').trim().slice(0, 200);
  if (existing.data) {
    const updated = await db.from('commerce_home_catalog_entries')
      .update({ draft_payload: payload, change_note: changeNote, updated_by: actorId, updated_at: now })
      .eq('entry_kind', kind).eq('entry_key', key).select('*').single();
    if (updated.error) throw Error(`保存草稿失败：${updated.error.message}`);
    return rowToEntry(updated.data as EntryRecord);
  }
  const inserted = await db.from('commerce_home_catalog_entries')
    .insert({ entry_kind: kind, entry_key: key, draft_payload: payload, change_note: changeNote, updated_by: actorId, updated_at: now })
    .select('*').single();
  if (inserted.error) throw Error(`保存草稿失败：${inserted.error.message}`);
  return rowToEntry(inserted.data as EntryRecord);
}

export async function publishHomeCatalogEntry(actorId: string, raw: Row) {
  const kind = String(raw.kind || '') as HomeCatalogKind;
  const key = String(raw.key || '').trim();
  if (!PAYLOAD_KEYS[kind]) throw Error('条目类型无效');
  assertBaselineKey(kind, key);
  const db = getSupabaseAdminClient();
  const existing = await db.from('commerce_home_catalog_entries').select('*').eq('entry_kind', kind).eq('entry_key', key).maybeSingle();
  if (existing.error || !existing.data) throw Error('条目还没有草稿，请先保存草稿');
  const record = existing.data as EntryRecord;
  if (!record.draft_payload) throw Error('条目还没有草稿，请先保存草稿');
  const now = new Date().toISOString();
  const updated = await db.from('commerce_home_catalog_entries')
    .update({
      published_payload: record.draft_payload,
      published_version: Number(record.published_version) + 1,
      published_at: now,
      status: 'active',
      updated_by: actorId,
      updated_at: now,
    })
    .eq('entry_kind', kind).eq('entry_key', key)
    .eq('published_version', Number(record.published_version))
    .select('*').maybeSingle();
  if (updated.error || !updated.data) throw Error('条目在发布期间已变化，请重新读取');
  invalidateHomeCatalog();
  return rowToEntry(updated.data as EntryRecord);
}

export async function setHomeCatalogEntryStatus(actorId: string, raw: Row) {
  const kind = String(raw.kind || '') as HomeCatalogKind;
  const key = String(raw.key || '').trim();
  const status = String(raw.status || '');
  if (!PAYLOAD_KEYS[kind]) throw Error('条目类型无效');
  assertBaselineKey(kind, key);
  if (!['active', 'disabled'].includes(status)) throw Error('状态无效');
  const db = getSupabaseAdminClient();
  const existing = await db.from('commerce_home_catalog_entries').select('entry_kind').eq('entry_kind', kind).eq('entry_key', key).maybeSingle();
  if (existing.error) throw Error(`读取条目失败：${existing.error.message}`);
  if (!existing.data) {
    if (status === 'active') throw Error('条目仍使用基线展示，无需恢复');
    const inserted = await db.from('commerce_home_catalog_entries')
      .insert({ entry_kind: kind, entry_key: key, status: 'disabled', updated_by: actorId, updated_at: new Date().toISOString() })
      .select('*').single();
    if (inserted.error) throw Error(`停用失败：${inserted.error.message}`);
    invalidateHomeCatalog();
    return rowToEntry(inserted.data as EntryRecord);
  }
  const updated = await db.from('commerce_home_catalog_entries')
    .update({ status, updated_by: actorId, updated_at: new Date().toISOString() })
    .eq('entry_kind', kind).eq('entry_key', key).select('*').single();
  if (updated.error) throw Error(`更新状态失败：${updated.error.message}`);
  invalidateHomeCatalog();
  return rowToEntry(updated.data as EntryRecord);
}

export async function resetHomeCatalogEntry(actorId: string, raw: Row) {
  const kind = String(raw.kind || '') as HomeCatalogKind;
  const key = String(raw.key || '').trim();
  if (!PAYLOAD_KEYS[kind]) throw Error('条目类型无效');
  assertBaselineKey(kind, key);
  const removed = await getSupabaseAdminClient().from('commerce_home_catalog_entries').delete().eq('entry_kind', kind).eq('entry_key', key);
  if (removed.error) throw Error(`恢复默认失败：${removed.error.message}`);
  invalidateHomeCatalog();
  return { entryKind: kind, entryKey: key, reset: true, updatedBy: actorId };
}
