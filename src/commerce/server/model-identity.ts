import {createHash} from 'node:crypto';
import type {Model} from './models';
// Never include credentials. This binds a quote to the actual model and price.
function canonical(value:unknown):unknown{if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return value;}
export function modelIdentity(m:Model){return createHash('sha256').update(JSON.stringify(canonical({id:m.id,kind:m.kind,source:m.source,protocol:m.protocol||'',endpoint:m.endpoint||'',modelName:m.modelName||'',displayName:m.displayName,publicPrice:m.publicPrice,costPrice:m.costPrice,billingUnit:m.billingUnit,configHash:m.configHash,capabilities:m.capabilities}))).digest('hex');}
export class ModelChangedBeforeDispatch extends Error {constructor(){super('模型配置或费用已经变更，请重新查看费用后确认');}}
