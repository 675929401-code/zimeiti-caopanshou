import { createHash } from 'node:crypto';

export type VoiceTrainingOperation = 'clone' | 'design';
export type VoiceTrainingLifecycleState = 'provider_pending' | 'reconciliation_required';

export type VoiceTrainingJobRow = {
  id: number | string;
  user_id: string;
  job_key: string;
  operation_kind: VoiceTrainingOperation;
  request_fingerprint: string;
  status: 'pending' | 'reserved' | VoiceTrainingLifecycleState | 'completed' | 'released';
  provider_speaker_id?: string | null;
  voice_id?: string | null;
  result_payload?: Record<string, unknown> | null;
  reserved_used_after?: number | null;
  max_trainings?: number | null;
  provider_call_started_at?: string | null;
  provider_last_checked_at?: string | null;
  provider_last_status?: string | null;
  created_at?: string | null;
  reserved_at?: string | null;
  updated_at?: string | null;
};

type SupabaseLike = {
  from: (table: string) => any;
  rpc: (name: string, parameters: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

export function deriveVoiceTrainingSpeakerId(
  userId: string,
  jobKey: string,
  operation: VoiceTrainingOperation,
): string {
  const digest = createHash('sha256').update(`${userId}:${jobKey}`, 'utf8').digest('hex');
  return operation === 'clone' ? `S_${digest.slice(0, 24)}` : `D_${digest.slice(0, 28)}`;
}

export async function loadOwnedVoiceTrainingJob(
  db: SupabaseLike,
  userId: string,
  jobKey: string,
  operation: VoiceTrainingOperation,
): Promise<VoiceTrainingJobRow | null> {
  const { data, error } = await db
    .from('voice_training_authorization_jobs')
    .select('id,user_id,job_key,operation_kind,request_fingerprint,status,provider_speaker_id,voice_id,result_payload,reserved_used_after,max_trainings,provider_call_started_at,provider_last_checked_at,provider_last_status,created_at,reserved_at,updated_at')
    .eq('user_id', userId)
    .eq('job_key', jobKey)
    .eq('operation_kind', operation)
    .maybeSingle();
  if (error) throw new Error(error.message || 'VOICE_TRAINING_JOB_READ_FAILED');
  return data ? data as VoiceTrainingJobRow : null;
}

export async function markVoiceTrainingProviderAttempt(input: {
  db: SupabaseLike;
  userId: string;
  jobKey: string;
  operation: VoiceTrainingOperation;
  fingerprint: string;
  speakerId: string;
  lifecycleState: VoiceTrainingLifecycleState;
  providerStatus: string;
  resultPayload: Record<string, unknown>;
  providerCallStarted: boolean;
  reconciliationReason?: string;
}): Promise<VoiceTrainingJobRow> {
  const { data, error } = await input.db.rpc('mark_voice_training_provider_attempt_atomic', {
    p_user_id: input.userId,
    p_job_key: input.jobKey,
    p_operation_kind: input.operation,
    p_request_fingerprint: input.fingerprint,
    p_provider_speaker_id: input.speakerId,
    p_lifecycle_status: input.lifecycleState,
    p_provider_status: input.providerStatus.slice(0, 100),
    p_result_payload: input.resultPayload,
    p_provider_call_started: input.providerCallStarted,
    p_reconciliation_reason: (input.reconciliationReason || '').slice(0, 500),
  });
  if (error) throw new Error(error.message || 'VOICE_TRAINING_ATTEMPT_PERSIST_FAILED');
  const result = data as { success?: boolean; job?: VoiceTrainingJobRow } | null;
  if (!result?.success || !result.job) throw new Error('VOICE_TRAINING_ATTEMPT_PERSIST_INVALID');
  return result.job;
}

export async function claimVoiceTrainingProviderCall(input: {
  db: SupabaseLike;
  userId: string;
  jobKey: string;
  operation: VoiceTrainingOperation;
  fingerprint: string;
  speakerId: string;
  resultPayload: Record<string, unknown>;
}): Promise<{ claimed: boolean; job: VoiceTrainingJobRow }> {
  const { data, error } = await input.db.rpc('claim_voice_training_provider_call_atomic', {
    p_user_id: input.userId,
    p_job_key: input.jobKey,
    p_operation_kind: input.operation,
    p_request_fingerprint: input.fingerprint,
    p_provider_speaker_id: input.speakerId,
    p_result_payload: input.resultPayload,
  });
  if (error) throw new Error(error.message || 'VOICE_TRAINING_PROVIDER_CLAIM_FAILED');
  const result = data as { success?: boolean; claimed?: boolean; job?: VoiceTrainingJobRow } | null;
  if (!result?.success || !result.job) throw new Error('VOICE_TRAINING_PROVIDER_CLAIM_INVALID');
  return { claimed: result.claimed === true, job: result.job };
}

export async function releaseVoiceTrainingTerminal(input: {
  db: SupabaseLike;
  userId: string;
  jobKey: string;
  operation: VoiceTrainingOperation;
  fingerprint: string;
  terminalKind: 'not_started' | 'provider_failed';
  reason: string;
}): Promise<boolean> {
  const { data, error } = await input.db.rpc('release_voice_training_terminal_atomic', {
    p_user_id: input.userId,
    p_job_key: input.jobKey,
    p_operation_kind: input.operation,
    p_request_fingerprint: input.fingerprint,
    p_terminal_kind: input.terminalKind,
    p_reason: input.reason.slice(0, 500),
  });
  if (error) throw new Error(error.message || 'VOICE_TRAINING_TERMINAL_RELEASE_FAILED');
  return Boolean((data as { success?: boolean } | null)?.success);
}

export async function finalizeVoiceTrainingReady(input: {
  db: SupabaseLike;
  userId: string;
  jobKey: string;
  operation: VoiceTrainingOperation;
  fingerprint: string;
  speakerId: string;
  voiceName: string;
  language: string;
  sourceInfo: Record<string, unknown>;
  resultPayload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { data, error } = await input.db.rpc('finalize_voice_training_ready_atomic', {
    p_user_id: input.userId,
    p_job_key: input.jobKey,
    p_operation_kind: input.operation,
    p_request_fingerprint: input.fingerprint,
    p_speaker_id: input.speakerId,
    p_voice_name: input.voiceName,
    p_language: input.language,
    p_source_info: input.sourceInfo,
    p_result_payload: { ...input.resultPayload, status: 'ready' },
  });
  if (error) throw new Error(error.message || 'VOICE_TRAINING_READY_FINALIZE_FAILED');
  const result = data as Record<string, unknown> | null;
  if (!result?.success) throw new Error('VOICE_TRAINING_READY_FINALIZE_INVALID');
  return result;
}

export function isVoiceTrainingJobExpired(job: VoiceTrainingJobRow, now = Date.now(), timeoutMs = 30 * 60_000): boolean {
  const started = Date.parse(job.provider_call_started_at || job.reserved_at || job.created_at || '');
  return Number.isFinite(started) && now - started >= timeoutMs;
}
