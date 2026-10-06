import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DIRECTOR_REFERENCE_LIMIT} from '../src/commerce/server/director-conversation-schema';

type EvidenceSlot={key:string;name:string;mediaTypes:string[];minCount:number;maxCount:number;required:boolean};
type EvidenceItem={skillKey:string;configVersion:string;isDefault:boolean;category:{label:string};label:string;description:string;sortOrder:number;isRecommended:boolean;recommendationOrder:number;referenceSlots:EvidenceSlot[]};
type LocalSlot={key:string;label:string;kinds:string[];min:number;max:number};
type LocalItem={key:string;name:string;description:string;category:string;recommended:boolean;default:boolean;benchmarkConfigVersion:string;sortOrder:number;recommendationOrder:number;slots:LocalSlot[]};

const evidence=JSON.parse(readFileSync(new URL('../docs/带货Agent镜像融合-20260925/对标19编导实时目录只读证据.json',import.meta.url),'utf8')) as {schema:string;access:string;itemCount:number;items:EvidenceItem[]};
const local=JSON.parse(readFileSync(new URL('../src/commerce/components/commerce-agent/observed-catalog.json',import.meta.url),'utf8')) as {directors:LocalItem[]};
let passed=0;
const check=(value:unknown,message:string)=>{assert.ok(value,message);passed+=1;};

check(evidence.schema==='commerce-benchmark-director-catalog-evidence/v1','实时目录证据 schema 必须固定');
check(evidence.access==='normal-authorized-read-only','实时目录证据必须来自正常授权只读请求');
check(evidence.itemCount===19&&evidence.items.length===19,'实时目录必须恰好包含 19 个编导');
check(local.directors.length===19,'本站基线必须恰好包含 19 个编导');
check(new Set(evidence.items.map(item=>item.skillKey)).size===19,'实时 skill key 必须唯一');
check(new Set(evidence.items.map(item=>item.configVersion)).size===19,'19 个实时配置版本必须各自独立');
check(new Set(local.directors.map(item=>item.key)).size===19,'本站 skill key 必须唯一');
check(DIRECTOR_REFERENCE_LIMIT===40,'编导分析必须支持实时目录的 30 图 + 10 音频上限');

const localByKey=new Map(local.directors.map(item=>[item.key,item]));
for(const remote of evidence.items){
  const current=localByKey.get(remote.skillKey);
  check(Boolean(current),`本站缺少编导 ${remote.skillKey}`);
  if(!current)continue;
  check(current.name===remote.label,`${remote.skillKey} 名称漂移`);
  check(current.description===remote.description,`${remote.skillKey} 描述漂移`);
  check(current.category===remote.category.label,`${remote.skillKey} 分类漂移`);
  check(current.default===remote.isDefault,`${remote.skillKey} 默认身份漂移`);
  check(current.recommended===remote.isRecommended,`${remote.skillKey} 推荐身份漂移`);
  check(current.sortOrder===remote.sortOrder,`${remote.skillKey} 排序漂移`);
  check(current.recommendationOrder===remote.recommendationOrder,`${remote.skillKey} 推荐排序漂移`);
  check(current.benchmarkConfigVersion===remote.configVersion,`${remote.skillKey} 对标配置版本漂移`);
  check(current.slots.length===remote.referenceSlots.length,`${remote.skillKey} 素材槽数量漂移`);
  for(const remoteSlot of remote.referenceSlots){
    const slot=current.slots.find(item=>item.key===remoteSlot.key);
    check(Boolean(slot),`${remote.skillKey} 缺少素材槽 ${remoteSlot.key}`);
    if(!slot)continue;
    check(slot.label===remoteSlot.name,`${remote.skillKey}/${remoteSlot.key} 名称漂移`);
    check(slot.min===remoteSlot.minCount&&slot.max===remoteSlot.maxCount,`${remote.skillKey}/${remoteSlot.key} 数量边界漂移`);
    check((slot.min>0)===remoteSlot.required,`${remote.skillKey}/${remoteSlot.key} 必填边界漂移`);
    // Two live rows label the slot as voice while declaring image.  The local
    // executable boundary intentionally normalizes those observable metadata
    // defects to audio instead of making the upload control accept images.
    const expectedKinds=remoteSlot.name==='声音'?['audio']:remoteSlot.mediaTypes;
    check(JSON.stringify(slot.kinds)===JSON.stringify(expectedKinds),`${remote.skillKey}/${remoteSlot.key} 媒体类型漂移`);
  }
}

const localKeys=local.directors.map(item=>item.key).sort();
const evidenceKeys=evidence.items.map(item=>item.skillKey).sort();
check(JSON.stringify(localKeys)===JSON.stringify(evidenceKeys),'本站与实时目录 key 集合必须完全一致');
check(local.directors.filter(item=>item.default).map(item=>item.key).join(',')==='default-director','默认编导必须唯一');
check(Math.max(...local.directors.flatMap(item=>item.slots.filter(slot=>slot.kinds.includes('image')).map(slot=>slot.max)))===30,'图片槽上限必须为 30');
check(Math.max(...local.directors.flatMap(item=>item.slots.filter(slot=>slot.kinds.includes('audio')).map(slot=>slot.max)))===10,'声音槽上限必须为 10');

console.log(JSON.stringify({
  passed,
  directors:local.directors.length,
  distinctBenchmarkConfigVersions:new Set(local.directors.map(item=>item.benchmarkConfigVersion)).size,
  analysisReferenceLimit:DIRECTOR_REFERENCE_LIMIT,
  imageLimit:30,
  audioLimit:10,
  effects:{network:0,database:0,provider:0,wallet:0,paidGeneration:0},
}));
