import test from "node:test";
import assert from "node:assert/strict";
import { PublishingV3ActionSchema, PublishingV3IntentInputSchema, PublishingV3QuerySchema, preparePublishingV3Content, validatePublishingV3Media } from "../src/lib/publishing-v3-contract";
const id="00000000-0000-4000-8000-000000000001", second="00000000-0000-4000-8000-000000000002";
const image={role:"image",fileName:"photo.png",type:"image/png",size:1024};
const video={role:"video",fileName:"clip.mp4",type:"video/mp4",size:1024,duration:30};
const upload={action:"upload-sign",mediaId:id,fileName:"photo.png",mime:"image/png",size:1024,sha256:"a".repeat(64),requestKey:"upload-fixture-key"};
test("official binding and claims accept only local identifiers and server authority",()=>{
 const action={action:"submit",intentId:id,intentRevision:1,entitlementId:second,requestKey:"submit-fixture-key"};
 assert.equal(PublishingV3ActionSchema.safeParse(action).success,true);
 for(const extra of [{ownerId:id},{accountId:"external"},{cost:0},{shouldExecute:true},{flowId:"external"},{url:"https://example.com/asset"}])assert.equal(PublishingV3ActionSchema.safeParse({...action,...extra}).success,false);
});
test("uploads reject path names, MIME mismatches, credentials and unsupported sizes",()=>{
 assert.equal(PublishingV3ActionSchema.safeParse(upload).success,true);
 for(const patch of [{fileName:"../photo.png"},{fileName:"C:\\photo.png"},{fileName:"photo\n.png"},{fileName:"photo.jpg"},{mime:"image/gif"},{size:20*1024**2+1},{cookie:"synthetic-fixture"}])assert.equal(PublishingV3ActionSchema.safeParse({...upload,...patch}).success,false);
});
test("generic assets retain WebP and larger videos while Douyin preflight rejects them",()=>{
 assert.equal(PublishingV3ActionSchema.safeParse({...upload,fileName:"photo.webp",mime:"image/webp"}).success,true);
 assert.equal(PublishingV3ActionSchema.safeParse({...upload,fileName:"clip.mp4",mime:"video/mp4",size:101*1024**2}).success,true);
 assert.equal(PublishingV3ActionSchema.safeParse({...upload,fileName:"clip.mp4",mime:"video/mp4",size:1024**3+1}).success,false);
 assert.ok(validatePublishingV3Media("image",[{...image,fileName:"photo.webp",type:"image/webp"}]).length);
 assert.ok(validatePublishingV3Media("video",[{...video,size:101*1024**2,duration:901}]).length);
});
test("only rescheduling accepts a future publishAt",()=>{
 const action={action:"task-change",operationId:id,expectedRevision:1,requestKey:"change-fixture-key"};
 const future=new Date(Date.now()+86400000).toISOString();
 assert.equal(PublishingV3ActionSchema.safeParse({...action,change:"reschedule",publishAt:future}).success,true);
 for(const patch of [{change:"reschedule"},{change:"reschedule",publishAt:"2000-01-01T00:00:00Z"},{change:"cancel",publishAt:future},{change:"publish-now",publishAt:future},{change:"retry"}])assert.equal(PublishingV3ActionSchema.safeParse({...action,...patch}).success,false);
});
test("intent preserves ordered local media with bounded native options",()=>{
 const input={draftId:id,draftVersion:1,bindingId:second,bindingRevision:1,mediaIds:[id,second],assetIds:[second,id],publishAt:null,options:{short_title:"短标题",download_type:2,private_status:0}};
 assert.deepEqual(PublishingV3IntentInputSchema.parse(input).mediaIds,[id,second]);
 for(const patch of [{mediaIds:[id,id]},{options:{token:"synthetic-fixture"}},{options:{visibility:"public"}},{options:{short_title:"长".repeat(13)}}])assert.equal(PublishingV3IntentInputSchema.safeParse({...input,...patch}).success,false);
});
test("Douyin wire body retains normalized topics including prefix topic names",()=>{
 const result=preparePublishingV3Content({title:"标题",body:"正文 #上海 #上海旅行",topics:["上海","更多"],options:{}});
 assert.deepEqual(result.errors,[]);assert.equal(result.desc,"正文");assert.deepEqual(result.topics,["上海","上海旅行","更多"]);assert.equal(result.body,"正文\n#上海 #上海旅行 #更多");
 const ascii=preparePublishingV3Content({title:"title",body:"body #a #ab",topics:[],options:{}});assert.equal(ascii.body,"body\n#a #ab");
});
test("content validation enforces merged topic limits and upstream topic roundtrip",()=>{
 assert.ok(preparePublishingV3Content({title:"标题",body:"正文 #一 #二 #三",topics:["四","五","六"],options:{}}).errors.length);
 for(const topic of ["C++","带 空格","a-b"])assert.ok(preparePublishingV3Content({title:"标题",body:"正文",topics:[topic],options:{}}).errors.length);
 assert.equal(preparePublishingV3Content({title:"标题",body:"正文",topics:["汉字_ABC123"],options:{}}).errors.length,0);
});
test("content lengths use UTF16, cleaned body, total and explicit short title",()=>{
 assert.ok(preparePublishingV3Content({title:"😀".repeat(16),body:"正文",topics:[],options:{short_title:"短标题"}}).errors.length);
 for(const short_title of [undefined,""]){assert.ok(preparePublishingV3Content({title:"长".repeat(13),body:"正文",topics:[],options:{short_title}}).errors.length);}
 assert.equal(preparePublishingV3Content({title:"长".repeat(13),body:"正文",topics:[],options:{short_title:"短"}}).errors.length,0);
 assert.ok(preparePublishingV3Content({title:"标题",body:"文".repeat(999),topics:[],options:{}}).errors.length);
 assert.equal(preparePublishingV3Content({title:"标题",body:"文".repeat(998)+" #话题",topics:[],options:{}}).errors.length,0);
});
test("API media rejects mixed composition and verifies smaller Douyin limits",()=>{
 assert.deepEqual(validatePublishingV3Media("image",[image]),[]);assert.deepEqual(validatePublishingV3Media("video",[video],image),[]);
 for(const media of [[video,image],[video,{...image,role:"cover"}],[{...video,duration:901}],[{...video,size:100*1024**2+1}],[{...video,duration:undefined}]])assert.ok(validatePublishingV3Media("video",media).length);
 assert.ok(validatePublishingV3Media("image",[{...image,size:20*1024**2+1}]).length);assert.ok(validatePublishingV3Media("image",Array(13).fill(image)).length);
});
test("read-only requestKey recovery is exact, bounded and owner cannot be supplied",()=>{
 assert.equal(PublishingV3QuerySchema.safeParse({resource:"operations",requestKey:"submit-fixture-key",id,pageSize:1}).success,true);
 assert.equal(PublishingV3QuerySchema.safeParse({resource:"operations",ownerId:id}).success,false);assert.equal(PublishingV3QuerySchema.safeParse({pageSize:101}).success,false);
});
