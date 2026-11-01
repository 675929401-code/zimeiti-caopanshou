"use client";

import { useEffect, useRef, useState } from "react";
import { StoryboardPresetCatalogSchema, type StoryboardPresetCatalog, type StoryboardPresetDraft } from "@/lib/storyboard-preset-assets";
import styles from "./storyboard-presets-admin.module.css";

type PersonalAsset = StoryboardPresetDraft & { previewUrl: string };
type Mutation = { action: "draft" | "publish" | "disable"; expectedRevision: number; presetId?: string; draft?: StoryboardPresetDraft };
const roleNames = { character: "人物", pet: "宠物", environment: "场景", prop: "道具 / 商品" };

export function StoryboardPresetsAdminTab({ token, actorId, ready, accessEpoch, onRequestUnlock }: {
  token: string; actorId: string; ready: boolean; accessEpoch: string; onRequestUnlock: () => void;
}) {
  // Unmount the protected session immediately on expiry or identity change.
  if (!ready) return <section className={styles.panel} data-testid="storyboard-presets-locked">
    <h2>平台角色预设</h2><p>审核发布后，用户可在角色参考中选择使用。</p>
    <button type="button" onClick={onRequestUnlock}>验证后管理</button>
  </section>;
  return <PresetSession key={`${actorId}:${token}:${accessEpoch}`} token={token} actorId={actorId} onRequestUnlock={onRequestUnlock} />;
}

