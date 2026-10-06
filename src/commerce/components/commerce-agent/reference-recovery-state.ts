import type {MaterialReference} from './material-recovery';

export type RecoveryKind='image'|'video'|'agent';
export type RecoverySnapshot={kind:RecoveryKind;materials:MaterialReference[]};
export type RecoveryAttempt<T extends RecoverySnapshot>={id:number;kind:RecoveryKind;snapshot:T;status:'loading'|'failed'|'paused';error:string;controller:AbortController};

/** Keep the saved intent separate from transient empty/loading material views. */
export class ReferenceRecoveryState<T extends RecoverySnapshot>{
 private values=new Map<RecoveryKind,RecoveryAttempt<T>>();
 private versions=new Map<RecoveryKind,number>();
 private alive=true;
 get(kind:RecoveryKind){return this.values.get(kind);}
 epoch(kind:RecoveryKind){return this.versions.get(kind)||0;}
 begin(snapshot:T,persist:(value:T)=>void){
  if(!this.alive)throw Error('工作室已关闭');
  const copy=structuredClone(snapshot);
  // A failed local write must not erase the current editor or its active attempt.
  persist(copy);
  this.cancel(snapshot.kind);
  const attempt:RecoveryAttempt<T>={id:this.epoch(snapshot.kind),kind:snapshot.kind,snapshot:copy,status:'loading',error:'',controller:new AbortController()};
  this.values.set(snapshot.kind,attempt);return attempt;
 }
 active(attempt:RecoveryAttempt<T>){return this.alive&&this.values.get(attempt.kind)===attempt&&attempt.status==='loading'&&!attempt.controller.signal.aborted;}
 update(kind:RecoveryKind,snapshot:T){const value=this.get(kind);if(value)value.snapshot=structuredClone({...snapshot,materials:value.snapshot.materials});}
 fail(attempt:RecoveryAttempt<T>,message:string){if(!this.active(attempt))return false;attempt.status='failed';attempt.error=message;return true;}
 finish(attempt:RecoveryAttempt<T>){if(!this.active(attempt))return false;this.values.delete(attempt.kind);return true;}
 pause(kind:RecoveryKind){const value=this.get(kind);if(!value||value.status!=='loading')return false;value.status='paused';value.error='已暂停素材恢复，返回后可重试。';value.controller.abort();return true;}
 cancel(kind:RecoveryKind){this.get(kind)?.controller.abort();this.values.delete(kind);this.versions.set(kind,this.epoch(kind)+1);}
 dispose(){this.alive=false;for(const kind of ['image','video','agent'] as const)this.cancel(kind);}
}
