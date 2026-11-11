import { nativeSha256 } from './native-assets'
import { allDraftMedia, copyStudioDraft } from './studio-draft'
import type { StudioDraft, StudioMedia } from './types'

/** Reselect bytes only. Original media IDs, ordered target selections and plan content stay intact. */
export async function reselectStudioPlanFiles(input: StudioDraft, selected: StudioMedia[], current: () => void): Promise<StudioDraft> {
  const draft = copyStudioDraft(input), originals = allDraftMedia(draft), replacements = new Map<string, StudioMedia>()
  for (const selection of selected) {
    if (!selection.file) throw new Error('重新选择的原文件不可读取')
    const hash = await nativeSha256(selection.file); current()
    const matches = originals.filter(media => media.stage === 'local' && media.originalFile?.sha256 === hash && media.originalFile.type === selection.file!.type && media.originalFile.size === selection.file!.size)
    if (!matches.length) throw new Error('所选文件不是原计划保存的文件；请按原文件的内容、大小和格式重新选择')
    for (const media of matches) replacements.set(media.id, { ...media, file: selection.file, url: selection.url, status: 'ready', error: undefined })
  }
  const replace = (media: StudioMedia) => replacements.get(media.id) ?? media
  draft.media = draft.media.map(replace)
  if (draft.cover) draft.cover = replace(draft.cover)
  for (const override of Object.values(draft.targetOverrides)) if (override.cover) override.cover = replace(override.cover)
  current(); return draft
}
