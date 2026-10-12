import { createHash } from 'node:crypto';

export class AgentPromptUnavailableError extends Error {
  readonly code = 'AGENT_SYSTEM_PROMPT_UNAVAILABLE';
  constructor() { super('智能体运行设定暂不可用，本次未调用模型'); }
}

/** Client fields never supply the prompt of a persisted marketplace agent. */
export function resolveAuthoritativeAgentPrompt(input: {
  hasPersistedAgent: boolean;
  serverPrompt: unknown;
  publishedPrompt?: string;
  authorizedInternalWorkflow: boolean;
  workflowPrompt?: unknown;
}): string {
  if (input.publishedPrompt?.trim()) return input.publishedPrompt;
  if (input.hasPersistedAgent) {
    if (typeof input.serverPrompt !== 'string' || !input.serverPrompt.trim()) throw new AgentPromptUnavailableError();
    return input.serverPrompt;
  }
  if (input.authorizedInternalWorkflow && typeof input.workflowPrompt === 'string') return input.workflowPrompt;
  return '';
}

export function agentPromptAuditIdentity(prompt: string, revision: unknown) {
  const numericRevision = Number(revision);
  return {
    revision: Number.isSafeInteger(numericRevision) && numericRevision > 0 ? numericRevision : null,
    promptDigest: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    compositionVersion: 'agent-chat-prompt.v1',
  };
}

/** Only conversation roles are client data; privileged/tool roles are server-owned. */
export function clientChatHistory<T extends { role: string }>(messages: T[]): T[] {
  return messages.filter(message => message.role === 'user' || message.role === 'assistant');
}

/** Supabase resolves errors as data; awaiting a query alone is not success. */
export async function requireAssistantPersistence(query: PromiseLike<{ error: unknown }>): Promise<void> {
  const result = await query;
  if (result.error) throw new Error('LLM_ASSISTANT_PERSISTENCE_FAILED');
}
