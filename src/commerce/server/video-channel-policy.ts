import {commerceUnitRate} from './main-site-model-pricing';
import type {Model} from './models';

export function videoInputBillingIssue(model:Pick<Model,'internalModelId'>, sourceVideos:number) {
  // This group bills both the input footage and the requested output (rounded by the supplier).
  return sourceVideos>0 && model.internalModelId==='secure-skill-kling-video-v4-g68'
    ? '此渠道还需按源视频时长结算，当前无法准确报价' : '';
}

export function comparableVideoCost(model:Model,resolution:string|null,duration:number|null,segments:number|null) {
  if(!duration || !segments || model.billingUnit==='token')return null;
  try {
    const rate=commerceUnitRate({kind:'video',resolution:resolution||undefined},model,'cost');
    if(!Number.isFinite(rate)||rate<0||rate===0&&model.capabilities.explicitlyFree!==true)return null;
    return Math.round(rate*(model.billingUnit==='per_use'?segments:duration)*1e6)/1e6;
  } catch {return null;}
}

type ChannelChoice={
  compatible:boolean;
  executable:boolean;
  releasedAndReady:boolean;
  cost:number|null;
  billingUnit:Model['billingUnit'];
  secureSkill:boolean;
};

// Inputs are already grouped by exact upstream SKU. Keep stable order on a full tie.
export function compareVideoChannels(a:ChannelChoice,b:ChannelChoice) {
  const eligibility=Number(b.compatible)-Number(a.compatible)
    ||Number(b.executable)-Number(a.executable)
    ||Number(b.releasedAndReady)-Number(a.releasedAndReady);
  if(eligibility)return eligibility;
  if(a.cost!==null && b.cost!==null && a.cost!==b.cost)return a.cost-b.cost;
  return Number(b.cost!==null)-Number(a.cost!==null)
    ||Number(b.billingUnit==='output_second')-Number(a.billingUnit==='output_second')
    ||Number(b.secureSkill)-Number(a.secureSkill);
}
