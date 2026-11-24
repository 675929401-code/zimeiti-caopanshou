import {toPublicModelId} from '../../lib/public-model-dto';
import type {Kind,Model} from './models';

const internalId='705eab71-df2d-4e4d-ab1d-ab2de6cc8ddd';
const publicId=()=>toPublicModelId('llm',internalId);
const assistOperations=new Set(['prompt-assist.analyze','prompt-assist.breakdown','prompt-assist.script','prompt-assist.remix-script']);

type Binding={id:string;kind:Kind;userSelectable?:boolean;modelId:string;fallbackModelIds?:readonly string[]};
type DirectorCard={stableKey:string;executorType:string};
export function fixedAssistBinding(route:Binding|undefined,cards:readonly DirectorCard[]=[]){
  const director=route?.id.startsWith('director.')&&cards.some(card=>card.executorType==='director'&&route.id==='director.'+card.stableKey);
  return !!route && route.kind==='agent' && (assistOperations.has(route.id)||route.id==='agent.chat'||route.id==='detail-set.analyze'||director===true) && route.userSelectable===false
    && [internalId,publicId()].includes(route.modelId)
    && (route.fallbackModelIds||[]).every(id=>id===internalId||id===publicId());
}

type WorkflowInput={purpose?:string;assistQuoteId?:string;detailQuoteId?:string;directorTurn?:{operationId:string;conversationId:string;settings:{skillKey:string}};conversationId?:string};
export function matchesFixedWorkflowRequest(id:string,input:WorkflowInput,requestId?:string){
  if(id==='agent.chat')return input.purpose==='agent'&&typeof input.conversationId==='string'&&/^[a-f0-9-]{36}$/i.test(input.conversationId);
  if(!requestId)return false;
  if(id==='detail-set.analyze')return input.purpose===id&&input.detailQuoteId===requestId;
  if(assistOperations.has(id))return input.purpose===id&&input.assistQuoteId===requestId;
  const turn=input.directorTurn;
  return !!turn&&input.purpose==='director'&&turn.operationId===requestId&&turn.conversationId===input.conversationId&&id==='director.'+turn.settings.skillKey;
}

export function fixedAssistModel(model:Model) {
  return model.kind==='agent' && model.source==='main' && model.id===publicId()
    && model.internalModelId===internalId && model.modelName==='deepseek-v4-flash';
}
