import type { StoryboardVisualAssetPlan, StoryboardVisualAssetRef } from "./storyboard-workbench";

type Asset = StoryboardVisualAssetPlan["assets"][number];
export type VisualAssetUrl = { assetId: string; previewUrl: string; storageKey?: string };
type BindingCard = {
  id?: string;
  referenceImageUrls: string[];
  visualAssetRefs?: StoryboardVisualAssetRef[];
  visualAssetRefsMode?: "legacy" | "explicit";
  visualAssetSelectionMode?: "project" | "custom";
  sceneId?: string;
  sceneZone?: string;
};

function location(value: string) {
  try { return new URL(value, "https://storyboard.invalid"); } catch { return null; }
}

/** Compare stable object identity, never a signed URL's expiring query. */
export function visualAssetUrlMatchesSource(url: string, source: Asset["source"]): boolean {
  if (!source) return false;
  const parsed = location(url);
  if (!parsed) return false;
  const queryAssetId = parsed.searchParams.get("assetId");
  if (queryAssetId && queryAssetId === source.assetId && parsed.pathname === "/api/storyboard/image") return true;
  if (!source.storageKey) return false;
  try {
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const key = source.storageKey.replace(/^\/+/, "");
    return path === key || path.endsWith(`/${key}`);
  } catch { return false; }
}

function referenceKind(asset: Asset): StoryboardVisualAssetRef["referenceKinds"][number] {
  if (asset.role === "environment") return asset.cameraCoverage && asset.cameraCoverage !== "wide" ? "environment-angle" : "environment-wide";
  return asset.role === "prop" ? "prop" : "identity";
}

function referenceUrl(card: BindingCard, asset: Asset) {
  const ref = card.visualAssetRefs?.find((item) => item.assetId === asset.id);
  if (!ref) return undefined;
  const identityUrl = ref.boundReferenceUrl || ref.ownedReferenceUrl;
  return card.referenceImageUrls.find((url) =>
    (identityUrl ? url === identityUrl : visualAssetUrlMatchesSource(url, asset.source)));
}

/** Legacy opaque references cannot be classified as automatic or manual. */
export function unresolvedVisualAssetBindingIds(card: BindingCard, plan?: StoryboardVisualAssetPlan): string[] {
  return (card.visualAssetRefs || []).filter((ref) => {
    if (ref.ownedReferenceUrl !== undefined) return Boolean(ref.ownedReferenceUrl) && !card.referenceImageUrls.includes(ref.ownedReferenceUrl);
    if (!card.referenceImageUrls.length) return false;
    const asset = plan?.assets.find((item) => item.id === ref.assetId);
    return !asset || !card.referenceImageUrls.some((url) => visualAssetUrlMatchesSource(url, asset.source));
  }).map((ref) => ref.assetId);
}

/** Remove only automatically owned URLs. An explicitly unowned shared URL stays. */
export function removeVisualAssetBindings<T extends BindingCard>(card: T, plan?: StoryboardVisualAssetPlan): T {
  if (unresolvedVisualAssetBindingIds(card, plan).length) throw new Error("VISUAL_ASSET_REFERENCE_OWNERSHIP_UNKNOWN");
  const refs = card.visualAssetRefs || [];
  return {
    ...card,
    referenceImageUrls: card.referenceImageUrls.filter((url) => !refs.some((ref) => {
      if (ref.ownedReferenceUrl !== undefined) return Boolean(ref.ownedReferenceUrl) && url === ref.ownedReferenceUrl;
      const asset = plan?.assets.find((item) => item.id === ref.assetId);
      return Boolean(asset && visualAssetUrlMatchesSource(url, asset.source));
    })),
    visualAssetRefs: [],
  };
}

/** Switching the mode off suspends selection; it is not an explicit deselection. */
export function suspendVisualAssetBindings<T extends BindingCard>(card: T, plan?: StoryboardVisualAssetPlan): T {
  const detached = removeVisualAssetBindings(card, plan);
  return { ...detached, visualAssetRefs: card.visualAssetRefs?.map(ref => ({
    ...ref, ownedReferenceUrl: "", boundReferenceUrl: "",
  })) };
}

/** Dormant semantic selection never becomes a generation input or preset claim. */
export function activeStoryboardVisualAssetRefs(card: Pick<BindingCard, "visualAssetRefs">, plan?: StoryboardVisualAssetPlan): StoryboardVisualAssetRef[] {
  return plan?.mode === "selected" ? card.visualAssetRefs || [] : [];
}

