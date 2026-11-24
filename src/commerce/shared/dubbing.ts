export const dubSkills=['video-dub','speech-correction','voice-localize'] as const;
export type DubSkill=typeof dubSkills[number];
export const isDubSkill=(id:string):id is DubSkill=>dubSkills.some(value=>value===id);
export type DubLanguage='zh'|'en'|'th'|'vi';
export type DubView={id:string;status:string;progress:number;count:number;price:number;charged:boolean;error?:string;video?:{name:string;url:string};subtitles?:{name:string;url:string}};

