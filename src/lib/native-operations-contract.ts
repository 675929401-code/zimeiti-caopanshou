import { z } from "zod";
import { isPublishingSafeHttps } from "./publishing-contract";
import { isUserProfileAvatarReference, isLegacyUserProfileAvatarReference } from "./user-profile-avatar";
import { NativeMediaSourceSchema } from "./native-main-media-contract";
import { PublishingV2ActionSchema,PublishingV2DraftInputSchema,PublishingV2DraftSchema,PublishingV2BatchSchema } from "./publishing-v2-contract";
import { PublishingV3OptionsSchema,PublishingV3IntentSchema,preparePublishingV3Content,validatePublishingV3Media } from "./publishing-v3-contract";
import { prepareNativePluginContent,validateNativePublishingMedia } from "./publishing-native";
export const NativePlatformSchema=z.enum(["linkedin","wxSph","xhs","douyin","tiktok","KWAI","youtube","bilibili","twitter","wxGzh","facebook","instagram","threads","pinterest"]);
const id=z.string().uuid();
export const NATIVE_OPERATIONS_BASE="/api/native-operations";
export const NATIVE_CSRF_HEADER="x-native-csrf";
export const NativeHostSessionSchema=z.object({version:z.literal("native-host-session.v1"),authenticated:z.literal(true),user:z.object({id,username:z.string().max(240),displayName:z.string().max(240),avatarUrl:z.string().refine(value=>value===""||isPublishingSafeHttps(value)||isUserProfileAvatarReference(value)||isLegacyUserProfileAvatarReference(value)).optional(),role:z.string().max(50)}).strict(),featureNavigationKeys:z.array(z.string().max(100)),wallet:z.object({cashCents:z.number().int(),credits:z.number().finite()}).strict(),csrfToken:z.string().min(64).max(500)}).strict();
export type NativeHostSession=z.infer<typeof NativeHostSessionSchema>;
export interface NativeEnvelope<T=unknown>{code:0|string;data:T;message:string}
export const NativeCollectionMetadataSchema=z.object({schemaVersion:z.literal(1),platforms:z.array(NativePlatformSchema).max(14),useScene:z.null(),useSceneRelId:z.null()}).strict();
export const NativeDraftMetadataV1Schema=z.object({schemaVersion:z.literal(1),media:z.array(z.object({mediaId:id,assetId:id}).strict()).max(30),coverMediaId:id.nullable(),accountTypes:z.array(NativePlatformSchema).max(14),maxUseCountByAccountType:z.partialRecord(NativePlatformSchema,z.literal(999999))}).strict().superRefine((value,context)=>{
 if(new Set(value.media.map(item=>item.mediaId)).size!==value.media.length||new Set(value.media.map(item=>item.assetId)).size!==value.media.length||new Set(value.accountTypes).size!==value.accountTypes.length)context.addIssue({code:"custom",message:"原生素材与平台标识不得重复"});
 if(Object.keys(value.maxUseCountByAccountType).length!==value.accountTypes.length||Object.keys(value.maxUseCountByAccountType).some(platform=>!value.accountTypes.includes(platform as z.infer<typeof NativePlatformSchema>)))context.addIssue({code:"custom",message:"使用上限必须与所选平台逐一对应"});
});
export const NativeDraftMetadataV2Schema=z.object({schemaVersion:z.literal(2),media:z.array(z.object({mediaId:id,source:NativeMediaSourceSchema}).strict()).max(30),coverMediaId:id.nullable(),accountTypes:z.array(NativePlatformSchema).max(14),maxUseCountByAccountType:z.partialRecord(NativePlatformSchema,z.literal(999999))}).strict().superRefine((value,context)=>{
 if(new Set(value.media.map(item=>item.mediaId)).size!==value.media.length||new Set(value.accountTypes).size!==value.accountTypes.length)context.addIssue({code:"custom",message:"原生素材与平台标识不得重复"});
 if(value.coverMediaId!==null&&!value.media.some(item=>item.mediaId===value.coverMediaId))context.addIssue({code:"custom",message:"封面必须引用当前素材"});
 if(Object.keys(value.maxUseCountByAccountType).length!==value.accountTypes.length||Object.keys(value.maxUseCountByAccountType).some(platform=>!value.accountTypes.includes(platform as z.infer<typeof NativePlatformSchema>)))context.addIssue({code:"custom",message:"使用上限必须与所选平台逐一对应"});
});
export const NativeDraftMetadataSchema=z.union([NativeDraftMetadataV1Schema,NativeDraftMetadataV2Schema]);
export const NativeMetadataActionSchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("save-collection"),base:PublishingV2ActionSchema,expectedMetadataRevision:z.number().int().nonnegative(),metadata:NativeCollectionMetadataSchema}).strict().refine(value=>value.base.action==="save-collection"),
 z.object({action:z.literal("save-draft"),base:PublishingV2ActionSchema,expectedMetadataRevision:z.number().int().nonnegative(),metadata:NativeDraftMetadataSchema}).strict().refine(value=>value.base.action==="save-draft"),
 z.object({action:z.literal("save-group"),base:PublishingV2ActionSchema,expectedMetadataRevision:z.number().int().nonnegative(),rank:z.number().int().nonnegative()}).strict().refine(value=>value.base.action==="save-group"),
 z.object({action:z.literal("save-account"),accountKind:z.enum(["browser","official"]),accountId:id,groupId:id.nullable(),rank:z.number().int().nonnegative(),expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({action:z.literal("reorder-groups"),items:z.array(z.object({id,rank:z.number().int().nonnegative(),expectedRevision:z.number().int().nonnegative()}).strict()).min(1).max(100)}).strict(),
 z.object({action:z.literal("reorder-accounts"),items:z.array(z.object({id,accountKind:z.enum(["browser","official"]),rank:z.number().int().nonnegative(),expectedRevision:z.number().int().nonnegative()}).strict()).min(1).max(100)}).strict(),
]);
export type NativeMetadataAction=z.infer<typeof NativeMetadataActionSchema>;
export const NativeOfficialTargetSchema=z.object({id,bindingId:id,bindingRevision:z.number().int().positive(),titleOverride:z.string().max(200).optional(),bodyOverride:z.string().max(50000).optional(),topicsOverride:z.array(z.string().trim().min(1).max(100)).max(30).optional(),mediaIds:z.array(id).min(1).max(30),coverMediaId:id.optional(),assetIds:z.array(id).min(1).max(31),publishAt:z.string().datetime({offset:true}).nullable(),options:PublishingV3OptionsSchema}).strict();
export const NativePreparePublishSchema=z.object({requestKey:z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/),planHash:z.string().regex(/^[a-f0-9]{64}$/),sourceDraftId:id.optional(),sourceDraftVersion:z.number().int().positive().optional(),groups:z.array(z.object({key:z.enum(["image","video"]),draft:PublishingV2DraftInputSchema,metadata:NativeDraftMetadataSchema,mediaEntryRefs:z.array(z.object({mediaId:id,mediaEntryId:id}).strict()).max(30).default([]),officialTargets:z.array(NativeOfficialTargetSchema).max(100).default([])}).strict()).min(1).max(2)}).strict().superRefine((value,context)=>{
 if((value.sourceDraftId===undefined)!==(value.sourceDraftVersion===undefined))context.addIssue({code:"custom",message:"原始内容与版本必须同时给出"});
 if(new Set(value.groups.map(group=>group.key)).size!==value.groups.length||value.groups.some(group=>group.key!==group.draft.contentType))context.addIssue({code:"custom",message:"每个内容类型只能对应一个执行分组"});
 const targets=value.groups.flatMap(group=>[...group.draft.targets.map(item=>item.id),...(group.officialTargets??[]).map(item=>item.id)]);
 if(!targets.length||new Set(targets).size!==targets.length)context.addIssue({code:"custom",message:"发布目标必须存在且标识不得重复"});
});
export type NativePreparePublish=z.infer<typeof NativePreparePublishSchema>;
/** Same deterministic UTF8 input on the host and original UI. */
export function nativePreparePlanCanonical(value:Pick<NativePreparePublish,"sourceDraftId"|"sourceDraftVersion"|"groups">):string{
 const parsed=NativePreparePublishSchema.parse({...value,requestKey:"canonical-plan",planHash:"0".repeat(64)});
 const canonical=(entry:unknown):unknown=>Array.isArray(entry)?entry.map(canonical):entry&&typeof entry==="object"?Object.fromEntries(Object.entries(entry).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):entry;
 return JSON.stringify(canonical({...(parsed.sourceDraftId?{sourceDraftId:parsed.sourceDraftId,sourceDraftVersion:parsed.sourceDraftVersion}:{}),groups:parsed.groups}));
}
export const NativePreparedPublishSchema=z.object({manifestId:id,connectionCurrent:z.boolean(),groups:z.array(z.object({key:z.enum(["image","video"]),draft:PublishingV2DraftSchema,batch:PublishingV2BatchSchema.optional(),officialTargets:z.array(z.object({targetId:id,intent:PublishingV3IntentSchema}).strict())}).strict()),alreadyFulfilled:z.boolean().optional()}).strict();
export type NativePreparedPublish=z.infer<typeof NativePreparedPublishSchema>;
export const NativeCoreItemSchema=z.object({id,expectedRevision:z.number().int().positive(),expectedMetadataRevision:z.number().int().nonnegative(),expectedUsageFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const NativeMediaItemCasSchema=z.object({id,expectedRevision:z.number().int().positive()}).strict();
const requestKey=z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const transfer={targetCollectionId:id,expectedTargetCollectionRevision:z.number().int().positive(),mode:z.enum(["move","copy"])};
export const NativeCoreActionSchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("archive-drafts"),requestKey,items:z.array(NativeCoreItemSchema).min(1).max(100)}).strict(),
 z.object({action:z.literal("archive-collections"),requestKey,items:z.array(NativeCoreItemSchema).min(1).max(100)}).strict(),
 z.object({action:z.literal("delete-account-groups"),requestKey,items:z.array(NativeCoreItemSchema).min(1).max(100)}).strict(),
 z.object({action:z.literal("transfer-drafts"),requestKey,items:z.array(NativeCoreItemSchema).min(1).max(100),...transfer}).strict(),
 z.object({action:z.literal("transfer-content"),requestKey,items:z.array(NativeCoreItemSchema).max(100),mediaItems:z.array(NativeMediaItemCasSchema).max(100),...transfer}).strict().refine(value=>value.items.length+value.mediaItems.length>=1&&value.items.length+value.mediaItems.length<=100),
 z.object({action:z.literal("archive-media"),requestKey,items:z.array(NativeMediaItemCasSchema).min(1).max(100)}).strict(),
 z.object({action:z.literal("transfer-media"),requestKey,items:z.array(NativeMediaItemCasSchema).min(1).max(100),...transfer}).strict(),
 z.object({action:z.literal("disconnect-account"),requestKey,accountKind:z.enum(["browser","official"]),accountId:id,expectedMetadataRevision:z.number().int().nonnegative(),expectedBindingRevision:z.number().int().positive().optional()}).strict().refine(value=>value.accountKind==="official"?value.expectedBindingRevision!==undefined:value.expectedBindingRevision===undefined),
 z.object({action:z.literal("reconnect-account"),requestKey,accountKind:z.enum(["browser","official"]),accountId:id,expectedMetadataRevision:z.number().int().nonnegative(),expectedBindingRevision:z.number().int().positive().optional(),platformUid:z.string().min(1).max(160).optional(),authSessionId:id.optional()}).strict().refine(value=>value.accountKind==="browser"?value.platformUid!==undefined&&value.authSessionId===undefined&&value.expectedBindingRevision===undefined:value.authSessionId!==undefined&&value.expectedBindingRevision!==undefined&&value.platformUid===undefined),
 z.object({action:z.literal("save-native-draft"),requestKey,save:NativeMetadataActionSchema,mediaEntryRefs:z.array(z.object({mediaId:id,mediaEntryId:id}).strict()).max(30)}).strict().refine(value=>value.save.action==="save-draft"),
]);
export type NativeCoreAction=z.infer<typeof NativeCoreActionSchema>;
export function validateNativePreparePlan(plan:NativePreparePublish):string[]{
 const errors:string[]=[];
 for(const group of plan.groups){const draft=group.draft;
  for(const target of draft.targets){
   const selected=target.mediaIds?target.mediaIds.map(mediaId=>draft.media.find(item=>item.id===mediaId)):draft.media.filter(item=>item.role!=="cover");
   if(selected.some(item=>!item)){errors.push("浏览器目标素材引用不完整");continue;}
   const covers=draft.media.filter(item=>item.role==="cover");const cover=target.coverMediaId?draft.media.find(item=>item.id===target.coverMediaId):!target.mediaIds&&covers.length===1?covers[0]:undefined;
   if(!target.mediaIds&&!target.coverMediaId&&covers.length>1)errors.push("素材池有多张封面，请逐目标明确选择");
   errors.push(...prepareNativePluginContent(target.platform,target.titleOverride??draft.title,target.bodyOverride??draft.body,target.topicsOverride??draft.topics).errors,...validateNativePublishingMedia(target.platform,draft.contentType,selected.filter((item):item is typeof draft.media[number]=>!!item),cover,target.scheduledAt));
  }
  for(const target of group.officialTargets){const selected=target.mediaIds.map(mediaId=>draft.media.find(item=>item.id===mediaId));if(selected.some(item=>!item)){errors.push("官方目标素材引用不完整");continue;}const cover=target.coverMediaId?draft.media.find(item=>item.id===target.coverMediaId):undefined;if(target.coverMediaId&&!cover)errors.push("官方目标封面引用不完整");errors.push(...preparePublishingV3Content({title:target.titleOverride??draft.title,body:target.bodyOverride??draft.body,topics:target.topicsOverride??draft.topics,options:target.options}).errors,...validatePublishingV3Media(draft.contentType,selected.filter((item):item is typeof draft.media[number]=>!!item),cover));}
 }
 return [...new Set(errors)];
}
/** Only this owner-scoped same-origin URL is accepted by original material DTOs. */
export function nativeAssetPath(assetId:string):string{return `${NATIVE_OPERATIONS_BASE}/assets/${id.parse(assetId)}/content`;}
export function nativeAssetId(value:string,origin?:string):string|null{try{const url=new URL(value,origin??"https://native.invalid");if(url.origin!==(origin??"https://native.invalid")||url.search||url.hash)return null;const match=url.pathname.match(/^\/api\/native-operations\/assets\/([a-f0-9-]+)\/content$/i);return match&&id.safeParse(match[1]).success?match[1]:null;}catch{return null;}}
