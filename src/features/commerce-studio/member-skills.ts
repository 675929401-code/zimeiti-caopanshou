import catalog from './member-skill-catalog.json';

export type MemberSkill = { id:string; name:string; description:string; detail?:string; category?:string; sort?:number; referenceVersion?:string; icon?:string; route?:string; instruction?:string };
export const builtinSkills:MemberSkill[]=catalog;
export type SkillLibrary={custom:MemberSkill[];installed:string[];stats?:Record<string,{installs:number;opens:number}>};
