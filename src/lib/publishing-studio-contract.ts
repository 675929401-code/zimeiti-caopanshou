import { PublishingCenterSchema } from './publishing-contract';
import { z } from 'zod';
import { PublishingV2DraftSchema, PublishingV2ScheduleSchema } from './publishing-v2-contract';
import { NativeDraftMetadataSchema } from './native-operations-contract';

/** The empty Studio boot never loads drafts, publishing history or media history. */
export const PublishingStudioBootstrapSchema = PublishingCenterSchema.pick({ config: true, entitlements: true, schemaReady: true, access: true });
export type PublishingStudioBootstrap = import('zod').infer<typeof PublishingStudioBootstrapSchema>;

export const PublishingStudioDraftSchema = z.object({ draft: PublishingV2DraftSchema, metadata: NativeDraftMetadataSchema, metadataRevision: z.number().int().nonnegative(), mediaEntryRefs: z.array(z.object({ mediaId: z.string().uuid(), mediaEntryId: z.string().uuid() }).strict()).max(30) }).strict().superRefine((value, context) => {
  const mediaIds = new Set(value.draft.payload.media.map(item => item.id));
  if (value.draft.archived || mediaIds.size !== value.metadata.media.length || value.metadata.media.some(item => !mediaIds.has(item.mediaId))) context.addIssue({ code: 'custom', message: '草稿与素材映射不一致，或已归档' });
  if (new Set(value.mediaEntryRefs.map(item => item.mediaId)).size !== value.mediaEntryRefs.length || value.mediaEntryRefs.some(item => !mediaIds.has(item.mediaId))) context.addIssue({ code: 'custom', message: '草稿图库引用不一致' });
});
/** Original pub2 plans may predate native metadata. Their local-file SHA remains authoritative. */
export const PublishingStudioPlanContentSchema = z.object({ draft: PublishingV2DraftSchema, metadata: NativeDraftMetadataSchema.nullable(), metadataRevision: z.number().int().nonnegative(), mediaEntryRefs: z.array(z.object({ mediaId: z.string().uuid(), mediaEntryId: z.string().uuid() }).strict()).max(100) }).strict().superRefine((value,ctx)=>{
  if(value.metadata) { const parsed=PublishingStudioDraftSchema.safeParse(value); if(!parsed.success) ctx.addIssue({code:'custom',message:'原计划素材映射不一致'}); }
  else if(value.metadataRevision!==0 || value.mediaEntryRefs.length || value.draft.archived) ctx.addIssue({code:'custom',message:'原计划缺少可核对的素材映射'});
});
export const PublishingStudioPlanSchema = z.object({ schedule: PublishingV2ScheduleSchema, content: PublishingStudioPlanContentSchema }).strict().superRefine((value,ctx)=>{
  if(value.schedule.draftId!==value.content.draft.id || value.schedule.draftVersion!==value.content.draft.revision || !value.content.draft.payload.targets.some(t=>t.id===value.schedule.targetId)) ctx.addIssue({code:'custom',message:'原计划与内容版本不一致'});
});
