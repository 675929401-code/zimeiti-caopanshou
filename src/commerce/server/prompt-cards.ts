/**
 * 提示词卡片登记的读写（s19）。表名 commerce_prompt_cards 与列名均为草案：
 * 本阶段只在本机自建测试库里建表与写入；生产库无此表、无迁移，接口读取失败时返回 503，不白屏。
 * 写入只经 importPromptCards，且逐行先过 promptCardRowIssues；没有对外的写接口（规格 §6：权限确认前不开放编辑）。
 */
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { promptCardRowIssues, type PromptCardRow } from '../shared/prompt-card-registry';

export const PROMPT_CARD_TABLE = 'commerce_prompt_cards';

type QueryResult = { data: unknown; error: { message: string } | null };
interface PromptCardQuery extends PromiseLike<QueryResult> {
  select(columns?: string): PromptCardQuery;
  order(column: string, options?: { ascending?: boolean }): PromptCardQuery;
  limit(count: number): PromptCardQuery;
  upsert(values: unknown, options?: { onConflict?: string }): PromptCardQuery;
}
export interface PromptCardClient { from(table: string): unknown }

const table = (client: PromptCardClient) => client.from(PROMPT_CARD_TABLE) as PromptCardQuery;

export async function listPromptCards(client: PromptCardClient = getSupabaseAdminClient() as unknown as PromptCardClient): Promise<PromptCardRow[]> {
  const result = await table(client).select('*').order('card_id', { ascending: true }).limit(500);
  if (result.error) throw Error(`提示词卡片表不可用：${result.error.message}`);
  const rows = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
  const bad = rows.flatMap((row) => promptCardRowIssues(row));
  if (bad.length) throw Error(`提示词卡片数据不合规：${bad.slice(0, 3).join('；')}`);
  return rows as unknown as PromptCardRow[];
}

/** 种子导入：全部行先校验，任一行不合规则整批拒绝，不写入任何一行。 */
export async function importPromptCards(rows: Record<string, unknown>[], actorId: string, client: PromptCardClient = getSupabaseAdminClient() as unknown as PromptCardClient): Promise<{ written: number }> {
  if (!actorId.trim()) throw Error('导入人必填');
  const ids = rows.map((row) => String(row.card_id));
  if (new Set(ids).size !== ids.length) throw Error('card_id 重复');
  const issues = rows.flatMap((row) => promptCardRowIssues(row));
  if (issues.length) throw Error(`整批拒绝：${issues.join('；')}`);
  const importedAt = new Date().toISOString();
  const values = rows.map((row) => ({ ...row, imported_by: actorId, imported_at: importedAt }));
  const result = await table(client).upsert(values, { onConflict: 'card_id' });
  if (result.error) throw Error(`写入提示词卡片失败：${result.error.message}`);
  return { written: values.length };
}
