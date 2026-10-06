import {get,put} from './store';
import {gateway,modelSecret,type Model,type Kind} from './models';
import {publicFetch} from './assets';

export async function probeModel(id:string,kind:Kind){
 let result:Record<string,unknown>;
 if(id.startsWith('custom_')){
  const model=get<Model>('models',id,'system');
  if(!model||model.kind!==kind)throw Error('模型配置不存在');
  const root=String(model.endpoint).replace(/\/$/,'').replace(/\/v1$/,'');
  const key=await modelSecret(id);
  const response=await publicFetch(root+'/v1/models',{headers:{Authorization:`Bearer ${key}`,...(model.protocol==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{})}});
  const data=await response.json().catch(()=>({}));
  const names=Array.isArray(data.data)?data.data.map((m:{id?:unknown})=>String(m.id||'')).filter(Boolean).slice(0,500):[];
  result={status:response.status,keyConfigured:true,configuredModel:model.modelName,endpointHost:new URL(root).hostname,modelListed:names.includes(model.modelName),models:names,generationSubmitted:false};
 }else result=await gateway({action:'probe',id:crypto.randomUUID(),kind,modelId:id});
 const record={id,kind,checkedAt:Date.now(),...result,generationSubmitted:false};
 put('model-probes',id,'system',record);
 return record;
}
