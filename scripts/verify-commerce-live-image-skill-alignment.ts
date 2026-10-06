import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IMAGE_INPUT_CONTRACTS,IMAGE_PUBLIC_CATALOG_REVISION} from '../src/commerce/image-input-contract';
import {IMAGE_RAIL_ITEMS} from '../src/commerce/components/commerce-agent/image-rail-menu-data';

type EvidenceSlot={key:string;label:string;mediaTypes:string[];minCount:number;maxCount:number;required:boolean};
type EvidenceItem={key:string;label:string;version:number;configVersion:string;skillPackVersionId:string;isDefault:boolean;category:{label:string};sortOrder:number;recommended:boolean;recommendationOrder:number;surfaces:string[];inputContract:{prompt_required:boolean;min_text_references:number};referenceSlots:{mediaMaxCount:{image:number;video:number;audio:number};slots:EvidenceSlot[]}};
type LocalSlot={key:string;label:string;kinds:string[];min:number;max:number};
type LocalItem={key:string;name:string;version:number;description:string;category:string;recommended:boolean;default:boolean;order:number;surfaces:string[];promptRequired:boolean;benchmarkConfigVersion:string;benchmarkSkillPackVersionId:string;recommendationOrder:number;slots:LocalSlot[]};

const evidence=JSON.parse(readFileSync(new URL('../docs/带货Agent镜像融合-20260925/对标16图片技能实时目录只读证据.json',import.meta.url),'utf8')) as {schemaVersion:number;kind:string;source:{method:string;httpStatus:number};catalog:{schemaVersion:number;revision:number;toolSlug:string;itemCount:number;items:EvidenceItem[]};effects:Record<string,number>};
const local=JSON.parse(readFileSync(new URL('../src/commerce/components/commerce-agent/observed-catalog.json',import.meta.url),'utf8')) as {imageCatalogSchemaVersion:number;imageCatalogRevision:number;images:LocalItem[]};
let passed=0;
const check=(value:unknown,message:string)=>{assert.ok(value,message);passed+=1;};

check(evidence.schemaVersion===1&&evidence.kind==='authorized-readonly-live-image-skill-catalog-evidence','实时图片目录证据身份必须固定');
check(evidence.source.method==='GET'&&evidence.source.httpStatus===200,'实时图片目录必须来自成功的只读 GET');
check(Object.values(evidence.effects).every(value=>value===0||value===1),'证据副作用计数必须是只读捕获');
check(evidence.effects.networkGetRequests===1&&evidence.effects.writeRequests===0&&evidence.effects.paidGeneration===0,'证据捕获不得包含业务写入或付费生成');
check(evidence.catalog.schemaVersion===4&&evidence.catalog.toolSlug==='image-generation','图片技能目录 schema 与工具身份必须固定');
check(evidence.catalog.itemCount===16&&evidence.catalog.items.length===16,'实时图片目录必须恰好包含 16 个技能包');
check(local.images.length===16&&IMAGE_INPUT_CONTRACTS.length===16,'本站图片目录与服务端输入合同必须各有 16 项');
check(new Set(evidence.catalog.items.map(item=>item.key)).size===16,'实时图片技能 key 必须唯一');
check(new Set(evidence.catalog.items.map(item=>item.configVersion)).size===16,'16 个实时配置版本必须各自独立');
check(local.imageCatalogSchemaVersion===evidence.catalog.schemaVersion,'本站图片目录 schema 版本漂移');
check(local.imageCatalogRevision===evidence.catalog.revision&&IMAGE_PUBLIC_CATALOG_REVISION===evidence.catalog.revision,'本站图片目录 revision 漂移');

