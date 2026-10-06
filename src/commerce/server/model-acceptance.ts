import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import type { Kind, Model } from './models';

export type CommerceModelAcceptanceEvidence = {
  modelKind: Kind;
  modelId: string;
  modelConfigHash: string;
  verifiedAt: string;
  canaryJobId: string;
  evidenceSummary: Record<string, unknown>;
};

type Cache = { checkedAt: number; rows: CommerceModelAcceptanceEvidence[] };
type AcceptanceEventRow = Record<string, unknown> & { model_kind: Kind; model_id: string; model_config_hash: string; status: 'passed' | 'invalidated' };
const globalCache = globalThis as unknown as { commerceModelAcceptanceCache?: Cache };
const cache = globalCache.commerceModelAcceptanceCache ||= { checkedAt: 0, rows: [] };
const CACHE_MS = 15_000;

export function commerceModelAcceptanceKey(kind: Kind, modelId: string, configHash: string) {
  return `${kind}:${modelId}:${configHash}`;
}

/** Input must be newest-first. Only the latest event for an exact model hash is authoritative. */
export function currentPassedAcceptanceRows(rows: AcceptanceEventRow[]) {
  const latest = new Map<string, AcceptanceEventRow>();
  for (const row of rows) {
    const key = commerceModelAcceptanceKey(row.model_kind, String(row.model_id), String(row.model_config_hash));
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()].filter(row => row.status === 'passed');
}

export async function commerceModelAcceptanceEvidence(force = false): Promise<CommerceModelAcceptanceEvidence[]> {
  if (!force && cache.checkedAt && Date.now() - cache.checkedAt < CACHE_MS) return cache.rows;
  const { data, error } = await getSupabaseAdminClient().from('commerce_model_acceptance_evidence')
    .select('model_kind,model_id,model_config_hash,status,verified_at,created_at,canary_job_id,evidence_summary')
    .order('verified_at', { ascending: false }).order('created_at', { ascending: false }).limit(1000);
  if (error) throw Error(`COMMERCE_MODEL_ACCEPTANCE_UNAVAILABLE:${error.message}`);
  cache.rows = currentPassedAcceptanceRows((data || []) as AcceptanceEventRow[]).map((row) => ({
    modelKind: row.model_kind as Kind,
    modelId: String(row.model_id),
    modelConfigHash: String(row.model_config_hash),
    verifiedAt: String(row.verified_at),
    canaryJobId: String(row.canary_job_id),
    evidenceSummary: row.evidence_summary && typeof row.evidence_summary === 'object' && !Array.isArray(row.evidence_summary)
      ? row.evidence_summary as Record<string, unknown> : {},
  }));
  cache.checkedAt = Date.now();
  return cache.rows;
}

export async function commerceModelAcceptanceIndex(force = false) {
  return new Map((await commerceModelAcceptanceEvidence(force)).map(row => [
    commerceModelAcceptanceKey(row.modelKind, row.modelId, row.modelConfigHash), row,
  ]));
}

export async function requireCommerceModelAcceptance(model: Model, label = '该模型') {
  const index = await commerceModelAcceptanceIndex();
  const evidence = index.get(commerceModelAcceptanceKey(model.kind, model.id, model.configHash));
  if (!evidence) throw Error(`${label}尚未完成当前配置哈希的带货真实 canary`);
  return evidence;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A generic video canary only proves that a provider can return one video.
 * Deep clone needs stronger evidence from the same immutable model hash: the
 * canary must exercise a source video, a replacement image, a voice reference,
 * the audio-generation flag, persistent video output, and a real audio track.
 */
export function commerceDepthCloneAcceptanceIssues(evidence: CommerceModelAcceptanceEvidence | undefined): string[] {
  if (!evidence) return ['缺少当前配置哈希的真实生成证据'];
  const summary = record(evidence.evidenceSummary);
  const coverage = record(summary.inputCoverage);
  const output = record(summary.outputValidation);
  const issues: string[] = [];
  if (Number(coverage.referenceVideos || 0) < 1) issues.push('未验证源视频输入');
  if (Number(coverage.referenceImages || 0) < 1) issues.push('未验证替换参考图');
  if (Number(coverage.referenceAudios || 0) < 1) issues.push('未验证声音参考');
  if (!Number.isFinite(Number(coverage.duration)) || Number(coverage.duration) < 4) issues.push('未验证原生视频时长');
  if (coverage.generateAudio !== true) issues.push('未验证生成声音开关');
  if (!String(output.mimeType || '').startsWith('video/')) issues.push('结果不是已持久化视频');
  if (output.hasAudio !== true) issues.push('结果音轨未通过验证');
  return issues;
}

export function commerceDepthCloneAcceptancePassed(evidence: CommerceModelAcceptanceEvidence | undefined) {
  return commerceDepthCloneAcceptanceIssues(evidence).length === 0;
}

export async function requireCommerceDepthCloneAcceptance(model: Model, label = '深度复刻模型') {
  const evidence = await requireCommerceModelAcceptance(model, label);
  const issues = commerceDepthCloneAcceptanceIssues(evidence);
  if (issues.length) throw Error(`${label}尚未通过源视频、替换图与参考声音联合验收：${issues.join('；')}`);
  return evidence;
}

export function invalidateCommerceModelAcceptance() {
  cache.checkedAt = 0;
  cache.rows = [];
}
