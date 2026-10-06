"use client";

import {
  AlertTriangle,
  Clapperboard,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { JsonValue, ShortDramaEntity, ShortDramaShot } from "@/lib/short-drama/contracts";
import styles from "./film-studio-entity-panel.module.css";

type StorageMode = "native" | "compat";

interface FilmStudioShotPanelProps {
  projectId: string;
  token: string;
  defaultAspectRatio?: unknown;
  creationBlockedMessage?: string;
  onCountChange?: (count: number) => void;
}

interface ShotEditorState {
  mode: "create" | "edit";
  shotId: string | null;
  expectedRevision: number | null;
  sequence: string;
  sceneKey: string;
  title: string;
  narration: string;
  visualDescription: string;
  imagePrompt: string;
  videoPrompt: string;
  negativePrompt: string;
  durationSeconds: string;
  aspectRatio: ShortDramaShot["aspectRatio"];
  metadata: Record<string, JsonValue>;
  referenceAssetUris: string[];
}

interface ApiFailure extends Error {
  code?: string;
}

const ASPECT_RATIOS: ShortDramaShot["aspectRatio"][] = [
  "9:16",
  "16:9",
  "1:1",
  "4:3",
  "3:4",
  "21:9",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseShot(value: unknown): ShortDramaShot | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string"
    || typeof value.projectId !== "string"
    || typeof value.sequence !== "number"
    || typeof value.title !== "string"
    || typeof value.revision !== "number"
  ) return null;
  return value as unknown as ShortDramaShot;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function apiFailure(payload: unknown, fallback: string): ApiFailure {
  const failure = new Error(
    isRecord(payload) && typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : fallback,
  ) as ApiFailure;
  if (isRecord(payload) && typeof payload.code === "string") failure.code = payload.code;
  return failure;
}

function isShotEditable(shot: ShortDramaShot): boolean {
  return shot.status !== "generating" && shot.status !== "completed";
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 9)
    : [];
}

function parseEntity(value: unknown): ShortDramaEntity | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return value as unknown as ShortDramaEntity;
}

function storageKeyFromUri(uri: string): string {
  const prefix = "object://tencent_cos/";
  if (!uri.startsWith(prefix)) return "";
  try { return decodeURIComponent(uri.slice(prefix.length)); } catch { return ""; }
}

function entityReferenceVersions(entity: ShortDramaEntity): Array<{ id: string; name: string; uri: string }> {
  const stored = Array.isArray(entity.attributes.assetVersions) ? entity.attributes.assetVersions : [];
  const candidates = stored.flatMap((value, index) => {
    if (!isRecord(value) || typeof value.uri !== "string" || !value.uri.trim()) return [];
    const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : `版本 ${index + 1}`;
    return [{ id: `${entity.id}:${typeof value.id === "string" ? value.id : index}`, name: `${entity.name} · ${label}`, uri: value.uri.trim() }];
  });
  if (entity.referenceAssetUri && !candidates.some((candidate) => candidate.uri === entity.referenceAssetUri)) {
    candidates.unshift({ id: `${entity.id}:current`, name: `${entity.name} · 当前版本`, uri: entity.referenceAssetUri });
  }
  return candidates.filter((candidate, index, all) => all.findIndex((item) => item.uri === candidate.uri) === index);
}

function editorFromShot(shot: ShortDramaShot): ShotEditorState {
  return {
    mode: "edit",
    shotId: shot.id,
    expectedRevision: shot.revision,
    sequence: String(shot.sequence),
    sceneKey: shot.sceneKey || "",
    title: shot.title,
    narration: shot.narration,
    visualDescription: shot.visualDescription,
    imagePrompt: shot.imagePrompt,
    videoPrompt: shot.videoPrompt,
    negativePrompt: shot.negativePrompt,
    durationSeconds: String(shot.durationSeconds),
    aspectRatio: shot.aspectRatio,
    metadata: { ...shot.metadata },
    referenceAssetUris: stringArray(shot.metadata.referenceAssetUris),
  };
}

