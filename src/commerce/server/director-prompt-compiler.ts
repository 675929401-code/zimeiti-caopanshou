import {assertBenchmarkOriginalDirectorPrompt,directorPromptProvenance,type DirectorPromptSourceId} from './director-prompt-provenance';

export const DIRECTOR_VISIBLE_OUTPUT_HEADINGS=[
 '剧情梗概',
 '素材与职责',
 '主体与全片设定',
 '镜头 / 时间轴',
 '始终禁止'
] as const;

export type DirectorPromptLayerKind='common'|'category'|'skill'|'runtime';
export type DirectorPromptLayer={
 kind:DirectorPromptLayerKind;
 id:string;
 content:string;
 sourceId:DirectorPromptSourceId;
};

const LAYER_ORDER:DirectorPromptLayerKind[]=['common','category','skill','runtime'];

function normalizeLayer(layer:DirectorPromptLayer){
 const content=layer.content.trim();
 if(!content)throw new Error(`超级编导提示词层 ${layer.id} 为空`);
 const provenance=directorPromptProvenance(layer.sourceId);
 if(provenance.kind==='benchmark-original')assertBenchmarkOriginalDirectorPrompt(layer.sourceId);
 return {...layer,content,provenance};
}

/** Compile the mirrored common -> category -> skill -> runtime contract. */
export function compileDirectorPromptLayers(layers:DirectorPromptLayer[]){
 const normalized=layers.map(normalizeLayer);
 let prior=-1;
 for(const layer of normalized){
  const current=LAYER_ORDER.indexOf(layer.kind);
  if(current<prior)throw new Error('超级编导提示词层顺序必须为 common → category → skill → runtime');
  prior=current;
 }
 return normalized.map(layer=>`【${layer.kind}:${layer.id}】\n${layer.content}`).join('\n\n');
}

export function compileIndependentDirectorPrompt(input:{common:string;category:string;skill:string;runtime:string}){
 return compileDirectorPromptLayers([
  {kind:'common',id:'commerce-safety',content:input.common,sourceId:'fire-agent-independent-core'},
  {kind:'category',id:'commerce-video',content:input.category,sourceId:'benchmark-reconstructed-core'},
  {kind:'skill',id:'director-skill',content:input.skill,sourceId:'benchmark-reconstructed-core'},
  {kind:'runtime',id:'turn-context',content:input.runtime,sourceId:'fire-agent-independent-core'}
 ]);
}

export function assertDirectorVisibleOutputFormat(value:string){
 const headings=[...value.matchAll(/^##\s+(.+)$/gmu)].map(match=>match[1].trim());
 if(headings.length!==DIRECTOR_VISIBLE_OUTPUT_HEADINGS.length||headings.some((heading,index)=>heading!==DIRECTOR_VISIBLE_OUTPUT_HEADINGS[index])){
  throw new Error(`超级编导可见输出必须严格使用五段结构：${DIRECTOR_VISIBLE_OUTPUT_HEADINGS.join(' → ')}`);
 }
 return value;
}
