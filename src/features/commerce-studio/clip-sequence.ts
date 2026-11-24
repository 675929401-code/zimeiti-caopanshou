export type ClipRange={start:number;end:number};

export function clipSequence(value:unknown):ClipRange[]{
  if(!Array.isArray(value)||value.length>16)throw Error('剪辑列表最多支持 16 段');
  let total=0;
  return value.map((entry,index)=>{
    if(!entry||typeof entry!=='object')throw Error('剪辑片段格式无效');
    const {start,end}=entry;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>300)throw Error('第 '+(index+1)+' 段时间范围无效');
    total+=end-start;
    if(total>300)throw Error('导出成片合计最长 300 秒');
    return {start,end};
  });
}
