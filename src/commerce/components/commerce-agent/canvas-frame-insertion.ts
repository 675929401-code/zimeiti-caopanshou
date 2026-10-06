export type CanvasExtractedFrame={assetId:string;index:number;time:number};
export function planFrameInsertion<T extends {id:string}>(nodes:T[],frames:CanvasExtractedFrame[],taskId:string,makeNode:(frame:CanvasExtractedFrame,index:number,id:string)=>T,limit=100):T[]{
 if(!taskId||frames.some(frame=>!frame.assetId||!Number.isInteger(frame.index)||frame.index<0||!Number.isFinite(frame.time)||frame.time<0)||new Set(frames.map(frame=>frame.index)).size!==frames.length)throw Error('提帧结果格式无效，请核对原任务');
 const existing=new Set(nodes.map(node=>node.id));
 const missing=frames.map((frame,index)=>({frame,index,id:`frame:${taskId}:${frame.index}`})).filter(frame=>!existing.has(frame.id));
 if(nodes.length+missing.length>limit)throw Error(`这次结果还需 ${missing.length} 个节点，画布只剩 ${Math.max(0,limit-nodes.length)} 个位置。提帧结果已保留，请腾出位置后再应用。`);
 return [...nodes,...missing.map(({frame,index,id})=>makeNode(frame,index,id))];
}