const localByKey=new Map(local.images.map(item=>[item.key,item]));
const contractByKey=new Map(IMAGE_INPUT_CONTRACTS.map(item=>[item.publicKey,item]));
for(const remote of evidence.catalog.items){
 const current=localByKey.get(remote.key),contract=contractByKey.get(remote.key);
 check(Boolean(current),`本站观察目录缺少图片技能 ${remote.key}`);
 check(Boolean(contract),`本站服务端输入合同缺少图片技能 ${remote.key}`);
 if(!current||!contract)continue;
 check(current.name===remote.label,`${remote.key} 名称漂移`);
 check(current.category===remote.category.label,`${remote.key} 分类漂移`);
 check(current.version===remote.version&&contract.publicVersion===remote.version,`${remote.key} 公开版本漂移`);
 check(current.default===remote.isDefault,`${remote.key} 默认身份漂移`);
 check(current.recommended===remote.recommended,`${remote.key} 推荐身份漂移`);
 check(current.order===remote.sortOrder,`${remote.key} 排序漂移`);
 check(current.recommendationOrder===remote.recommendationOrder,`${remote.key} 推荐排序漂移`);
 check(current.benchmarkConfigVersion===remote.configVersion,`${remote.key} 配置版本漂移`);
 check(current.benchmarkSkillPackVersionId===remote.skillPackVersionId,`${remote.key} 技能包版本身份漂移`);
 check(JSON.stringify(current.surfaces)===JSON.stringify(remote.surfaces),`${remote.key} 展示端漂移`);
 check(JSON.stringify(contract.surfaces)===JSON.stringify(remote.surfaces),`${remote.key} 可执行端展示边界漂移`);
 check(current.promptRequired===remote.inputContract.prompt_required&&contract.promptRequired===remote.inputContract.prompt_required,`${remote.key} 提示词必填边界漂移`);
 check(contract.minTextReferences===remote.inputContract.min_text_references,`${remote.key} 文本来源下限漂移`);
 check(contract.mediaMaxCount.image===remote.referenceSlots.mediaMaxCount.image&&remote.referenceSlots.mediaMaxCount.video===0&&remote.referenceSlots.mediaMaxCount.audio===0,`${remote.key} 媒体总量边界漂移`);
 check(current.slots.length===remote.referenceSlots.slots.length&&contract.slots.length===remote.referenceSlots.slots.length,`${remote.key} 素材槽数量漂移`);
 for(const remoteSlot of remote.referenceSlots.slots){
  const observedSlot=current.slots.find(slot=>slot.key===remoteSlot.key),executableSlot=contract.slots.find(slot=>slot.publicKey===remoteSlot.key);
  check(Boolean(observedSlot)&&Boolean(executableSlot),`${remote.key} 缺少素材槽 ${remoteSlot.key}`);
  if(!observedSlot||!executableSlot)continue;
  check(observedSlot.label===remoteSlot.label,`${remote.key}/${remoteSlot.key} 公开槽位名称漂移`);
  check(Boolean(executableSlot.label.trim()),`${remote.key}/${remoteSlot.key} 本站执行槽位缺少用户可读名称`);
  check(observedSlot.min===remoteSlot.minCount&&observedSlot.max===remoteSlot.maxCount&&executableSlot.min===remoteSlot.minCount&&executableSlot.max===remoteSlot.maxCount,`${remote.key}/${remoteSlot.key} 数量边界漂移`);
  check((remoteSlot.minCount>0)===remoteSlot.required,`${remote.key}/${remoteSlot.key} 必填标记与下限冲突`);
  check(JSON.stringify(observedSlot.kinds)===JSON.stringify(remoteSlot.mediaTypes)&&JSON.stringify(executableSlot.kinds)===JSON.stringify(remoteSlot.mediaTypes),`${remote.key}/${remoteSlot.key} 媒体类型漂移`);
 }
}

const expectedRailKeys=evidence.catalog.items.filter(item=>!item.isDefault&&item.surfaces.includes('toolbox')).map(item=>item.key).sort();
check(expectedRailKeys.length===11,'实时工具箱应有 11 个非默认图片技能入口');
check(JSON.stringify(IMAGE_RAIL_ITEMS.map(item=>item.sourceId).sort())===JSON.stringify(expectedRailKeys),'图片侧栏入口必须覆盖全部实时工具箱技能且无多余项');
check(evidence.catalog.items.filter(item=>!item.isDefault&&!item.surfaces.includes('toolbox')&&item.surfaces.includes('canvas')).length===4,'应有 4 个仅画布可见图片技能');
check(evidence.catalog.items.filter(item=>item.isDefault).map(item=>item.key).join(',')==='default','默认图片技能必须唯一');

console.log(JSON.stringify({
 passed,
 imageSkills:local.images.length,
 toolboxSkillEntries:expectedRailKeys.length,
 canvasOnlySkills:4,
 catalogRevision:IMAGE_PUBLIC_CATALOG_REVISION,
 distinctBenchmarkConfigVersions:new Set(local.images.map(item=>item.benchmarkConfigVersion)).size,
 effects:{network:0,database:0,provider:0,wallet:0,paidGeneration:0},
}));
