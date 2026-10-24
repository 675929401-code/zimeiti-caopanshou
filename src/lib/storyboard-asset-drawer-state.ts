export type DrawerAssetMetadata = { name: string; tags?: string[]; customCategory?: string };

export function parseDrawerAssetMetadata(name: string, tagsText: string, customCategory: string): DrawerAssetMetadata {
  const tags = [...new Set(tagsText.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean))];
  if (!name.trim() || name.trim().length > 120) throw new Error('资产名称不能为空，且最多120字。');
  if (tags.length > 12 || tags.some(tag => tag.length > 32) || customCategory.trim().length > 40) throw new Error('标签最多12个、每个32字；自定义分类最多40字。');
  return { name: name.trim(), tags, customCategory: customCategory.trim() };
}

/** Summarize actual returned receipts, never infer that omitted cards were submitted. */
export function summarizeDrawerAssetBatch(total: number, results: Array<{ previewUrl?: string } | null>) {
  const submitted = Math.min(total, results.length);
  const succeeded = results.slice(0, submitted).filter(result => Boolean(result?.previewUrl)).length;
  return { succeeded, unresolved: submitted - succeeded, unsubmitted: Math.max(0, total - submitted) };
}

export function drawerAssetMatchesSearch(asset: DrawerAssetMetadata & { prompt?: string }, query: string): boolean {
  const text = [asset.name, asset.prompt || '', asset.customCategory || '', ...(asset.tags || [])].join(' ').toLocaleLowerCase();
  return text.includes(query.trim().toLocaleLowerCase());
}