/** Bind only resolved images; semantic IDs alone never count as coverage. */
export function bindVisualAssetPlan<T extends BindingCard>(
  card: T,
  plan: StoryboardVisualAssetPlan | undefined,
  urls: VisualAssetUrl[],
  limit: number,
  requestedAssetIds?: Iterable<string>,
) {
  const next = { ...card, referenceImageUrls: [...card.referenceImageUrls], visualAssetRefs: [...(card.visualAssetRefs || [])] };
  const missing: string[] = [];
  const overLimit: string[] = [];
  if (plan?.mode !== "selected") return { card: next, missing, overLimit, bound: 0 };
  const requested = requestedAssetIds ? new Set(requestedAssetIds) : null;
  let bound = 0;
  for (const asset of plan.assets) {
    if (requested && !requested.has(asset.id)) continue;
    const resolved = urls.find((item) => item.assetId === asset.source?.assetId && item.previewUrl.trim());
    if (!resolved) { missing.push(asset.id); continue; }
    const previous = next.visualAssetRefs.find((item) => item.assetId === asset.id);
    const oldOwnedUrls = !previous ? [] : previous.ownedReferenceUrl !== undefined
      ? previous.ownedReferenceUrl ? [previous.ownedReferenceUrl] : []
      : next.referenceImageUrls.filter((url) => visualAssetUrlMatchesSource(url, asset.source));
    if (referenceUrl(next, asset) === resolved.previewUrl && previous?.boundReferenceUrl === resolved.previewUrl) continue;
    const retained = next.referenceImageUrls.filter((url) => !oldOwnedUrls.includes(url) || url === resolved.previewUrl);
    const sharedUrl = retained.includes(resolved.previewUrl);
    if (!sharedUrl && retained.length >= Math.max(0, limit)) { overLimit.push(asset.id); continue; }
    next.referenceImageUrls = sharedUrl ? retained : [...retained, resolved.previewUrl];
    next.visualAssetRefs = next.visualAssetRefs.filter((item) => item.assetId !== asset.id);
    next.visualAssetRefs.push({ assetId: asset.id, role: asset.role, referenceKinds: [referenceKind(asset)],
      ...(asset.sceneId ? { sceneId: asset.sceneId } : {}),
      ...(asset.sceneZone ? { sceneZone: asset.sceneZone } : {}),
      ...(asset.cameraCoverage ? { cameraCoverage: asset.cameraCoverage } : {}),
      // Empty means the URL was already supplied manually; off must preserve it.
      boundReferenceUrl: resolved.previewUrl,
      ownedReferenceUrl: sharedUrl && !oldOwnedUrls.includes(resolved.previewUrl) ? "" : resolved.previewUrl });
    bound++;
  }
  return { card: next, missing, overLimit, bound };
}

export function cardCoversVisualAssetPlan(card: BindingCard, plan?: StoryboardVisualAssetPlan): boolean {
  if (plan?.mode !== "selected" || !plan.assets.length) return false;
  return plan.assets.every((asset) => {
    const ref = card.visualAssetRefs?.find((item) => item.assetId === asset.id);
    if (!ref) return false;
    return Boolean(referenceUrl(card, asset));
  });
}

/**
 * Select the safe default bindings for a new or legacy card. Identity assets
 * are project-wide; environment and prop assets require an explicit segment
 * reference or the same scene/zone as the card.
 */
export function defaultVisualAssetIdsForCard(
  card: Pick<BindingCard, "visualAssetRefs" | "visualAssetRefsMode" | "visualAssetSelectionMode" | "sceneId" | "sceneZone">,
  plan?: StoryboardVisualAssetPlan,
): string[] {
  if (plan?.mode !== "selected") return [];
  if (card.visualAssetSelectionMode === "project") return plan.defaultAssetIds === undefined
    ? plan.assets.filter(asset => asset.role === "character" || asset.role === "pet").map(asset => asset.id)
    : [...plan.defaultAssetIds];
  if (card.visualAssetSelectionMode === "custom") {
    if (card.visualAssetRefs === undefined) throw new Error("VISUAL_ASSET_CUSTOM_SELECTION_MISSING");
    return card.visualAssetRefs.map(ref => ref.assetId);
  }
  if (card.visualAssetRefsMode === "explicit") return (card.visualAssetRefs || []).map((ref) => ref.assetId);
  const identity = plan.assets.filter((asset) => asset.role === "character" || asset.role === "pet");
  const scene = plan.assets.filter((asset) => {
    if (asset.role === "character" || asset.role === "pet") return false;
    if (card.sceneId && asset.sceneId !== card.sceneId) return false;
    if (card.sceneZone && asset.sceneZone && asset.sceneZone !== card.sceneZone) return false;
    return Boolean(card.sceneId && asset.sceneId === card.sceneId);
  });
  return [...identity, ...scene].map((asset) => asset.id);
}

