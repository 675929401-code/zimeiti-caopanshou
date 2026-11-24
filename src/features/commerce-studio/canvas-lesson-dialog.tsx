'use client';
import {useEffect,useRef,useState} from 'react';

export const canvasLessons=[
 {name:'画布组件',steps:['填写一个文本节点，写下已确认的商品事实。','参考图用参考连线接入，文本用指令连线接入。练习画布包含两个输出节点，可分别编辑。','选择生成模型，运行前先查看每个节点的报价。保存后可从“我的创作”重开。']},
 {name:'智能编导',steps:['上传自己的参考视频，等待抽帧。没有声音的素材可直接拆解画面。','核对镜头分段与依据，再上传自己的商品图并核对商品事实。','查看编导报价，生成并编辑脚本，将满意的版本存入画布。']},
 {name:'图片创作',steps:['在“商品参考图”输入节点选择本人素材，或移除该节点做纯文字创作。','在文本节点写明构图、保留的细节与需要替换的元素。','选择图片生成节点设置模型和画幅，确认报价后生成。']},
 {name:'视频创作',steps:['在指令节点写下商品要做的动作、镜头与时长。','在参考图节点选择素材。纯文字视频可移除这个节点。','选择视频节点的模型、时长和画幅，核对报价后运行，完成后在节点查看视频。']}
];
export function CanvasLessonDialog({index,close,practice}:{index:number;close:()=>void;practice:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [showSteps,setShowSteps]=useState(false);
 useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close();},[]);
 const lesson=canvasLessons[index];
 return <dialog ref={dialog} className="cs-canvas-lesson" aria-labelledby="cs-canvas-lesson-title" onCancel={close} onClick={e=>{if(e.target!==dialog.current)return;const r=dialog.current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}}>
 <h2 hidden id="cs-canvas-lesson-title">{lesson.name}</h2>
 <button className="cs-lesson-close" onClick={close} aria-label="关闭教程">×</button>
 <video controls playsInline preload="metadata" poster={'/commerce/canvas-guide-'+(index+1)+'.jpg'} aria-label={lesson.name+'操作演示'} src={'/commerce/tutorial-'+(index+1)+'.mp4'}/>
 <div className="cs-lesson-actions"><button aria-expanded={showSteps} onClick={()=>setShowSteps(!showSteps)}>操作步骤</button>
 {showSteps&&<section><ol>{lesson.steps.map(step=><li key={step}>{step}</li>)}</ol><button onClick={practice}>{index===1?'打开智能编导':'打开练习画布'}</button></section>}</div></dialog>;
}
