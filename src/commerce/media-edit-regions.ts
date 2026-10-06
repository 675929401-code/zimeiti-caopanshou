export type EraseTool = 'watermark' | 'subtitle' | 'mosaic';
export type EraseRegion = {x:number;y:number;width:number;height:number};
export const ERASE_MAX_DURATION = 30;
export const ERASE_MIN_EDGE = .03;
export const ERASE_MAX_AREA = .5;
export const defaultEraseRegion = (tool:EraseTool):EraseRegion => tool==='watermark'
 ? {x:.78,y:.04,width:.18,height:.10} : tool==='mosaic' ? {x:.38,y:.18,width:.24,height:.30} : {x:.08,y:.74,width:.84,height:.20};

export function validateEraseRegions(tool:EraseTool, value:unknown):EraseRegion[] {
 const maximum=tool==='watermark'||tool==='mosaic'?4:1;
 if(!Array.isArray(value)||value.length<1||value.length>maximum)throw Error(tool==='subtitle'?'字幕擦除只能选择 1 个区域':'请选择 1 至 4 个打码/擦除区域');
 const regions=value.map(item=>{
  if(!item||typeof item!=='object')throw Error('请选择有效的擦除区域');
  const {x,y,width,height}=item as EraseRegion;
  if([x,y,width,height].some(v=>typeof v!=='number'||!Number.isFinite(v))||x<0||y<0||x+width>1+1e-9||y+height>1+1e-9)throw Error('擦除区域必须位于画面内，坐标范围为 0 至 1');
  if(width<ERASE_MIN_EDGE-1e-9||height<ERASE_MIN_EDGE-1e-9)throw Error('擦除区域的宽、高均不能小于画面的 3%');
  return {x,y,width,height};
 });
 // Match the public UI: overlapping rectangles are counted separately.
 if(regions.reduce((sum,region)=>sum+region.width*region.height,0)>ERASE_MAX_AREA+1e-9)throw Error('擦除区域总面积不能超过画面的 50%');
 return regions;
}

export function validateEraseDuration(duration:number):void {
 if(!Number.isFinite(duration)||duration<=0)throw Error('无法读取视频时长，请上传有效的视频文件');
 if(duration>ERASE_MAX_DURATION)throw Error('擦除工具暂只支持 30 秒以内的视频，请重新选择素材');
}
