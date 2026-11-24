import { createCommerceJobQuote } from './quotes';
import { selectedModel } from './models';
import { modelIdentity } from './model-identity';
import { assistRouteIdentity } from './prompt-assist-claim';
import { get, put } from './store';
import type { JobInput } from './jobs';
import type { AssistSession } from './prompt-assist';
import type { AssistStage } from './reference-video-schema';

type Input = Omit<JobInput, 'modelId'>;
type Snapshot = { input: Omit<JobInput,'requestId'>; taskRequestId: string; modelId: string; modelConfigHash: string };

export async function quoteAssistStep(owner: string, session: AssistSession, stage: AssistStage, input: Input) {
  const priced = await createCommerceJobQuote(owner, input);
  const frozen = get<Snapshot>('commerce-quotes', priced.id, owner);
  if (!frozen?.taskRequestId || frozen.input.modelId !== frozen.modelId) throw Error('统一报价任务快照缺失');
  const model = await selectedModel('agent', frozen.modelId);
  if (model.configHash !== frozen.modelConfigHash) throw Error('模型配置已变更，请重新报价');
  const claimedInput = {...frozen.input, requestId:frozen.taskRequestId};
  put('prompt-assist-quotes', input.requestId, owner, {
    id:input.requestId, owner, sessionId:session.id, revision:session.revision, stage, input:claimedInput,
    modelName:model.displayName, modelFingerprint:modelIdentity(model), routeFingerprint:assistRouteIdentity(claimedInput),
    estimatedPrice:priced.payableTotal, expiresAt:priced.expiresAt,
  });
  return {...priced,stage};
}
