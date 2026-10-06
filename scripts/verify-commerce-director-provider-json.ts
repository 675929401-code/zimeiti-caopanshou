import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {buildProviderRequest,directorProviderResponseFormat,providerUsesTextStream,type ProviderInput} from '../src/commerce/server/providers';
import type {Model} from '../src/commerce/server/models';

async function main(){
  const model:Model={id:'director-provider-fixture',displayName:'编导 JSON 模型',kind:'agent',source:'custom',publicPrice:1,costPrice:0.8,billingUnit:'per_use',configHash:'director-provider-v1',protocol:'openai-chat',endpoint:'https://example.invalid/v1',modelName:'fixture-chat',enabled:true,capabilities:{available:true,executionSupported:true}};
  const plain:ProviderInput={id:'11111111-1111-4111-8111-111111111111',prompt:'普通对话',messages:[{role:'user',content:'普通对话'}],images:[]};
  const structured={...plain,responseFormat:'json_object' as const};
  const plainRequest=buildProviderRequest(model,plain);
  const structuredRequest=buildProviderRequest(model,structured);
  assert.equal(plainRequest.body.response_format,undefined);
  assert.deepEqual(structuredRequest.body.response_format,{type:'json_object'});
  assert.equal(structuredRequest.body.stream,false);
  assert.equal(providerUsesTextStream(model,plain,true),true);
  assert.equal(providerUsesTextStream(model,structured,true),false);
  assert.equal(providerUsesTextStream({...model,protocol:'anthropic'},structured,true),false);
  assert.equal(directorProviderResponseFormat({kind:'agent',director:'ecommerce-promotion-conversion'}),'json_object');
  assert.equal(directorProviderResponseFormat({kind:'agent',director:'  '}),undefined);
  assert.equal(directorProviderResponseFormat({kind:'image',director:'ecommerce-promotion-conversion'}),undefined);
  const gateway=await fs.readFile(new URL('../src/app/api/commerce-model-gateway/route.ts',import.meta.url),'utf8');
  const jobs=await fs.readFile(new URL('../src/commerce/server/jobs.ts',import.meta.url),'utf8');
  assert.match(gateway,/input\.responseFormat!==undefined.*INVALID_RESPONSE_FORMAT/);
  assert.match(gateway,/input\.responseFormat==='json_object'.*response_format:\{type:'json_object'\}/);
  assert.match(jobs,/stream:value\.input\.kind==='agent'&&!responseFormat,responseFormat/);
  assert.match(jobs,/value\.input\.kind==='agent'&&!responseFormat\?text=>/);
  console.log(JSON.stringify({passed:13,networkCalls:0,paidCalls:0,checks:['plain-chat-unchanged','openai-json-object','structured-non-stream','plain-stream','structured-stream-disabled','anthropic-structured-stream-disabled','director-json-selected','blank-director-ignored','non-agent-ignored','gateway-validation','gateway-forwarding','main-route-non-stream','custom-route-non-stream']}));
}

main().catch(error=>{console.error(error);process.exitCode=1;});
