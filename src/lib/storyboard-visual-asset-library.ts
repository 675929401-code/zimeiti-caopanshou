import type { DrawerVisualAsset } from "@/components/storyboard-visual-assets-drawer";

/** Explicit library save, independent of project reference limits. Never generates or applies images. */
export async function saveStoryboardVisualAssetCandidates(input: {
  selected: DrawerVisualAsset[]; projectId: string; token: string;
  exported: Map<string, DrawerVisualAsset>;
  onSaved: (asset: DrawerVisualAsset, original: DrawerVisualAsset) => void;
  request?: typeof fetch;
}) {
  const request = input.request || fetch;
  const assets: DrawerVisualAsset[] = []; const savedNames: string[] = [];
  try {
    for (const original of input.selected) {
      const exported = input.exported.get(original.assetId);
      let candidate = exported ? { ...original, assetId: exported.assetId, storageKey: exported.storageKey, previewUrl: exported.previewUrl } : { ...original };
      if (!candidate.saved && candidate.source !== "platform-preset") {
        if (!candidate.storageKey) {
          let url = candidate.previewUrl;
          if (/^[a-f0-9]{64}$/u.test(candidate.historyRecordId || "") && !url.startsWith("data:")) {
            const read = await request(`/api/storyboard/visual-assets?recordId=${candidate.historyRecordId}`, { headers: { Authorization: `Bearer ${input.token}` }, cache: "no-store" });
            const result = await read.json();
            if (!read.ok || !result.reference?.previewUrl) throw new Error(result.error || `${candidate.name}原图无法读取`);
            url = result.reference.previewUrl;
          }
          const response = await request("/api/image-workbench/persist", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` },
            body: JSON.stringify({ url, index: 0, clientTraceId: `visual-asset-save-${candidate.assetId}`, intent: "user_asset_export" }) });
          const result = await response.json();
          if (!response.ok || !result.assetId || !result.key || !result.url) throw new Error(result.error || `${candidate.name}另存未确认`);
          candidate = { ...candidate, assetId: result.assetId, storageKey: result.key, previewUrl: result.url };
          input.exported.set(original.assetId, candidate);
        }
        const response = await request("/api/storyboard/visual-assets", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` },
          body: JSON.stringify({ assetId: candidate.assetId, role: candidate.role, name: candidate.name, prompt: candidate.prompt || "", projectId: input.projectId,
            tags: candidate.tags || [], customCategory: candidate.customCategory || "",
            ...(candidate.sceneId ? { sceneId: candidate.sceneId } : {}), ...(candidate.sceneZone ? { sceneZone: candidate.sceneZone } : {}), ...(candidate.cameraCoverage ? { cameraCoverage: candidate.cameraCoverage } : {}),
            ...(candidate.fixedAnchors?.length ? { fixedAnchors: candidate.fixedAnchors } : {}), ...(candidate.allowedSegmentKinds?.length ? { allowedSegmentKinds: candidate.allowedSegmentKinds } : {}), ...(candidate.derivedFromAssetId ? { derivedFromAssetId: candidate.derivedFromAssetId } : {}) }) });
        const result = await response.json();
        if (!response.ok || !result.asset?.previewUrl) throw new Error(result.error || `${candidate.name}资产库保存未确认`);
        candidate = { ...candidate, ...result.asset, planId: original.planId, saved: true };
        savedNames.push(candidate.name); input.onSaved(candidate, original);
      }
      assets.push(candidate);
    }
    return { assets, savedNames };
  } catch (error) { return { assets, savedNames, error: error instanceof Error ? error.message : "资产保存未确认，请检查原记录" }; }
}
