export type DirectorPromptSourceKind=
 |'independent-implementation'
 |'benchmark-observed'
 |'reverse-engineered'
 |'benchmark-original';

export type DirectorPromptEvidenceStatus='verified'|'derived'|'not-acquired';

export type DirectorPromptProvenance={
 id:string;
 label:string;
 kind:DirectorPromptSourceKind;
 status:DirectorPromptEvidenceStatus;
 benchmarkOriginal:boolean;
 note:string;
};

/**
 * Source registry for the commerce director prompt stack.
 *
 * The benchmark's public skill catalogue and mirrored admin chunks expose the
 * prompt compiler contract, but deliberately omit every private skill prompt.
 * Keep that boundary executable so reconstructed text can never be presented
 * or published as a verbatim benchmark prompt.
 */
export const DIRECTOR_PROMPT_PROVENANCE={
 'fire-agent-independent-core':{
  id:'fire-agent-independent-core',
  label:'带货 Agent 独立实现的编导核心',
  kind:'independent-implementation',
  status:'verified',
  benchmarkOriginal:false,
  note:'由本站自行搭建，不是对标网站原版提示词。'
 },
 'benchmark-19-skill-metadata':{
  id:'benchmark-19-skill-metadata',
  label:'对标站 19 项视频技能公开配置',
  kind:'benchmark-observed',
  status:'verified',
  benchmarkOriginal:false,
  note:'包含 skill_key、版本、分类、选项、素材槽和结果示例，不含 prompt。'
 },
 'benchmark-director-output-contract':{
  id:'benchmark-director-output-contract',
  label:'对标站超级编导真实输出格式',
  kind:'benchmark-observed',
  status:'verified',
  benchmarkOriginal:false,
  note:'来自真实生成结果与公开界面，只证明可见输出合同。'
 },
 'benchmark-reconstructed-core':{
  id:'benchmark-reconstructed-core',
  label:'对标站超级编导逆向重建稿',
  kind:'reverse-engineered',
  status:'derived',
  benchmarkOriginal:false,
  note:'根据教程、界面、真实输出和管理端编译结构重建，不是逐字原文。'
 },
 'benchmark-admin-original-prompts':{
  id:'benchmark-admin-original-prompts',
  label:'对标站管理员私有技能提示词',
  kind:'benchmark-original',
  status:'not-acquired',
  benchmarkOriginal:true,
  note:'镜像未包含管理员接口响应或数据库 payload.prompt，当前未取得。'
 }
} as const satisfies Record<string,DirectorPromptProvenance>;

export type DirectorPromptSourceId=keyof typeof DIRECTOR_PROMPT_PROVENANCE;

export function directorPromptProvenance(id:DirectorPromptSourceId):DirectorPromptProvenance{
 return DIRECTOR_PROMPT_PROVENANCE[id];
}

export function benchmarkOriginalDirectorPromptsAcquired(){
 const source:DirectorPromptProvenance=DIRECTOR_PROMPT_PROVENANCE['benchmark-admin-original-prompts'];
 return source.status==='verified';
}

export function assertBenchmarkOriginalDirectorPrompt(id:DirectorPromptSourceId){
 const source=directorPromptProvenance(id);
 if(source.kind!=='benchmark-original'||source.status!=='verified')throw new Error('19 个超级编导的对标站逐字原版提示词尚未取得，禁止标记或发布为 benchmark-original');
 return source;
}
