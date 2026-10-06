import type { CloneStatus } from '@/lib/types';

/**
 * Convert provider-specific voice-training states to the public API contract.
 * Volcengine V3 uses 1=training, 2=success, 3=failed, 4=available.
 */
export function normalizeVoiceTrainingStatus(value: unknown): CloneStatus {
  if (value === 1 || value === '1') return 'training';
  if (value === 2 || value === 4 || value === '2' || value === '4') return 'ready';
  if (value === 3 || value === '3') return 'failed';

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'training' || normalized === 'processing' || normalized === 'running') {
      return 'training';
    }
    if (normalized === 'ready' || normalized === 'success' || normalized === 'succeeded' || normalized === 'completed') {
      return 'ready';
    }
    if (normalized === 'failed' || normalized === 'error' || normalized === 'cancelled' || normalized === 'canceled') {
      return 'failed';
    }
  }

  return 'pending';
}

export function isVoiceTrainingReady(value: unknown): boolean {
  return normalizeVoiceTrainingStatus(value) === 'ready';
}

export function isVoiceTrainingFailed(value: unknown): boolean {
  return normalizeVoiceTrainingStatus(value) === 'failed';
}
