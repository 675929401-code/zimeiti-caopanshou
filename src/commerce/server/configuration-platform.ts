import { createHash } from 'node:crypto';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { sharedConfigurationEnabled } from '@/storage/database/configuration-source';
import type {
  CommerceCardVersion,
  CommerceKnowledgeDocument,
  CommercePromptVersion,
  CommerceReleaseManifest,
  CommerceRoutePolicy,
  PublishedCommerceConfiguration,
  PublicCommerceCard,
} from '../shared/configuration-types';
import {isCuratedConfigurationSelectable} from './commerce-curated-model-profiles';

type Row = Record<string, unknown>;
type CacheState = { value?: PublishedCommerceConfiguration; checkedAt: number; error?: string };
const globalState = globalThis as unknown as { commerceConfigurationCache?: CacheState };
const cache = globalState.commerceConfigurationCache ||= { checkedAt: 0 };
const CACHE_MS = 15_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredIds(value: unknown, label: string): string[] {
  const ids = strings(value);
  if (ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) throw Error(`COMMERCE_CONFIG_INVALID_${label}`);
  return ids;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function manifestHash(manifest: CommerceReleaseManifest): string {
  return createHash('sha256').update(stableJson(manifest)).digest('hex');
}

function parseManifest(value: unknown): CommerceReleaseManifest {
  const raw = object(value);
  if (raw.schema !== 'commerce-config/v1') throw Error('COMMERCE_CONFIG_SCHEMA_UNSUPPORTED');
  const defaults = object(raw.defaultModels);
  const defaultModels: CommerceReleaseManifest['defaultModels'] = {};
  for (const kind of ['agent', 'image', 'video'] as const) {
    if (typeof defaults[kind] === 'string' && defaults[kind]) defaultModels[kind] = String(defaults[kind]);
  }
  return {
    schema: 'commerce-config/v1',
    cardVersionIds: requiredIds(raw.cardVersionIds, 'CARD_IDS'),
    promptVersionIds: requiredIds(raw.promptVersionIds, 'PROMPT_IDS'),
    knowledgeDocumentIds: requiredIds(raw.knowledgeDocumentIds, 'KNOWLEDGE_IDS'),
    operationRouteIds: requiredIds(raw.operationRouteIds, 'ROUTE_IDS'),
    defaultModels,
  };
}

function card(row: Row, cardKey: string): CommerceCardVersion {
  return {
    id: String(row.id), cardId: String(row.card_id), stableKey: cardKey, version: Number(row.version),
    display: object(row.display) as unknown as CommerceCardVersion['display'],
    materialSlots: (Array.isArray(row.material_slots) ? row.material_slots : []) as CommerceCardVersion['materialSlots'],
    inputFields: (Array.isArray(row.input_fields) ? row.input_fields : []) as CommerceCardVersion['inputFields'],
    executorType: row.executor_type as CommerceCardVersion['executorType'],
    promptVersionId: typeof row.prompt_version_id === 'string' ? row.prompt_version_id : null,
    knowledgeDocumentIds: strings(row.knowledge_document_ids),
    outputContract: object(row.output_contract), qualityRules: object(row.quality_rules), modelPolicy: object(row.model_policy),
    videoDefaults: object(row.video_defaults), testCases: Array.isArray(row.test_cases) ? row.test_cases : [],
    status: row.status as CommerceCardVersion['status'], validationResult: object(row.validation_result),
  };
}

function prompt(row: Row): CommercePromptVersion {
  return { id: String(row.id), promptKey: String(row.prompt_key), version: Number(row.version), name: String(row.name), content: String(row.content), source: String(row.source), status: row.status as CommercePromptVersion['status'] };
}

function knowledge(row: Row): CommerceKnowledgeDocument {
  return { id: String(row.id), knowledgeKey: String(row.knowledge_key), version: Number(row.version), name: String(row.name), content: String(row.content), enabled: row.enabled === true, applicableCardKeys: strings(row.applicable_card_keys), status: row.status as CommerceKnowledgeDocument['status'] };
}

function route(row: Row): CommerceRoutePolicy {
  return { id: String(row.id), operationId: String(row.operation_id), version: Number(row.version), label: String(row.label), modelKind: row.model_kind as CommerceRoutePolicy['modelKind'], primaryModelId: String(row.primary_model_id || ''), fallbackModelIds: strings(row.fallback_model_ids), capabilityRequirements: object(row.capability_requirements), userSelectable: row.user_selectable === true, status: row.status as CommerceRoutePolicy['status'] };
}

async function rowsByIds(table: string, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const { data, error } = await getSupabaseAdminClient().from(table).select('*').in('id', ids);
  if (error) throw Error(`COMMERCE_CONFIG_${table.toUpperCase()}_UNAVAILABLE`);
  const rows = (data || []) as Row[];
  if (rows.length !== ids.length) throw Error(`COMMERCE_CONFIG_${table.toUpperCase()}_INCOMPLETE`);
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows.sort((a, b) => Number(order.get(String(a.id))) - Number(order.get(String(b.id))));
}

export async function primePublishedCommerceConfiguration(options: { force?: boolean; required?: boolean } = {}): Promise<PublishedCommerceConfiguration | null> {
  const required = options.required ?? sharedConfigurationEnabled();
  if (!sharedConfigurationEnabled() && !required && !options.force) return cache.value || null;
  if (!options.force && cache.value && !cache.error && Date.now() - cache.checkedAt < CACHE_MS) return cache.value;
  try {
    const { data: release, error } = await getSupabaseAdminClient().from('commerce_config_releases').select('*').eq('is_current', true).eq('status', 'published').limit(1).maybeSingle();
    if (error) throw Error('COMMERCE_CONFIG_RELEASE_UNAVAILABLE');
    if (!release) {
      cache.value = undefined;
      cache.checkedAt = Date.now(); cache.error = 'COMMERCE_CONFIG_RELEASE_MISSING';
      if (required) throw Error(cache.error);
      return null;
    }
    const manifest = parseManifest(release.manifest);
    const calculated = manifestHash(manifest);
    if (calculated !== release.manifest_sha256) throw Error('COMMERCE_CONFIG_RELEASE_HASH_MISMATCH');
    const [cardRows, promptRows, knowledgeRows, routeRows] = await Promise.all([
      rowsByIds('commerce_card_versions', manifest.cardVersionIds),
      rowsByIds('commerce_prompt_versions', manifest.promptVersionIds),
      rowsByIds('commerce_knowledge_documents', manifest.knowledgeDocumentIds),
      rowsByIds('commerce_operation_routes', manifest.operationRouteIds),
    ]);
    const cardIds = [...new Set(cardRows.map((row) => String(row.card_id)))];
    const { data: cards, error: cardsError } = cardIds.length
      ? await getSupabaseAdminClient().from('commerce_cards').select('id, stable_key, status').in('id', cardIds)
      : { data: [], error: null };
    if (cardsError || (cards || []).length !== cardIds.length) throw Error('COMMERCE_CONFIG_CARD_IDENTITIES_INCOMPLETE');
    const keys = new Map<string, string>(((cards || []) as Row[]).map((row) => [String(row.id), String(row.stable_key)]));
    const releaseValidation = object(release.validation_result);
    const migrationBaseline = releaseValidation.migrationBaseline === true;
    const value: PublishedCommerceConfiguration = {
      releaseId: String(release.id), releaseVersion: Number(release.release_version), manifestSha256: calculated,
      publishedAt: String(release.published_at || release.created_at),
      validationMode: migrationBaseline ? 'migration-baseline' : 'full',
      paidJobsReady: releaseValidation.ok === true && !migrationBaseline,
      cards: cardRows.map((row) => card(row, keys.get(String(row.card_id)) || '')),
      prompts: promptRows.map(prompt), knowledge: knowledgeRows.map(knowledge), routes: routeRows.map(route),
      defaultModels: manifest.defaultModels,
    };
    const invalidSelectableRoute=value.routes.some((item)=>item.userSelectable&&item.modelKind!=='video'&&![item.primaryModelId,...item.fallbackModelIds].every(modelId=>isCuratedConfigurationSelectable(item.modelKind,modelId)));
    if (value.cards.some((item) => !item.stableKey) || invalidSelectableRoute) throw Error('COMMERCE_CONFIG_RELEASE_INVALID');
    cache.value = value; cache.checkedAt = Date.now(); cache.error = undefined;
    return value;
  } catch (error) {
    cache.value = undefined;
    cache.checkedAt = Date.now(); cache.error = error instanceof Error ? error.message : 'COMMERCE_CONFIG_UNAVAILABLE';
    if (required) throw error;
    return null;
  }
}

export function currentPublishedCommerceConfiguration(): PublishedCommerceConfiguration | null {
  return cache.value || null;
}

export function assertPublishedCommercePaidJobsReady(): void {
  if (cache.value && !cache.value.paidJobsReady) throw Error('COMMERCE_CONFIG_PAID_JOBS_NOT_READY');
}

export function invalidatePublishedCommerceConfiguration(): void {
  cache.checkedAt = 0;
}

export function commerceConfigurationStatus() {
  return { enabled: sharedConfigurationEnabled(), loaded: Boolean(cache.value), releaseId: cache.value?.releaseId, releaseVersion: cache.value?.releaseVersion, manifestSha256: cache.value?.manifestSha256, checkedAt: cache.checkedAt, error: cache.error };
}

export function publicCommerceCard(value: CommerceCardVersion): PublicCommerceCard {
  return {
    key: value.stableKey, version: value.version, name: value.display.name, description: value.display.description,
    category: value.display.category, icon: value.display.icon, recommended: value.display.recommended,
    sortOrder: value.display.sortOrder,
    slots: value.materialSlots.map((slot) => ({ key: slot.id, label: slot.label, responsibility: slot.responsibility, min: slot.minCount, max: slot.maxCount, kinds: [...slot.mediaTypes], maxFileBytes: slot.maxFileBytes, minDurationSeconds: slot.minDurationSeconds, maxDurationSeconds: slot.maxDurationSeconds, cover: slot.cover || '' })),
    inputFields: value.inputFields,
  };
}

export function promptWithKnowledge(promptVersionId: string | null, knowledgeIds: string[]): { prompt?: CommercePromptVersion; knowledge: CommerceKnowledgeDocument[] } {
  const config = currentPublishedCommerceConfiguration();
  if (!config) return { knowledge: [] };
  return {
    prompt: config.prompts.find((item) => item.id === promptVersionId),
    knowledge: knowledgeIds.map((id) => config.knowledge.find((item) => item.id === id)).filter((item): item is CommerceKnowledgeDocument => Boolean(item?.enabled)),
  };
}
