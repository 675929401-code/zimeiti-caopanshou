'use client';

import { useEffect, useState } from 'react';
import { PERSON_ASSET_PREFLIGHT_COPY, type PersonAssetPreflight as Preflight } from './asset-preflight-contract';
import styles from './PersonAssetPreflight.module.css';

type Candidate = { id: string; displayName: string; capabilities: Record<string, unknown> };

/** Inspection remains reachable while a dedicated model's generation is gated. */
export function PersonAssetPreflightPicker({ models, assetId, token }: { models: Candidate[]; assetId: string; token: string }) {
  const [inspectionModelId, setInspectionModelId] = useState('');
  const candidates = models.filter(model => model.capabilities.supportsPersonAssetPreflight === true);
  const chosen = candidates.find(model => model.id === inspectionModelId);
  if (!candidates.length) return null;
  return <section className={styles.card} aria-label="真人素材登记状态查询">
    <label className={styles.label}>选择模型查看素材登记状态<select className={styles.select} aria-label="素材预检模型" value={chosen?.id || ''} onChange={event => setInspectionModelId(event.target.value)}>
      <option value="">请选择要查询的模型</option>
      {candidates.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
    </select></label>
    <p className={styles.hint}>可查询尚未开放生成的模型；此处选择只用于素材状态查询。</p>
    {chosen && <PersonAssetPreflight key={`${chosen.id}:${assetId}`} modelId={chosen.id} assetId={assetId} token={token} />}
  </section>;
}

export function PersonAssetPreflight({ modelId, assetId, token }: { modelId: string; assetId: string; token: string }) {
  const [snapshot, setSnapshot] = useState<{ key: string; value: Preflight | null }>({ key: '', value: null });
  const key = `${modelId}:${assetId}`;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const query = new URLSearchParams({ id: assetId, model: modelId });
        const response = await fetch(`/api/digital-human/assets/preflight?${query}`, {
          method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal,
        });
        const body = await response.json();
        const value = response.ok && body.preflight && body.preflight.ownership === 'owned'
          && body.preflight.generationAuthorized === false && body.preflight.content === 'unverified'
          && Object.hasOwn(PERSON_ASSET_PREFLIGHT_COPY, body.preflight.cache)
          && ['matched', 'unmatched', 'unverified'].includes(body.preflight.version)
          && ['verified', 'unverified'].includes(body.preflight.fee) ? body.preflight as Preflight : null;
        if (!controller.signal.aborted) setSnapshot({ key, value });
      } catch {
        if (!controller.signal.aborted) setSnapshot({ key, value: null });
      }
    })();
    return () => controller.abort();
  }, [modelId, assetId, token, key]);
  const loaded = snapshot.key === key;
  const value = loaded ? snapshot.value : null;
  return <aside className={styles.status} aria-label="真人素材登记预检" aria-live="polite">
    <strong className={styles.title}>真人素材登记预检</strong>
    {!loaded ? <p>正在核对当前账号的素材与登记状态…</p> : !value ? <p>素材预检暂时无法完成，请重新选择或稍后重试。</p> : <>
      <p>已确认是当前账号的图片。当前图片仍需在生成前完成验证。</p>
      <p>{value.cache === 'ready_record' ? '已有可复用的素材登记记录。' : PERSON_ASSET_PREFLIGHT_COPY[value.cache]}</p>
      <p>{value.fee === 'verified' ? '素材登记费用已确认，仍需在生成前完成验证。' : '素材登记费用尚未确认，暂不能提交生成。'}</p>
    </>}
    <p>本次仅查询已有状态，不会上传或登记素材。</p>
  </aside>;
}
