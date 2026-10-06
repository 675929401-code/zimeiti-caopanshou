import {findVoice,type SystemVoice} from './voice-catalog';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Voice synthesis input helpers. Provider execution remains disabled until a
 * voice model, price, route, quote and wallet lifecycle are published by the
 * main site. Audio replacement can still consume an already-owned audio asset. */
export type VoiceSynthesisRequest={
  owner:string;
  voiceId:string;
  text:string;
  targetVideoAssetId?:string;
};

export function resolveVoice(voiceId:string):SystemVoice{
  const voice=findVoice(voiceId);
  if(!voice)throw Error(`音色 ${voiceId} 不存在，请在音色目录中选择`);
  return voice;
}

export function validateSynthesisText(text:string){
  const trimmed=text.trim();
  if(!trimmed)throw Error('请填写要合成的文字');
  if(trimmed.length>5000)throw Error('合成文字超过5000字上限');
  return trimmed;
}

export function synthesisOutputDir(){
  const dir=path.join(process.env.COMMERCE_DATA_DIR||'.','voice-synthesis');
  fs.mkdirSync(dir,{recursive:true});
  return dir;
}

export function newSynthesisFileName(){return `voice-${crypto.randomUUID().slice(0,8)}.mp3`;}

/** Prevent legacy callers from constructing an unquoted provider request. */
export function buildVoiceSynthesisPayload(_voice:SystemVoice,_text:string):never{
  throw Error('VOICE_MODEL_CATALOG_NOT_READY');
}