export function cardCoversVisualAssetRequirements(card: BindingCard, plan?: StoryboardVisualAssetPlan): boolean {
  if (plan?.mode !== "selected") return false;
  const requested = defaultVisualAssetIdsForCard(card, plan);
  if (!requested.length) return card.visualAssetSelectionMode === "custom"
    || card.visualAssetSelectionMode === "project" && plan.defaultAssetIds !== undefined
    || card.visualAssetSelectionMode === undefined && card.visualAssetRefsMode === "explicit";
  return requested.every((assetId) => {
    const asset = plan.assets.find((item) => item.id === assetId);
    const ref = asset && card.visualAssetRefs?.find((item) => item.assetId === asset.id);
    return Boolean(asset && ref && referenceUrl(card, asset));
  });
}

/** Undo only this transaction's fields, preserving later edits to prompts/cards. */
export function rollbackVisualAssetMode<T extends { visualAssetPlan?: StoryboardVisualAssetPlan; cards: BindingCard[] }>(latest: T, before: T, attempted: T): T {
  return { ...latest,
    visualAssetPlan: latest.visualAssetPlan === attempted.visualAssetPlan ? before.visualAssetPlan : latest.visualAssetPlan,
    cards: latest.cards.map((card, index) => {
      const original = card.id ? before.cards.find((item) => item.id === card.id) : before.cards[index];
      const changed = card.id ? attempted.cards.find((item) => item.id === card.id) : attempted.cards[index];
      if (!original || !changed || card.referenceImageUrls !== changed.referenceImageUrls || card.visualAssetRefs !== changed.visualAssetRefs
        || card.visualAssetRefsMode !== changed.visualAssetRefsMode || card.visualAssetSelectionMode !== changed.visualAssetSelectionMode
        || card.sceneId !== changed.sceneId || card.sceneZone !== changed.sceneZone) return card;
      return { ...card, referenceImageUrls: original.referenceImageUrls, visualAssetRefs: original.visualAssetRefs,
        visualAssetRefsMode: original.visualAssetRefsMode, visualAssetSelectionMode: original.visualAssetSelectionMode,
        sceneId: original.sceneId, sceneZone: original.sceneZone };
    }),
  };
}

/** Resolve a saved copy only by the same owned generation record, never draft name or URL. */
export function selectedVisualAssetCandidate<T extends { assetId: string; projectId?: string; historyRecordId?: string; source?: string; presetId?: string }>(
  asset: Asset, candidates: T[], projectId: string,
): T | undefined {
  const exact = candidates.find(candidate => candidate.assetId === asset.source?.assetId);
  if (exact || !asset.source || asset.source.kind === "platform-preset"
    || !/^[a-f0-9]{64}$/u.test(asset.source.historyRecordId || "")) return exact;
  const aliases = candidates.filter(candidate => candidate.projectId === projectId
    && candidate.source !== "platform-preset" && !candidate.presetId
    && candidate.historyRecordId === asset.source!.historyRecordId);
  return aliases.length === 1 ? aliases[0] : undefined;
}

/** A saved copy may have a new asset ID while retaining the same owned history record. */
export function sameStoryboardVisualAssetIdentity(
  left: { assetId: string; projectId?: string; historyRecordId?: string; source?: string; presetId?: string } | undefined,
  right: { assetId: string; projectId?: string; historyRecordId?: string; source?: string; presetId?: string } | undefined,
  projectId: string,
): boolean {
  if (!left || !right) return false;
  if (left.assetId === right.assetId) return true;
  return Boolean(projectId && left.projectId === projectId && right.projectId === projectId
    && left.source !== 'platform-preset' && right.source !== 'platform-preset' && !left.presetId && !right.presetId
    && /^[a-f0-9]{64}$/u.test(left.historyRecordId || '') && left.historyRecordId === right.historyRecordId);
}

/** Saving a permanent copy changes only its source identity, not semantic refs or old request snapshots. */
export function migrateSavedVisualAssetSource(plan: StoryboardVisualAssetPlan | undefined, originalId: string,
  saved: { assetId: string; storageKey?: string; historyRecordId?: string; saved?: boolean },
): StoryboardVisualAssetPlan | undefined {
  if (!plan || !saved.saved || !saved.storageKey) return plan;
  let changed = false;
  const assets = plan.assets.map(asset => {
    const source = asset.source;
    if (!source || source.kind === "platform-preset" || source.assetId !== originalId
      || source.historyRecordId && source.historyRecordId !== saved.historyRecordId) return asset;
    if (source.assetId === saved.assetId && source.storageKey === saved.storageKey && source.librarySaved === true) return asset;
    changed = true;
    return { ...asset, source: { ...source, assetId: saved.assetId, storageKey: saved.storageKey,
      historyRecordId: saved.historyRecordId || source.historyRecordId, librarySaved: true } };
  });
  return changed ? { ...plan, assets } : plan;
}
