import { z } from "zod";
import { isPublishingSafeHttps } from "./publishing-contract";
import { PublishingCashFundingSchema } from './publishing-cash-contract';
import { appendPublishingTopics, prepareNativePluginContent } from "./publishing-native";
const id = z.string().uuid();
const key = z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const ident = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/);
const stamp = z.string().datetime({ offset: true });
const text = z.string().max(2000);
const https = z.string().max(2048).refine(isPublishingSafeHttps);
export const PublishingV3OptionsSchema = z.object({ short_title: z.string().max(12).optional(), cover_tsp: z.number().int().nonnegative().optional(), download_type: z.union([z.literal(1),z.literal(2)]).optional(), private_status: z.union([z.literal(0),z.literal(1),z.literal(2)]).optional() }).strict();
export const PublishingV3IntentInputSchema = z.object({ draftId: id, draftVersion: z.number().int().positive(), bindingId: id, bindingRevision: z.number().int().positive(), titleOverride: z.string().max(200).optional(), bodyOverride: z.string().max(50000).optional(), topicsOverride: z.array(z.string().trim().min(1).max(100)).max(30).optional(), mediaIds: z.array(id).min(1).max(30), coverMediaId: id.optional(), assetIds: z.array(id).min(1).max(31), publishAt: stamp.nullable(), options: PublishingV3OptionsSchema }).strict().superRefine((value,context)=>{
  for(const field of ["mediaIds","assetIds"] as const) if(new Set(value[field]).size!==value[field].length)context.addIssue({code:"custom",path:[field],message:"素材标识不得重复"});
});
export type PublishingV3IntentInput = z.infer<typeof PublishingV3IntentInputSchema>;
export const PublishingV3ActionSchema = z.discriminatedUnion("action",[
  z.object({action:z.literal("start-auth"),platform:z.literal("douyin"),requestKey:key}).strict(),
  z.object({action:z.literal("select-auth"),sessionId:id,expectedRevision:z.number().int().positive(),accounts:z.array(z.object({platformUid:ident,account:z.string().max(240).optional()}).strict()).min(1).max(100),requestKey:key}).strict(),
  z.object({action:z.literal("upload-sign"),mediaId:id,fileName:z.string().min(1).max(255).refine(value=>!/[\\/\r\n\x00-\x1f]/.test(value)),mime:z.enum(["image/jpeg","image/png","image/webp","video/mp4"]),size:z.number().int().positive().max(1024**3),sha256:z.string().regex(/^[a-f0-9]{64}$/),requestKey:key}).strict().superRefine((value,context)=>{
    const extension=value.mime==="image/jpeg"?/\.jpe?g$/i:value.mime==="image/png"?/\.png$/i:value.mime==="image/webp"?/\.webp$/i:/\.mp4$/i;
    if(!extension.test(value.fileName))context.addIssue({code:"custom",path:["fileName"],message:"文件扩展名必须与素材格式一致"});
    if(value.mime.startsWith("image/")&&value.size>20*1024**2)context.addIssue({code:"custom",path:["size"],message:"图片不能超过20MiB"});
  }),
  z.object({action:z.literal("upload-confirm"),assetId:id,requestKey:key}).strict(),
  PublishingV3IntentInputSchema.safeExtend({action:z.literal("save-intent"),id:id.optional(),expectedRevision:z.number().int().nonnegative()}),
  z.object({action:z.literal("submit"),intentId:id,intentRevision:z.number().int().positive(),entitlementId:id.optional(),funding:PublishingCashFundingSchema.optional(),requestKey:key}).strict().refine(v=>Boolean(v.entitlementId)!==Boolean(v.funding),'发布资金来源必须明确且唯一'),
  z.object({action:z.literal("reconcile"),operationId:id}).strict(),
  z.object({action:z.literal("task-change"),operationId:id,change:z.enum(["cancel","reschedule","publish-now"]),publishAt:stamp.optional(),expectedRevision:z.number().int().positive(),requestKey:key}).strict().superRefine((value,context)=>{
    if(value.change==="reschedule"?(!value.publishAt||Date.parse(value.publishAt)<=Date.now()):value.publishAt!==undefined)context.addIssue({code:"custom",path:["publishAt"],message:value.change==="reschedule"?"改期需要未来的发布时间":"此操作不接收发布时间"});
  }),
]);
export type PublishingV3Action = z.infer<typeof PublishingV3ActionSchema>;
export const PublishingV3AuthSessionSchema = z.object({id,platform:z.literal("douyin"),state:z.enum(["prepared","pending","requires_selection","completed","failed","unknown","expired"]),revision:z.number().int().positive(),expiresAt:stamp.nullable(),createdAt:stamp,updatedAt:stamp,url:z.union([https,z.string().max(1024**2).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)]).optional(),selectableAccounts:z.array(z.object({platformUid:ident,displayName:z.string().max(240),account:z.string().max(240).optional()}).strict()).optional()}).strict();
export type PublishingV3AuthSession = z.infer<typeof PublishingV3AuthSessionSchema>;
export const PublishingV3BindingSchema = z.object({id,platform:z.literal("douyin"),platformUid:ident,displayName:z.string().max(240),avatar:https.nullable(),status:z.enum(["active","revoked","unknown"]),revision:z.number().int().positive(),authSessionId:id,createdAt:stamp,updatedAt:stamp}).strict();
export type PublishingV3Binding = z.infer<typeof PublishingV3BindingSchema>;
export const PublishingV3AssetSchema = z.object({id,mediaId:id,fileName:z.string().max(255),mime:z.string().max(120),size:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),hashSource:z.literal("browser_declared"),state:z.enum(["prepared","uploading","confirming","ready","unknown","failed"]),revision:z.number().int().positive(),expiresAt:stamp.nullable(),metadata:z.object({width:z.number().finite().positive().optional(),height:z.number().finite().positive().optional(),duration:z.number().finite().positive().optional()}).strict(),createdAt:stamp,updatedAt:stamp}).strict();
export type PublishingV3Asset = z.infer<typeof PublishingV3AssetSchema>;
export const PublishingV3IntentSchema = z.object({id,revision:z.number().int().positive(),payload:PublishingV3IntentInputSchema,archived:z.boolean(),createdAt:stamp,updatedAt:stamp}).strict();
export type PublishingV3Intent = z.infer<typeof PublishingV3IntentSchema>;
export const PublishingV3OperationSchema = z.object({id,kind:z.enum(["authorization","auth_select","asset_sign","asset_confirm","publish","task_change"]),subjectId:id,requestKey:key,dispatchState:z.enum(["ready","dispatching","dispatched","unknown","settled","blocked"]),outcome:z.enum(["pending","waiting","publishing","queued","platform_scheduled","awaiting_user_action","published","failed","cancelled","unknown"]),revision:z.number().int().positive(),intentRevision:z.number().int().positive().nullable(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),errorCode:z.string().max(100).nullable(),workId:z.string().max(240).nullable(),workLink:https.nullable(),createdAt:stamp,updatedAt:stamp}).strict();
export type PublishingV3Operation = z.infer<typeof PublishingV3OperationSchema>;
export const PublishingV3EventSchema = z.object({id,operationId:id,kind:z.string().max(100),source:z.enum(["provider_reported","system","user_reported"]),payload:z.object({status:z.string().max(80).optional(),errorCode:z.string().max(100).optional(),workId:z.string().max(240).optional(),workLink:https.optional()}).strict(),createdAt:stamp}).strict();
export const PublishingV3OfficialLinksSchema = z.object({domesticKeys:https,internationalKeys:https,keyGuide:https,publishingGuide:https,pricing:https}).strict();
export const PublishingV3StatusSchema = z.object({schemaReady:z.boolean(),configured:z.boolean(),environment:z.enum(["domestic","international"]),executionEnabled:z.boolean(),authorizationEnabled:z.boolean(),platform:z.literal("douyin"),message:text,links:PublishingV3OfficialLinksSchema}).strict();
export type PublishingV3Status = z.infer<typeof PublishingV3StatusSchema>;
export const PublishingV3CapabilitiesSchema = z.object({configured:z.boolean(),platforms:z.array(z.object({platform:z.literal("douyin"),name:z.string().max(100),publishSupported:z.boolean(),contentTypes:z.array(z.enum(["image","video"])),maxImages:z.number().int(),maxImageBytes:z.number().int(),maxVideoBytes:z.number().int(),maxVideoDurationSeconds:z.number(),maxTitle:z.number().int(),maxBody:z.number().int(),maxTotal:z.number().int(),maxTopics:z.number().int()}).strict())}).strict();
export const PublishingV3UserActionSchema = z.object({operationId:id,shortLink:https,schemeUrl:z.string().max(4096).refine(value=>/^snssdk1128:\/\//.test(value)||isPublishingSafeHttps(value)),expiresAt:stamp.nullable()}).strict();
export type PublishingV3UserAction = z.infer<typeof PublishingV3UserActionSchema>;
export const PublishingV3ResourceSchema = z.enum(["status","capabilities","auth-session","bindings","assets","intents","operations","events","user-action"]);
export const PublishingV3QuerySchema = z.object({resource:PublishingV3ResourceSchema.default("status"),id:id.optional(),operationId:id.optional(),requestKey:key.optional(),page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)}).strict();
export type PublishingV3Query = z.infer<typeof PublishingV3QuerySchema>;
export const PublishingV3PageSchema = z.object({resource:PublishingV3ResourceSchema,page:z.number().int().positive(),pageSize:z.number().int().positive(),total:z.number().int().nonnegative(),hasMore:z.boolean(),items:z.array(z.union([PublishingV3AuthSessionSchema,PublishingV3BindingSchema,PublishingV3AssetSchema,PublishingV3IntentSchema,PublishingV3OperationSchema,PublishingV3EventSchema]))}).strict();
export type PublishingV3Page = z.infer<typeof PublishingV3PageSchema>;
export const PublishingV3MutationSchema = z.object({ok:z.literal(true),session:PublishingV3AuthSessionSchema.optional(),asset:PublishingV3AssetSchema.optional(),intent:PublishingV3IntentSchema.optional(),operation:PublishingV3OperationSchema.optional(),bindings:z.array(PublishingV3BindingSchema).optional(),upload:z.object({assetId:id,url:z.string().url().max(8192),method:z.literal("PUT"),mime:z.string().max(120)}).strict().optional(),alreadyFulfilled:z.boolean().optional()}).strict();
export type PublishingV3Mutation = z.infer<typeof PublishingV3MutationSchema>;

/** Fixed upstream Douyin projection: native topics are parsed from wire body. */
export function preparePublishingV3Content(input:{title:string;body:string;topics:readonly string[];options:z.infer<typeof PublishingV3OptionsSchema>}) {
  const common=prepareNativePluginContent("douyin",input.title,input.body,input.topics);
  const errors=[...common.errors];
  if(common.title.length+common.desc.length>1000)errors.push("抖音标题与去话题正文合计最多1000字符");
  if(common.topics.length>5)errors.push("抖音正文和标签合计最多5个话题");
  if(common.topics.some(topic=>!/^\w[\w\p{Script=Han}]*$|^[\p{Script=Han}][\w\p{Script=Han}]*$/u.test(topic)))errors.push("抖音话题只能包含汉字、英文字母、数字和下划线，请修正空格或特殊符号");
  if(common.title.length>12 && !input.options.short_title?.trim())errors.push("标题超过12字符时，请填写最多12字符的抖音短标题");
  return {...common,body:appendPublishingTopics(common.desc,common.topics),errors:[...new Set(errors)]};
}
export function validatePublishingV3Media(contentType:"image"|"video",media:readonly {role:string;fileName:string;type:string;size:number;duration?:number}[],cover?:{fileName:string;type:string;size:number}) {
  const errors:string[]=[];const images=media.filter(item=>item.role==="image"),videos=media.filter(item=>item.role==="video");
  if(contentType==="image" && (images.length<1||images.length>12||images.length!==media.length))errors.push("抖音图文需要1至12张图片，封面请单独选择");
  if(contentType==="video" && (videos.length!==1||media.length!==1))errors.push("抖音视频目标需要且只能选择一条成片，不能混选图片或封面");
  for(const file of [...media,...(cover?[{...cover,role:"cover"}]:[])]) {
    if(!Number.isSafeInteger(file.size)||file.size<=0)errors.push("素材大小尚未核实");
    if(file.role==="video") {
      if(file.type!=="video/mp4"||!/\.mp4$/i.test(file.fileName))errors.push("当前官方API适配仅接收MP4视频");
      if(file.size>100*1024**2)errors.push("抖音API单视频上限100MiB");
      const duration="duration" in file?file.duration:undefined;
      if(typeof duration!=="number"||!Number.isFinite(duration)||duration<=0||duration>900)errors.push("抖音视频需已核实且不超过900秒的时长");
    } else {
      if(!["image/jpeg","image/png"].includes(file.type))errors.push("当前官方API适配仅接收JPEG和PNG图片");
      if(file.size>20*1024**2)errors.push("抖音API单图片或封面上限20MiB");
    }
  }
  return [...new Set(errors)];
}
