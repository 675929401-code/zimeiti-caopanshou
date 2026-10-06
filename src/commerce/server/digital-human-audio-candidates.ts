import {assets,publicAsset,type Asset} from './assets';
import {voiceJobs,type CommerceVoiceJob} from './voice-jobs';

export const COMMERCE_DIGITAL_HUMAN_AUDIO_BRIDGE_VERSION='commerce-digital-human-audio-bridge/v1' as const;
export const DIGITAL_HUMAN_AUDIO_MAX_BYTES=30*1024*1024;

const DIGITAL_HUMAN_AUDIO_TYPES=new Set(['audio/mpeg','audio/wav','audio/x-wav']);

export type CommerceDigitalHumanAudioCandidate={
 id:string;
 name:string;
 type:string;
 size:number;
 sha256:string;
 createdAt:number;
 source:'upload'|'generated';
 jobId?:string;
 url:string;
 completionEvidence:'persisted-upload'|'voice-job-succeeded';
};

/**
 * Only expose byte-pinned audio that already has a terminal owner-scoped record.
 * Generated audio needs an exact succeeded voice-job receipt; uploaded audio is
 * complete once the immutable Commerce asset record exists.
 */
export function selectDigitalHumanAudioCandidates(
 owner:string,
 ownerAssets:readonly Asset[],
 ownerVoiceJobs:readonly CommerceVoiceJob[],
):CommerceDigitalHumanAudioCandidate[]{
 const succeededVoiceAssets=new Map(
  ownerVoiceJobs
   .filter(job=>job.owner===owner&&job.status==='succeeded'&&Boolean(job.assetId))
   .map(job=>[job.assetId!,job] as const),
 );
 return ownerAssets
  .filter(asset=>asset.owner===owner&&DIGITAL_HUMAN_AUDIO_TYPES.has(asset.type)&&asset.size>0&&asset.size<=DIGITAL_HUMAN_AUDIO_MAX_BYTES)
  .flatMap(asset=>{
   const voiceJob=asset.source==='generated'?succeededVoiceAssets.get(asset.id):undefined;
   if(asset.source==='generated'&&(!voiceJob||voiceJob.id!==asset.jobId||voiceJob.assetId!==asset.id))return [];
   const value=publicAsset(asset);
   return [{...value,completionEvidence:voiceJob?'voice-job-succeeded':'persisted-upload'} satisfies CommerceDigitalHumanAudioCandidate];
  })
  .sort((left,right)=>right.createdAt-left.createdAt||right.id.localeCompare(left.id));
}

export function listDigitalHumanAudioCandidates(owner:string){
 return selectDigitalHumanAudioCandidates(owner,assets(owner),voiceJobs(owner));
}
