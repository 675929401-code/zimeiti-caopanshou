import {createHash} from 'node:crypto';
import observedCatalog from '../components/commerce-agent/observed-catalog.json';
import {IMAGE_SKILLS} from '../components/commerce-agent/catalog';
import {baselineDirectorCatalog,findDirectorCard} from './director-catalog';
import type {CommercePromptPackageIdentity} from '../shared/configuration-types';
import type {PromptTemplate} from './prompts';

type PromptPackageInput={kind:'agent'|'image'|'video';purpose?:string;director?:string;skillId?:string};
type ObservedImageSkill={key:string;name:string;default?:boolean;version:number;benchmarkConfigVersion:string;benchmarkSkillPackVersionId:string};
type ObservedDirectorSkill={key:string;name:string;default?:boolean;benchmarkConfigVersion:string};

const observedImages=observedCatalog.images as ObservedImageSkill[];
const observedDirectors=observedCatalog.directors as ObservedDirectorSkill[];

function stableJson(value:unknown):string{
 if(value===undefined)return 'null';
 if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,nested])=>`${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`;
 return JSON.stringify(value);
}

function hash(value:unknown):string{return createHash('sha256').update(typeof value==='string'?value:stableJson(value)).digest('hex');}

function imageContract(localId:string){
 const skill=IMAGE_SKILLS.find(item=>item.id===localId)||(localId==='default'?IMAGE_SKILLS[0]:undefined);
 if(!skill)throw Error(`图片技能 ${localId} 不存在，无法冻结提示词版本`);
 const benchmark=skill.id==='default'?observedImages.find(item=>item.default):observedImages.find(item=>item.name===skill.name);
 if(!benchmark?.benchmarkConfigVersion||!benchmark.benchmarkSkillPackVersionId)throw Error(`图片技能 ${localId} 缺少对标目录版本身份`);
 return{skill,benchmark};
}

function directorContract(keyOrName:string){
 const baseline=baselineDirectorCatalog(),builtIn=baseline.find(item=>item.key===keyOrName||item.name===keyOrName)||(keyOrName==='默认编导'?baseline.find(item=>item.default):undefined);
 const effective=builtIn||findDirectorCard(keyOrName);
 if(!effective)throw Error(`超级编导 ${keyOrName} 不存在，无法冻结提示词版本`);
 const benchmark=observedDirectors.find(item=>item.key===effective.key);
 if(builtIn&&!benchmark?.benchmarkConfigVersion)throw Error(`超级编导 ${effective.key} 缺少对标目录版本身份`);
 return{effective,benchmark};
}

export function resolveCommercePromptPackageIdentity(input:PromptPackageInput,options:{prompt:Pick<PromptTemplate,'id'|'version'|'content'>;promptVersionId?:string;authority:'published-release'|'curated-main-catalog'|'legacy-local'}):CommercePromptPackageIdentity{
 const promptContentSha256=hash(options.prompt.content);
 let skillKind:CommercePromptPackageIdentity['skillKind']='generic';
 let localSkillId=options.prompt.id;
 let skillContractSha256=hash({kind:'generic',promptId:options.prompt.id});
 let benchmarkReference:CommercePromptPackageIdentity['benchmarkReference'];
 if(input.kind==='image'){
  const {skill,benchmark}=imageContract(input.skillId||'default');
  skillKind='image-skill';localSkillId=skill.id;skillContractSha256=hash(skill);
  benchmarkReference={source:'benchmark-observed-catalog',contractOnly:true,skillId:benchmark.key,configVersion:benchmark.benchmarkConfigVersion,versionId:benchmark.benchmarkSkillPackVersionId,version:benchmark.version};
 }else if(input.kind==='agent'&&input.purpose==='director'){
  const {effective,benchmark}=directorContract(input.director||'default-director');
  skillKind='director-skill';localSkillId=effective.key;skillContractSha256=effective.catalogVersion||hash(effective);
  if(benchmark)benchmarkReference={source:'benchmark-observed-catalog',contractOnly:true,skillId:benchmark.key,configVersion:benchmark.benchmarkConfigVersion};
 }
 const promptVersionId=options.promptVersionId||`catalog:${options.prompt.id}:v${options.prompt.version}:${promptContentSha256.slice(0,16)}`;
 const unsigned={schema:'commerce-prompt-package/v1' as const,authority:options.authority,skillKind,localSkillId,promptVersionId,promptVersion:options.prompt.version,promptContentSha256,skillContractSha256,...(benchmarkReference?{benchmarkReference}:{})};
 return{...unsigned,packageSha256:hash(unsigned)};
}

export function sameCommercePromptPackageIdentity(left:CommercePromptPackageIdentity|undefined,right:CommercePromptPackageIdentity|undefined):boolean{
 return Boolean(left&&right&&left.schema==='commerce-prompt-package/v1'&&right.schema==='commerce-prompt-package/v1'&&left.packageSha256===right.packageSha256&&hash(Object.fromEntries(Object.entries(left).filter(([key])=>key!=='packageSha256')))===left.packageSha256&&hash(Object.fromEntries(Object.entries(right).filter(([key])=>key!=='packageSha256')))===right.packageSha256);
}

export function commercePromptPackageCatalogCoverage(){
 return{
  image:{local:IMAGE_SKILLS.length,benchmark:observedImages.length,identified:IMAGE_SKILLS.filter(skill=>{try{imageContract(skill.id);return true;}catch{return false;}}).length},
  director:{local:baselineDirectorCatalog().length,benchmark:observedDirectors.length,identified:baselineDirectorCatalog().filter(card=>{try{directorContract(card.key);return true;}catch{return false;}}).length},
 };
}
