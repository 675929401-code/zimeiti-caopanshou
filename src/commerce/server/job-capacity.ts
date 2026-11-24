import {db} from './store';

const limit=3;
export const reconciliationCapacityMessage='账号有 3 笔生成任务的结果待核对。原任务确认后可继续提交生成。';

export function memberJobCapacity(owner:string, submission:'member'|'admin-canary'='member'){
  const counts=db().prepare(`SELECT count(*) AS active,
    count(CASE WHEN json_extract(j.value,'$.status')='unknown' THEN 1 END) AS unknown
    FROM records j WHERE j.bucket='jobs' AND j.owner=?
    AND json_extract(j.value,'$.status') IN ('queued','running','processing','saving','unknown')
    AND (?='admin-canary' OR json_extract(j.value,'$.status') <> 'unknown' OR NOT EXISTS (
      SELECT 1 FROM records q
      WHERE q.bucket IN ('model-canary-quotes','card-canary-quotes') AND q.owner=j.owner
        AND q.id=json_extract(j.value,'$.configurationSnapshot.quoteId')
        AND json_extract(q.value,'$.jobId')=j.id
        AND json_extract(q.value,'$.inputFingerprint')=json_extract(j.value,'$.configurationSnapshot.inputFingerprint')
    ))`).get(owner,submission)!;
  return {full:Number(counts.active)>=limit,requiresReconciliation:Number(counts.unknown)>=limit};
}

export class MemberJobCapacityError extends Error {
  constructor(public readonly requiresReconciliation:boolean){
    super(requiresReconciliation?reconciliationCapacityMessage:'当前有 3 个未结束的任务，请等待结果或先核对未知任务');
  }
}

/** Called within the job creation transaction. Existing requests still pass through the fingerprint check. */
export function assertMemberJobCapacity(owner:string,requestId:string,submission:'member'|'admin-canary'='member'){
  const capacity=memberJobCapacity(owner,submission);
  if(!capacity.full)return;
  if(db().prepare('SELECT 1 FROM requests WHERE request_key=?').get(owner+':'+requestId))return;
  throw new MemberJobCapacityError(capacity.requiresReconciliation);
}
