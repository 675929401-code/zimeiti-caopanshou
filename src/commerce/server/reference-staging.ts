export const cameraPatterns=['fixed','push_in','pull_back','pan','follow','handheld','unspecified'] as const;
export const motionPatterns=['hold','hand_enters','grasp','open','close','press','lift','place','rotate','slide','unfold','fold','use','release','hand_leaves','reveal'] as const;
type Camera=(typeof cameraPatterns)[number];
type Motion=(typeof motionPatterns)[number];
export type ShotStaging={camera:Camera;beats:{frameId:string;action:Motion}[]};

export function parseShotStaging(raw:unknown,frameIds:readonly string[]):ShotStaging|undefined {
  if(raw===undefined)return undefined;
  const v=raw as Partial<ShotStaging>|null;
  if(!v||!cameraPatterns.includes(v.camera as Camera)||!Array.isArray(v.beats)||v.beats.length>32)throw Error('镜头调度结构无效');
  let last=-1;
  const beats=v.beats.map(beat=>{
    const pos=frameIds.indexOf(beat?.frameId);
    if(pos<0||pos<last||!motionPatterns.includes(beat?.action))throw Error('动作须按先后引用本镜头证据帧');
    last=pos;
    return {frameId:beat.frameId,action:beat.action};
  });
  return {camera:v.camera as Camera,beats};
}

// Old projects have no per-action timestamps. Extract only neutral, observed movement.
export function transferableStaging(shot:{camera:string;action:string;staging?:ShotStaging},frames:readonly {id:string;timeSeconds:number}[],scale:number){
  if(shot.staging)return {camera:shot.staging.camera,beats:shot.staging.beats.map(beat=>{
    const frame=frames.find(f=>f.id===beat.frameId);
    if(!frame)throw Error('镜头引用的原片抽帧已变化，请重新拆解');
    return {action:beat.action,targetAt:Math.round(frame.timeSeconds*scale*100)/100};
  })};
  const camera:Camera=/固定|静止机位/.test(shot.camera)?'fixed':'unspecified';
  const patterns:[RegExp,Motion][]=[[/静止|保持不动/,'hold'],[/手(?:从.{0,8})?入画|手进入|入画的手/,'hand_enters'],[/捏住|握住|抓住|持捏/,'grasp'],[/掀起|向上翻开|打开至/,'open'],[/向下压合|合拢|逐渐闭合|直至闭合|完全闭合/,'close'],[/手退出|手离开/,'hand_leaves']];
  const beats=patterns.map(([re,action])=>({index:shot.action.search(re),action})).filter(b=>b.index>=0).sort((a,b)=>a.index-b.index).map(b=>({action:b.action}));
  return {camera,beats};
}