function PresetSession({ token, actorId, onRequestUnlock }: { token: string; actorId: string; onRequestUnlock: () => void }) {
  const [catalog, setCatalog] = useState<StoryboardPresetCatalog | null>(null);
  const [assets, setAssets] = useState<PersonalAsset[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [draftPreviews, setDraftPreviews] = useState<Record<string, string>>({});
  const [loadedImages, setLoadedImages] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<StoryboardPresetDraft["role"]>("character");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const lock = useRef(false);
  const pending = useRef<Mutation | null>(null);
  const sequence = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);

  const read = async (url: string, mutation?: Mutation) => {
    const response = await fetch(url, { method: mutation ? "POST" : "GET", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(mutation ? { "Content-Type": "application/json" } : {}) },
      ...(mutation ? { body: JSON.stringify(mutation) } : {}) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (alive.current && (response.status === 401 || response.status === 403)) {
        setBlocked(true); setCatalog(null); setAssets([]); setPreviews({}); setDraftPreviews({}); setLoadedImages({}); setSelectedId(""); setName("");
      }
      const failure = new Error(body.error || "操作未确认，请刷新查询");
      Object.assign(failure, { definitive: response.status >= 400 && response.status < 500 });
      throw failure;
    }
    return body;
  };
  const readCatalog = async () => {
    const payload = await read("/api/admin/storyboard-presets");
    return StoryboardPresetCatalogSchema.parse(payload.catalog);
  };
  const refresh = async () => {
    if (lock.current || blocked) return;
    lock.current = true; setBusy(true); setError("");
    const ownSequence = ++sequence.current;
    try {
      const current = await readCatalog();
      const [personal, published] = await Promise.all([
        read("/api/storyboard/visual-assets?limit=60"), read("/api/storyboard/presets?limit=100"),
      ]);
      if (!alive.current || ownSequence !== sequence.current) return;
      setCatalog(current); setAssets(personal.assets || []); setNextOffset(personal.nextOffset ?? null);
      setPreviews(Object.fromEntries((published.presets || []).map((entry: { presetId: string; previewUrl: string }) => [entry.presetId, entry.previewUrl])));
      const operation = pending.current;
      if (operation) {
        const observed = current.audit.find(item => item.revision === operation.expectedRevision + 1 && item.actorId === actorId && item.action === operation.action && (!operation.presetId || item.presetId === operation.presetId));
        const entry = observed && current.entries.find(item => item.presetId === observed.presetId);
        const matches = operation.action !== "draft" || Boolean(entry?.draft && operation.draft
          && entry.draft.assetId === operation.draft.assetId && entry.draft.name === operation.draft.name && entry.draft.role === operation.draft.role
          && entry.draft.prompt === operation.draft.prompt && entry.draft.customCategory === operation.draft.customCategory
          && JSON.stringify(entry.draft.tags) === JSON.stringify(operation.draft.tags));
        if (observed && matches) { pending.current = null; setUnknown(false); setNotice("原操作已从目录读回确认。"); }
        else setNotice("原操作结果仍待确认；已保留当前目录，暂不重复提交。");
      } else setNotice("已刷新角色预设与个人素材。");
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "读取失败"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => { void refresh(); /* identity is isolated by the keyed parent */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutate = async (operation: Mutation) => {
    if (lock.current || blocked || pending.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice(""); pending.current = operation;
    try {
      const result = await read("/api/admin/storyboard-presets", operation);
      const current = StoryboardPresetCatalogSchema.parse(result.catalog);
      if (!alive.current) return;
      setCatalog(current); pending.current = null; setUnknown(false);
      setNotice(operation.action === "draft" ? "待审稿已保存。核对图片后再点击发布。" : operation.action === "publish" ? "已发布，用户现在可选择此角色。" : "已停用，已生成的作品仍然保留。");
    } catch (failure) {
      if (!alive.current) return;
      const definitive = failure instanceof Error && "definitive" in failure && failure.definitive === true;
      if (definitive) pending.current = null;
      setUnknown(!definitive);
      setError(failure instanceof Error ? failure.message : "保存未确认，请查询原操作");
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const loadMore = async () => {
    if (lock.current || blocked || nextOffset === null) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await read(`/api/storyboard/visual-assets?limit=60&offset=${nextOffset}`);
      if (!alive.current) return;
      setAssets(previous => [...new Map([...previous, ...(result.assets || [])].map(item => [item.assetId, item])).values()]);
      setNextOffset(result.nextOffset ?? null);
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "读取失败"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const loadDraftPreview = async (assetId: string) => {
    if (lock.current || blocked) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const image = await read(`/api/storyboard/image?assetId=${encodeURIComponent(assetId)}`);
      if (!image.url || image.assetId !== assetId) throw new Error("待审图片身份未确认，不能发布");
      if (alive.current) setDraftPreviews(previous => ({ ...previous, [assetId]: image.url }));
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "待审图片读取失败"); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  if (blocked) return <section className={styles.panel}><h2>平台角色预设</h2><p role="alert">管理权限或验证已失效，请重新核对后台权限。</p><button type="button" onClick={onRequestUnlock}>重新验证</button></section>;
  const selected = assets.find(item => item.assetId === selectedId);
  const disabled = busy || unknown || !catalog;
  const entries = catalog?.entries.filter(entry => {
    const data = entry.draft || entry.published;
    return !query.trim() || `${data?.name || ""} ${(data?.tags || []).join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }) || [];
  return <section className={styles.panel} data-testid="storyboard-presets-admin">
    <header><div><h2>平台角色预设</h2><p>从自己的角色库选择图片，保存待审稿后发布。</p></div><button type="button" onClick={() => void refresh()} disabled={busy}>刷新目录</button></header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {unknown && <p className={styles.notice}>操作结果待确认。请刷新查询，系统不会自动重复发布。</p>}
    <div className={styles.editor}>
      <label>已保存的个人图片<select aria-label="预设来源图片" value={selectedId} disabled={disabled} onChange={event => {
        const asset = assets.find(item => item.assetId === event.target.value); setSelectedId(event.target.value); setName(asset?.name || ""); setRole(asset?.role || "character");
      }}><option value="">选择已保存的角色图片</option>{assets.map(asset => <option key={asset.assetId} value={asset.assetId}>{asset.name} · {roleNames[asset.role]}</option>)}</select></label>
      <label>展示名称<input aria-label="预设展示名称" value={name} maxLength={120} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
      <label>分类<select aria-label="预设分类" value={role} disabled={disabled} onChange={event => setRole(event.target.value as StoryboardPresetDraft["role"])}>{Object.entries(roleNames).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
      <button type="button" disabled={disabled || !selected || name.trim().length < 2} onClick={() => {
        if (!selected || !catalog) return;
        if ((selected.prompt || "").length > 10_000) { setError("此图片提示词超过预设库10000字符上限，请先在个人角色库中整理后再发布。原提示词已保留。"); return; }
        const existing = catalog.entries.find(entry => entry.draft?.assetId === selected.assetId && entry.draft.ownerId === actorId);
        void mutate({ action: "draft", expectedRevision: catalog.revision, ...(existing ? { presetId: existing.presetId } : {}), draft: { assetId: selected.assetId, name: name.trim(), role, prompt: selected.prompt || "", tags: selected.tags || [], customCategory: selected.customCategory || "" } });
      }}>保存待审稿</button>
    </div>
    {nextOffset !== null && <button type="button" disabled={busy} onClick={() => void loadMore()}>加载更多个人图片</button>}
    {selected && <a className={styles.selectedPreview} href={selected.previewUrl} target="_blank" rel="noreferrer"><img src={selected.previewUrl} alt={`${selected.name} 待审素材`} />查看完整图片</a>}
    <label className={styles.search}>搜索角色<input value={query} onChange={event => setQuery(event.target.value)} placeholder="名称或标签" /></label>
    <div className={styles.grid}>{entries.map(entry => {
      const data = entry.draft || entry.published!;
      const owned = assets.find(asset => asset.assetId === entry.draft?.assetId);
      const draftAssetId = entry.draft?.assetId;
      const preview = draftAssetId ? owned?.previewUrl || draftPreviews[draftAssetId] : previews[entry.presetId];
      const draftVisible = Boolean(draftAssetId && preview && loadedImages[draftAssetId] === preview);
      return <article key={entry.presetId}>
        {preview ? <a href={preview} target="_blank" rel="noreferrer"><img src={preview} alt={`${data.name}${entry.draft ? " 待审稿" : " 已发布"}`} loading="lazy"
          onLoad={() => { if (draftAssetId) setLoadedImages(previous => ({ ...previous, [draftAssetId]: preview })); }}
          onError={() => { if (draftAssetId) setLoadedImages(previous => ({ ...previous, [draftAssetId]: "" })); }} /></a> : <div className={styles.placeholder}>待审图片尚未读取</div>}
        <div className={styles.details}><h3>{data.name}</h3><p>{roleNames[data.role]} · {entry.disabled ? "已停用" : entry.published ? "已发布" : "待审核"}</p>
          <div className={styles.actions}>
            {entry.draft?.ownerId === actorId && !draftVisible && <button type="button" disabled={busy} onClick={() => void loadDraftPreview(entry.draft!.assetId)}>读取待审图片</button>}
            <button type="button" disabled={disabled || !entry.draft || entry.draft.ownerId !== actorId || !draftVisible} onClick={() => {
              if (catalog && draftVisible && window.confirm(`已核对“${data.name}”三视图完整、身份一致及素材使用权，发布给所有用户？`)) void mutate({ action: "publish", expectedRevision: catalog.revision, presetId: entry.presetId });
            }}>{entry.published ? "发布当前待审稿" : "审核并发布"}</button>
            <button type="button" disabled={disabled || !entry.published || entry.disabled} onClick={() => {
              if (catalog && window.confirm(`停用“${data.name}”？用户将无法用于新生成，已有作品保留。`)) void mutate({ action: "disable", expectedRevision: catalog.revision, presetId: entry.presetId });
            }}>停用</button>
          </div>
        </div>
      </article>;
    })}</div>
    {!busy && !entries.length && <p className={styles.empty}>暂无匹配的角色预设。先在角色参考中生成并保存图片，再来审核发布。</p>}
  </section>;
}
