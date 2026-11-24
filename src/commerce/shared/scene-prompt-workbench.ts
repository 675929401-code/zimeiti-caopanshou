export type SceneCallStep={id:string;label:string;input:string;output:string;when:string;kind:'agent'|'image'|'video'|null;revision:number|null;primary:string;fallbacks:string[];selectable:boolean;stages:string[]};
export type SceneTrial={variant:string;label?:string;costBasis?:string;referenceName?:string;at:string;input:string;reply:string;cost:number;shots:number;continuous:boolean;apply:boolean;sha256:string};
export type ScenePromptEntry = {
 id:string; name:string; group:'视频场景'|'图片场景'|'画布专用'|'共用能力'; category:string;
 operation:string; calls?:SceneCallStep[]; executorPrompt?:{version:number;content:string}; key:string; model:string; effective:string; effectiveVersion:string; proposed:string;
 auxiliaryTrial?:{title:string;input:string;observed:string;status:string;picture?:string;sourcePicture?:string;reply?:string}; trials?:SceneTrial[]; teacher:string; evidence:string[]; sample?:{file:string;sha256:string;observed:string};
 example?:{title:string;description:string;images:string[]}; guide:string[]; test:string; stages:string[];
};
