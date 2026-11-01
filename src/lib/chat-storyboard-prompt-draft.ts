import { officialStoryboardDirectorIdentity } from './storyboard-director-identity';
import { configuredAgentPromptPushTarget, resolveAgentPromptPushTarget } from './storyboard-prompt-push-capability';
import { buildAgentStoryboardPromptDraftDetail } from './agent-storyboard-prompt-draft';
import { buildHomepageStoryboardDraftDetail, readStoryboardIntakeSnapshotForMessage, resolveStoryboardHandoffContract } from './agent-workbench-handoff';
import { buildHistoricalStoryboardMessageDraft } from './storyboard-legacy-prompt-draft';
import { isChatPromptDeliveryMessageReady } from './chat-prompt-delivery-state';
import type { Message } from '@/types/coze';

/** Manual text import is an explicit opt-in for ordinary agents. It cannot be a
 * fallback around a failed official director/intake/production contract. */
export function buildUnboundChatStoryboardPromptDraft(
  agentId: unknown, outputStyle: unknown,
  message: Parameters<typeof buildAgentStoryboardPromptDraftDetail>[0],
  hasOriginalIntake = false,
) {
  if (!isChatPromptDeliveryMessageReady(message) || hasOriginalIntake || officialStoryboardDirectorIdentity(agentId)
    || configuredAgentPromptPushTarget(outputStyle) !== 'storyboard-workbench'
    || resolveAgentPromptPushTarget(agentId, outputStyle) !== 'storyboard-workbench'
    || !outputStyle || typeof outputStyle !== 'object' || Array.isArray(outputStyle)) return null;
  const style = outputStyle as Record<string, unknown>;
  if (['production_contract_version', 'production_contract_activated_at', 'performance_contract', 'performance_contract_activated_at']
    .some(key => Object.hasOwn(style, key))) return null;
  return buildAgentStoryboardPromptDraftDetail(message);
}

/** Rebuild both content and its original-card contract from the latest state at
 * every click/async boundary. A matching text string alone is not authority. */
export function buildCurrentChatStoryboardPromptDetail(
  message: Pick<Message, 'id' | 'role' | 'content' | 'isStreaming' | 'error' | 'streamStatus'>,
  messages: ReadonlyArray<{ id: string; role: string; content: string; timestamp?: number }> | undefined,
  agentId: unknown, outputStyle: unknown,
) {
  if (!isChatPromptDeliveryMessageReady(message)) return null;
  const style = outputStyle && typeof outputStyle === 'object' && !Array.isArray(outputStyle) ? outputStyle as Record<string, unknown> : undefined;
  const contract = resolveStoryboardHandoffContract(messages, message.id, outputStyle);
  if (contract.error) return null;
  const intake = readStoryboardIntakeSnapshotForMessage(messages, message.id, style?.director_mode);
  return buildHomepageStoryboardDraftDetail(message, intake?.input, contract.requiredVersion, {
    previewAssetVerification: true, referenceProjectId: intake?.referenceProjectId,
    allowLegacyUnverified: contract.allowLegacyUnverified, requirePerformancePlan: contract.requirePerformancePlan, allowQualityWarnings: true,
  }) || buildHistoricalStoryboardMessageDraft(message, messages, intake?.input, outputStyle, contract.allowLegacyUnverified === true)
    || buildUnboundChatStoryboardPromptDraft(agentId, outputStyle, message, Boolean(intake));
}
