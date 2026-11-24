import {transferableStaging} from './reference-staging';
import type {AssistSession} from './prompt-assist';
import {readAsset} from './assets';
import {offerClosing,requireCompleteOffer} from '../shared/group-buy-offer';
import {referenceScenes,referenceBriefVersion} from '../shared/reference-scenes';
import {rewriteAngles} from '../shared/reference-copy';

export function referenceScriptInput(session: AssistSession) {
  const breakdown=session.breakdown;
  if (!breakdown || !session.referenceVideo || !session.analysis) throw Error('请先核对参考结构和当前商品');
  if (session.config.sceneKey==='offer'&&!session.offer) throw Error('请先补充团购资料');
  if (session.offer) requireCompleteOffer(session.offer);
  const base=session.versions?.find(version=>version.id===(session.currentVersionId || session.revisionBaseId));
  const sameProduct=base?.sourceAnalysisJobId===session.analysisJobId && base?.analysis?.product===session.analysis.product
    && base?.sourceBreakdownJobId===session.breakdownJobId && JSON.stringify(base?.references)===JSON.stringify(session.references);
  // Pass only evidence-bound timing, narrative roles and product-neutral motion.
  const rhythm=breakdown.shots.map((shot,index)=>({
    start:shot.start, end:shot.end,
    targetStart:Math.round(100*shot.start*session.videoSettings.duration/breakdown.sourceDurationSeconds)/100,
    targetEnd:Math.round(100*shot.end*session.videoSettings.duration/breakdown.sourceDurationSeconds)/100,
    staging:session.originalApproach?undefined:transferableStaging(shot,session.preparation?.evidence?.frames||[],session.videoSettings.duration/breakdown.sourceDurationSeconds),
    roles:breakdown.semantics?.filter(beat=>beat.shotIndex===index).map(beat=>beat.role) || [],
  }));
  return {
    task:(session.originalApproach?'根据拆解出的叙事作用重建原创短片。只迁移吸引注意、提出问题、兑现利益和收束等有证据的功能。使用当前商品和新人物动线重新设计每个镜头，不照搬原片机位、台词或动作。按目标时间交付全部镜头，不虚构商品事实。只返回 outputSchema。':'以当前商品事实重写镜头。按 rhythm 的目标时间、叙事作用、机位与动作先后逐镜创作。fixed 表示固定机位，不能擅自环绕、推拉。具体写出初态、手或主体的动作、最终状态；演示镜头必须确实执行动作。按当前商品的结构实现：只有商品支持的动作可以保留，无对应结构则用可见事实支持的等效演示，不移植原商品的外观、部件或宣传用语。上版仅作为同一商品的改稿基准，本轮新事实优先。只返回 outputSchema。')+
      (session.offer?'套餐的固定交易口播、字幕、核销结尾由工作台从已确认资料合成。请为末镜留足时间，其余正文仅设计场景、展示与动作，不另写交易条款。':''),
    projectId:session.id, referenceRevision:session.referenceRevision, sourceBreakdownJobId:session.breakdownJobId,
    sourceVideoAssetId:session.referenceVideo.assetId, sourceVideoSha256:session.referenceVideo.sha256,
    sourceAnalysisJobId:session.analysisJobId, analysisPayloadSnapshot:session.analysis, analysisEdited:session.analysisEdited,
    referenceElements:session.references.map((ref,i)=>({id:ref.id,slot:ref.slot,mentionLabel:'@图片'+(i+1),fileName:readAsset(ref.id,session.owner)?.name})),
    videoSettings:session.videoSettings, ...session.config, rewriteAngle:rewriteAngles[session.rewriteAngle||'problem'],
    candidateCount:1, rhythm, sceneBrief:session.config.sceneKey?{key:session.config.sceneKey,version:referenceBriefVersion,objective:referenceScenes[session.config.sceneKey][2]}:undefined, sourceStyle:{shootingMethod:breakdown.shootingMethod,contentType:breakdown.contentType},
    ...(sameProduct&&base?{previousScript:{versionId:base.id,text:base.script,previousFacts:base.analysis,previousOffer:base.offer}}:{}),
    ...(session.offer?{offer:session.offer,closing:offerClosing(session.offer,session.videoSettings.generateAudio)}:{}),
    outputSchema:{style:'基于当前商品的风格和连续性',targetDurationSeconds:session.videoSettings.duration,shots:rhythm.map(beat=>({
      start:beat.targetStart,end:beat.targetEnd,prompt:'新商品的具体镜头和动作',referenceAssetIds:session.references.map(ref=>ref.id),
      sound:session.videoSettings.generateAudio?'planned':'none',voiceover:'',
    }))},
  };
}
