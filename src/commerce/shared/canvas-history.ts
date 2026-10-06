import {normalizeCanvasGraph,type CanvasGraph} from './canvas-schema';
export type CanvasEdit=CanvasGraph&{title:string};
export const editSnapshot=(value:CanvasEdit):CanvasEdit=>({title:value.title,...normalizeCanvasGraph(value)});
export function canvasHistory(limit=100){let past:CanvasEdit[]=[],future:CanvasEdit[]=[];return {
 reset(){past=[];future=[];},get canUndo(){return past.length>0;},get canRedo(){return future.length>0;},
 record(before:CanvasEdit,after:CanvasEdit){const a=editSnapshot(before),b=editSnapshot(after);if(JSON.stringify(a)===JSON.stringify(b))return;past.push(a);if(past.length>limit)past.shift();future=[];},
 undo(current:CanvasEdit){const previous=past.pop();if(!previous)return null;future.push(editSnapshot(current));return previous;},
 redo(current:CanvasEdit){const next=future.pop();if(!next)return null;past.push(editSnapshot(current));return next;}
};}
