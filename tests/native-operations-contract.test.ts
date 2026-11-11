import test from "node:test";
import assert from "node:assert/strict";
import { NativeDraftMetadataSchema,NativeHostSessionSchema,NativeMetadataActionSchema,NativePreparePublishSchema,nativeAssetId,nativeAssetPath,nativePreparePlanCanonical,validateNativePreparePlan } from "../src/lib/native-operations-contract";
const id="00000000-0000-4000-8000-000000000001",other="00000000-0000-4000-8000-000000000002";
const media={id,role:"image" as const,fileName:"photo.png",type:"image/png",size:1024,lastModified:0,hash:"a".repeat(64),source:"local_file" as const,requiresReselection:true as const};
const target={id:other,platform:"xhs" as const,accountId:id,options:{declaration:3 as const},scheduledAt:null};
const meta={schemaVersion:1 as const,media:[{mediaId:id,assetId:other}],coverMediaId:id,accountTypes:["xhs" as const],maxUseCountByAccountType:{xhs:999999 as const}};
const draft={schemaVersion:2 as const,collectionId:null,contentType:"image" as const,title:"标题",body:"正文",topics:[],media:[media],targets:[target]};
test("native asset references accept only the exact same-origin owner route",()=>{
 assert.equal(nativeAssetId(nativeAssetPath(id)),id);assert.equal(nativeAssetId(`https://host.example${nativeAssetPath(id)}`,"https://host.example"),id);
 for(const value of [`https://foreign.example${nativeAssetPath(id)}`,`${nativeAssetPath(id)}?url=https://example.com/file`,`${nativeAssetPath(id)}/extra`,`//foreign.example${nativeAssetPath(id)}`])assert.equal(nativeAssetId(value,"https://host.example"),null);
});
test("draft metadata preserves original platform intent without granting extra executions",()=>{
 assert.equal(NativeDraftMetadataSchema.safeParse({...meta,accountTypes:["pinterest"],maxUseCountByAccountType:{pinterest:999999}}).success,true);
 for(const patch of [{maxUseCountByAccountType:{xhs:3}},{accountTypes:["invented"]},{accountTypes:["xhs","xhs"]},{maxUseCountByAccountType:{douyin:999999}},{token:"synthetic-fixture"}])assert.equal(NativeDraftMetadataSchema.safeParse({...meta,...patch}).success,false);
});
test("native session never accepts an upstream token, salt or password field",()=>{
 const session={version:"native-host-session.v1",authenticated:true,user:{id,username:"fixture",displayName:"临时会员",role:"student"},featureNavigationKeys:["publish_center"],wallet:{cashCents:125,credits:0},csrfToken:"a".repeat(80)};
 assert.equal(NativeHostSessionSchema.safeParse(session).success,true);
 for(const extra of [{token:"synthetic-fixture"},{password:"synthetic-fixture"},{salt:"synthetic-fixture"}])assert.equal(NativeHostSessionSchema.safeParse({...session,user:{...session.user,...extra}}).success,false);
});
test("mixed plans keep official bindings separate from browser targets",()=>{
 const plan={requestKey:"native-plan-fixture",planHash:"c".repeat(64),groups:[{key:"image",draft,metadata:meta,officialTargets:[{id:"00000000-0000-4000-8000-000000000003",bindingId:id,bindingRevision:1,mediaIds:[id],assetIds:[other],publishAt:null,options:{short_title:"标题"}}]}]};
 assert.equal(NativePreparePublishSchema.safeParse(plan).success,true);
 assert.equal(NativePreparePublishSchema.safeParse({...plan,groups:[{...plan.groups[0],draft:{...draft,targets:[{...target,platform:"douyin",options:{}}]}}]}).success,false);
 assert.equal(NativePreparePublishSchema.safeParse({...plan,sourceDraftId:id}).success,false);
 assert.equal(NativePreparePublishSchema.safeParse({...plan,groups:[plan.groups[0],plan.groups[0]]}).success,false);
});
test("canonical publication plans preserve array order and normalize optional defaults",()=>{
 const base={groups:[{key:"image" as const,draft,metadata:meta,mediaEntryRefs:[],officialTargets:[]}]};const canonical=nativePreparePlanCanonical(base);
 assert.equal(canonical,nativePreparePlanCanonical({...base,sourceDraftId:undefined}));
 const mediaB={...media,id:"00000000-0000-4000-8000-000000000003"},two={groups:[{...base.groups[0],draft:{...draft,media:[media,mediaB]},metadata:{...meta,media:[...meta.media,{mediaId:mediaB.id,assetId:"00000000-0000-4000-8000-000000000004"}]}}]};
 const reordered={groups:[{...two.groups[0],draft:{...two.groups[0].draft,media:[mediaB,media]},metadata:{...two.groups[0].metadata,media:[...two.groups[0].metadata.media].reverse()}}]};assert.notEqual(nativePreparePlanCanonical(two),nativePreparePlanCanonical(reordered));
 const different={...base,groups:[{...base.groups[0],draft:{...draft,title:"新标题"}}]};assert.notEqual(canonical,nativePreparePlanCanonical(different));
 assert.ok(!canonical.includes("requestKey"));assert.ok(!canonical.includes("planHash"));
});
test("shared server preparation preflight rejects bad text before quota or plugin dispatch",()=>{
 const value={requestKey:"native-preflight-fixture",planHash:"c".repeat(64),groups:[{key:"image",draft,metadata:meta}]};
 assert.deepEqual(validateNativePreparePlan(NativePreparePublishSchema.parse(value)),[]);
 for(const patch of [{title:"长".repeat(21)},{body:"字".repeat(1001)},{topics:["一","二","三","四","五","六"]}])assert.ok(validateNativePreparePlan(NativePreparePublishSchema.parse({...value,groups:[{...value.groups[0],draft:{...draft,...patch}}]})).length);
});
test("shared preparation checks each official and browser target's effective override",()=>{
 const official={id:"00000000-0000-4000-8000-000000000003",bindingId:id,bindingRevision:1,mediaIds:[id],assetIds:[other],publishAt:null,options:{}};
 const plan=NativePreparePublishSchema.parse({requestKey:"native-preflight-fixture",planHash:"c".repeat(64),groups:[{key:"image",draft,metadata:meta,officialTargets:[official]}]});
 assert.deepEqual(validateNativePreparePlan(plan),[]);
 const changed={...plan,groups:[{...plan.groups[0],officialTargets:[{...official,titleOverride:"长".repeat(13)}]}]};assert.ok(validateNativePreparePlan(changed).length);
 const unknown={...plan,groups:[{...plan.groups[0],officialTargets:[{...official,mediaIds:["00000000-0000-4000-8000-000000000004"]}]}]};assert.ok(validateNativePreparePlan(unknown).length);
});
test("metadata group reordering cannot carry a hidden account movement",()=>{
 assert.equal(NativeMetadataActionSchema.safeParse({action:"reorder-accounts",items:[{id,accountKind:"browser",rank:0,expectedRevision:1}]}).success,true);
 assert.equal(NativeMetadataActionSchema.safeParse({action:"reorder-accounts",items:[{id,accountKind:"browser",rank:0,expectedRevision:1,groupId:other}]}).success,false);
});