export function FilmStudioShotPanel({
  projectId,
  token,
  defaultAspectRatio,
  creationBlockedMessage,
  onCountChange,
}: FilmStudioShotPanelProps) {
  const endpoint = `/api/short-drama/projects/${encodeURIComponent(projectId)}/shots`;
  const [shots, setShots] = useState<ShortDramaShot[]>([]);
  const [storageMode, setStorageMode] = useState<StorageMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<ShotEditorState | null>(null);
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [references, setReferences] = useState<Array<{
    id: string;
    name: string;
    uri: string;
    previewUrl: string;
  }>>([]);

  const loadShots = useCallback(async (options?: { silent?: boolean; signal?: AbortSignal }) => {
    if (options?.silent) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(`${endpoint}?limit=500&offset=0`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: options?.signal,
      });
      const payload = await readJson(response);
      if (!response.ok) throw apiFailure(payload, "分镜草稿读取失败");
      const list = isRecord(payload) && Array.isArray(payload.shots)
        ? payload.shots.map(parseShot).filter((item): item is ShortDramaShot => Boolean(item))
        : [];
      const mode = isRecord(payload) && (payload.storageMode === "native" || payload.storageMode === "compat")
        ? payload.storageMode
        : response.headers.get("X-Short-Drama-Storage-Mode");
      setShots(list);
      setStorageMode(mode === "compat" ? "compat" : "native");
      setError(null);
      onCountChange?.(list.length);
    } catch (cause) {
      if (!options?.signal?.aborted) {
        setError(cause instanceof Error ? cause as ApiFailure : apiFailure({}, "分镜草稿读取失败"));
      }
    } finally {
      if (!options?.signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [endpoint, onCountChange, token]);

  useEffect(() => {
    const controller = new AbortController();
    void loadShots({ signal: controller.signal });
    return () => controller.abort();
  }, [loadShots]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/short-drama/projects/${encodeURIComponent(projectId)}/entities`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await readJson(response);
      if (!response.ok || !isRecord(payload) || !Array.isArray(payload.entities)) return [];
      const entities = payload.entities.map(parseEntity).filter((item): item is ShortDramaEntity => Boolean(item));
      const versions = entities.flatMap(entityReferenceVersions);
      return Promise.all(versions.map(async (version) => {
        const uri = version.uri;
        if (/^https:\/\//iu.test(uri)) return { ...version, previewUrl: uri };
        const key = storageKeyFromUri(uri);
        if (!key) return { ...version, previewUrl: "" };
        const signed = await fetch(`/api/file?key=${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        const signedPayload = await readJson(signed);
        return {
          ...version,
          previewUrl: signed.ok && isRecord(signedPayload) && typeof signedPayload.url === "string"
            ? signedPayload.url
            : "",
        };
      }));
    }).then((items) => {
      if (!controller.signal.aborted) setReferences(items.filter((item) => Boolean(item.uri)));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [projectId, token]);

  function openNew() {
    if (creationBlockedMessage) {
      setError(apiFailure({
        code: "EPISODE_CONFIRM_REQUIRED_FOR_STORYBOARD",
        error: creationBlockedMessage,
      }, creationBlockedMessage));
      return;
    }
    const nextSequence = shots.reduce((maximum, shot) => Math.max(maximum, shot.sequence), 0) + 1;
    setNotice("");
    setEditor({
      mode: "create",
      shotId: null,
      expectedRevision: null,
      sequence: String(nextSequence),
      sceneKey: "",
      title: `镜头 ${nextSequence}`,
      narration: "",
      visualDescription: "",
      imagePrompt: "",
      videoPrompt: "",
      negativePrompt: "",
      durationSeconds: "5",
      aspectRatio: typeof defaultAspectRatio === "string" && ASPECT_RATIOS.includes(defaultAspectRatio as ShortDramaShot["aspectRatio"])
        ? defaultAspectRatio as ShortDramaShot["aspectRatio"]
        : "9:16",
      metadata: {},
      referenceAssetUris: [],
    });
  }

  function toggleReference(uri: string) {
    setEditor((current) => {
      if (!current) return current;
      const selected = current.referenceAssetUris.includes(uri);
      return {
        ...current,
        referenceAssetUris: selected
          ? current.referenceAssetUris.filter((item) => item !== uri)
          : current.referenceAssetUris.length < 9
            ? [...current.referenceAssetUris, uri]
            : current.referenceAssetUris,
      };
    });
  }

  function updateEditor<Key extends keyof ShotEditorState>(key: Key, value: ShotEditorState[Key]) {
    setEditor((current) => current ? { ...current, [key]: value } : current);
  }

  async function saveEditor() {
    if (!editor || pending) return;
    const sequence = Number(editor.sequence);
    const durationSeconds = Number(editor.durationSeconds);
    if (!Number.isInteger(sequence) || sequence < 1 || !editor.title.trim()) return;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 120) return;

    setPending("save");
    setNotice("");
    try {
      const editing = editor.mode === "edit" && editor.shotId && editor.expectedRevision;
      const response = await fetch(
        editing ? `${endpoint}/${encodeURIComponent(editor.shotId || "")}` : endpoint,
        {
          method: editing ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ...(editing ? { expectedRevision: editor.expectedRevision } : {}),
            sequence,
            sceneKey: editor.sceneKey.trim() || null,
            title: editor.title.trim(),
            narration: editor.narration.trim(),
            visualDescription: editor.visualDescription.trim(),
            imagePrompt: editor.imagePrompt.trim(),
            videoPrompt: editor.videoPrompt.trim(),
            negativePrompt: editor.negativePrompt.trim(),
            durationSeconds,
            aspectRatio: editor.aspectRatio,
            metadata: {
              ...editor.metadata,
              referenceAssetUris: editor.referenceAssetUris,
            },
          }),
        },
      );
      const payload = await readJson(response);
      if (!response.ok) throw apiFailure(payload, "分镜草稿保存失败");
      setEditor(null);
      setNotice(editing ? "分镜草稿已更新并完成写后读回校验。" : "分镜草稿已创建并完成写后读回校验。");
      await loadShots({ silent: true });
    } catch (cause) {
      const failure = cause instanceof Error ? cause as ApiFailure : apiFailure({}, "分镜草稿保存失败");
      setError(failure);
      if (failure.code === "SHOT_REVISION_CONFLICT") {
        setEditor(null);
        await loadShots({ silent: true });
      }
    } finally {
      setPending(null);
    }
  }

  async function deleteShot(shot: ShortDramaShot) {
    const modeNote = storageMode === "compat"
      ? "该草稿会保留恢复记录。"
      : "已有制作记录的镜头不会被移除。";
    if (pending || !window.confirm(`确认移除镜头 ${shot.sequence}“${shot.title}”？${modeNote}`)) return;
    setPending("delete");
    setNotice("");
    try {
      const response = await fetch(
        `${endpoint}/${encodeURIComponent(shot.id)}?expectedRevision=${shot.revision}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      const payload = await readJson(response);
      if (!response.ok) throw apiFailure(payload, "分镜草稿移除失败");
      setNotice(storageMode === "compat"
        ? "分镜草稿已移除，并保留恢复记录。"
        : "分镜草稿已移除。");
      await loadShots({ silent: true });
    } catch (cause) {
      const failure = cause instanceof Error ? cause as ApiFailure : apiFailure({}, "分镜草稿移除失败");
      setError(failure);
      if (failure.code === "SHOT_REVISION_CONFLICT") await loadShots({ silent: true });
    } finally {
      setPending(null);
    }
  }

  if (loading) {
    return (
      <section className={styles.panel} data-testid="film-project-storyboard-crud">
        <div className={styles.loading}><LoaderCircle size={24} />正在读取真实分镜草稿…</div>
      </section>
    );
  }

  return (
    <section className={styles.panel} data-testid="film-project-storyboard-crud">
      <div className={styles.header}>
        <div>
          <span className={styles.eyebrow}>第 5 步 · 分镜管理</span>
          <h2><Clapperboard size={22} />分镜草稿</h2>
          <p>在这里整理镜头、提示词和参考素材；确认后再进入成片制作。</p>
        </div>
        <div className={styles.actions}>
          <span className={styles.modeBadge} data-mode={storageMode || "unknown"}>
            {storageMode === "compat" ? "草稿可保存" : "制作服务可用"}
          </span>
          <button
            type="button"
            disabled={Boolean(creationBlockedMessage)}
            title={creationBlockedMessage || "新建镜头"}
            onClick={openNew}
          ><Plus size={16} />新建镜头</button>
          <button
            type="button"
            aria-label="刷新分镜草稿"
            disabled={refreshing}
            onClick={() => void loadShots({ silent: true })}
          >
            <RefreshCw className={refreshing ? styles.spinning : undefined} size={16} />
          </button>
        </div>
      </div>

      {storageMode === "compat" && (
        <div className={styles.compatNotice} data-storage-mode="compat">
          <AlertTriangle size={18} />
          <span>
            当前可以编辑和保存分镜草稿；成片制作服务正在准备中，暂不会提交生成或产生费用。
          </span>
        </div>
      )}

      {creationBlockedMessage && (
        <div className={styles.compatNotice} data-storyboard-readiness="blocked">
          <AlertTriangle size={18} />
          <span>{creationBlockedMessage}。保存定稿状态后即可新建分镜或建立镜头计划。</span>
        </div>
      )}

      {error && (
        <div className={styles.error} role="alert" data-code={error.code || "UNKNOWN"}>
          <AlertTriangle size={18} />
          <span>{error.message}</span>
          <button type="button" onClick={() => setError(null)}>关闭</button>
        </div>
      )}
      {notice && <div className={styles.notice}>{notice}</div>}

      {editor && (
        <div className={styles.editor} data-editor-mode={editor.mode}>
          <div className={styles.editorHeader}>
            <div>
              <span>{editor.mode === "edit" ? `版本 ${editor.expectedRevision}` : "新分镜"}</span>
              <h3>{editor.mode === "edit" ? "编辑分镜草稿" : "创建分镜草稿"}</h3>
            </div>
            <button type="button" aria-label="关闭分镜编辑器" onClick={() => setEditor(null)}><X size={17} /></button>
          </div>
          <div className={styles.formGrid}>
            <label>
              <span>镜头序号 *</span>
              <input min={1} max={10_000} type="number" value={editor.sequence} onChange={(event) => updateEditor("sequence", event.target.value)} />
            </label>
            <label>
              <span>场景标识</span>
              <input maxLength={120} value={editor.sceneKey} onChange={(event) => updateEditor("sceneKey", event.target.value)} />
            </label>
            <label className={styles.wide}>
              <span>镜头标题 *</span>
              <input maxLength={200} value={editor.title} onChange={(event) => updateEditor("title", event.target.value)} />
            </label>
            <label>
              <span>时长（秒，最多 120）</span>
              <input min={0.001} max={120} step={0.001} type="number" value={editor.durationSeconds} onChange={(event) => updateEditor("durationSeconds", event.target.value)} />
            </label>
            <label>
              <span>画幅</span>
              <select aria-label="分镜画幅" value={editor.aspectRatio} onChange={(event) => updateEditor("aspectRatio", event.target.value as ShortDramaShot["aspectRatio"])}>
                {ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
              </select>
            </label>
            <label className={styles.wide}>
              <span>旁白 / 台词</span>
              <textarea maxLength={12_000} value={editor.narration} onChange={(event) => updateEditor("narration", event.target.value)} />
            </label>
            <label className={styles.wide}>
              <span>画面描述</span>
              <textarea maxLength={20_000} value={editor.visualDescription} onChange={(event) => updateEditor("visualDescription", event.target.value)} />
            </label>
            <label className={styles.wide}>
              <span>图片提示词</span>
              <textarea maxLength={30_000} value={editor.imagePrompt} onChange={(event) => updateEditor("imagePrompt", event.target.value)} />
            </label>
            <label className={styles.wide}>
              <span>视频提示词</span>
              <textarea maxLength={30_000} value={editor.videoPrompt} onChange={(event) => updateEditor("videoPrompt", event.target.value)} />
            </label>
            <label className={styles.wide}>
              <span>负面提示词</span>
              <textarea maxLength={12_000} value={editor.negativePrompt} onChange={(event) => updateEditor("negativePrompt", event.target.value)} />
            </label>
          </div>
          <div className={styles.referencePicker} data-testid="film-shot-reference-picker">
            <div>
              <strong>镜头参考素材 · 最多 9 张</strong>
              <span>从角色、场景和道具档案的当前图片版本中选择；保存后写入镜头 metadata。</span>
            </div>
            <div className={styles.referenceOptions}>
              {references.map((reference) => {
                const selected = editor.referenceAssetUris.includes(reference.uri);
                return (
                  <button
                    type="button"
                    data-selected={selected ? "true" : undefined}
                    disabled={!selected && editor.referenceAssetUris.length >= 9}
                    key={reference.id}
                    onClick={() => toggleReference(reference.uri)}
                  >
                    {reference.previewUrl
                      ? <img src={reference.previewUrl} alt="" />
                      : <span>{reference.name.slice(0, 1)}</span>}
                    <strong>{reference.name}</strong>
                  </button>
                );
              })}
              {references.length === 0 && <span className={styles.versionEmpty}>实体档案还没有已保存的图片版本。</span>}
            </div>
            <small>已选择 {editor.referenceAssetUris.length} / 9</small>
          </div>
          <div className={styles.editorFooter}>
            <span>客户端不能改写 status、revision、userId 或生产历史。</span>
            <button type="button" disabled={pending !== null || !editor.title.trim()} onClick={() => void saveEditor()}>
              {pending === "save" ? <LoaderCircle className={styles.spinning} size={16} /> : <Save size={16} />}
              保存分镜
            </button>
          </div>
        </div>
      )}

      <div className={styles.grid}>
        {shots.map((shot) => {
          const editable = isShotEditable(shot);
          return (
            <article className={styles.card} key={shot.id} data-shot-status={shot.status}>
              <div className={styles.cardHeading}>
                <span><Clapperboard size={18} /></span>
                <div><small>镜头 {shot.sequence} · {shot.status} · 版本 {shot.revision}</small><h3>{shot.title}</h3></div>
              </div>
              <p>{shot.visualDescription || shot.narration || "未填写画面描述"}</p>
              <dl>
                <div><dt>场景</dt><dd>{shot.sceneKey || "未填写"}</dd></div>
                <div><dt>时长 / 画幅</dt><dd>{shot.durationSeconds} 秒 · {shot.aspectRatio}</dd></div>
                <div><dt>图片提示词</dt><dd>{shot.imagePrompt || "未填写"}</dd></div>
                <div><dt>视频提示词</dt><dd>{shot.videoPrompt || "未填写"}</dd></div>
                <div><dt>参考素材</dt><dd>{stringArray(shot.metadata.referenceAssetUris).length} / 9 张</dd></div>
              </dl>
              <div className={styles.cardActions}>
                <button type="button" disabled={!editable} title={editable ? "编辑镜头" : "生产中的镜头已锁定"} onClick={() => setEditor(editorFromShot(shot))}><Pencil size={15} />编辑</button>
                <button type="button" disabled={!editable || pending !== null} title={editable ? "移除无生产历史的镜头" : "生产中的镜头已锁定"} onClick={() => void deleteShot(shot)}><Trash2 size={15} />移除</button>
              </div>
            </article>
          );
        })}
      </div>

      {shots.length === 0 && (
        <div className={styles.empty}>
          <Clapperboard size={28} />
          <strong>暂无分镜</strong>
          <span>可以手动新建镜头；成片制作服务可用后再提交生成。</span>
        </div>
      )}
    </section>
  );
}
