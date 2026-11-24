export const isSocialVideoSkill=(id:string)=>['douyin-download','douyin-collect','multi-download'].includes(id);
export type SocialVideoResult={platform?:'douyin'|'xiaohongshu';mediaLink?:boolean;id:string;workId:string;status:string;price:number;charged:boolean;title?:string;caption?:string;likes?:number;error?:string;asset?:{id:string;url:string;name:string}};
