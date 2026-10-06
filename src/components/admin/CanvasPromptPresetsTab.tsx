"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  FlaskConical,
  History,
  LoaderCircle,
  Power,
  RotateCcw,
  Save,
  Send,
} from "lucide-react";
import type { CanvasPromptPreset, CanvasPromptPresetStore, PromptPresetContent } from "@/lib/canvas-prompt-presets";

type Props = { token: string | null };
type LlmModel = { id: string; name: string; model_name: string; is_active?: boolean };

const FIELD_CONFIG: Array<{ key: keyof PromptPresetContent; label: string; hint: string; rows: number }> = [
  { key: "segmentationRules", label: "拆镜规则", hint: "定义什么时候切镜、语速和语义完整性。", rows: 4 },
  { key: "characterRules", label: "角色一致性", hint: "锁定人物、动物、服装和辨识特征。", rows: 4 },
  { key: "sceneRules", label: "场景与构图", hint: "规定单一场景、光线、景别和空间连续。", rows: 4 },
  { key: "imageRules", label: "参考图提示词", hint: "决定静态关键帧的细节和审美方向。", rows: 5 },
  { key: "motionRules", label: "动态运镜", hint: "规定动作数量、运镜类型和节奏。", rows: 4 },
  { key: "videoRules", label: "视频生成", hint: "约束连续性、动作完整性和剪辑落点。", rows: 4 },
  { key: "negativeRules", label: "禁止事项", hint: "统一排除变形、漂移和无关内容。", rows: 4 },
  { key: "firstLastFrameRules", label: "首尾帧规则", hint: "定义首帧、尾帧和中间动作的连续关系。", rows: 4 },
];

const TEST_SCRIPT = "主人准备出门，把零食放在客厅。金毛先开心地跑过去，随后发现房门已经关上，耳朵慢慢垂下来。";
const PREFERRED_PRESET_ID = "anime_story";

function clonePreset(preset: CanvasPromptPreset): CanvasPromptPreset {
  return JSON.parse(JSON.stringify(preset)) as CanvasPromptPreset;
}

export function CanvasPromptPresetsTab({ token }: Props) {
  const [store, setStore] = useState<CanvasPromptPresetStore | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState<CanvasPromptPreset | null>(null);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [testScript, setTestScript] = useState(TEST_SCRIPT);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token || ""}`,
    "Content-Type": "application/json",
  }), [token]);

  const load = useCallback(async () => {
    setBusy("load");
    try {
      const [presetResponse, modelResponse] = await Promise.all([
        fetch("/api/admin/canvas-prompt-presets", { headers }),
        fetch("/api/llm-models", { headers }),
      ]);
      const presetData = await presetResponse.json();
      if (!presetResponse.ok) throw new Error(presetData.error || "提示词方案加载失败");
      const nextStore = presetData as CanvasPromptPresetStore;
      setStore(nextStore);
      setSelectedId((current) => {
        const nextId = current && nextStore.presets.some((item) => item.id === current)
          ? current
          : nextStore.presets.find((item) => item.id === PREFERRED_PRESET_ID)?.id || nextStore.presets[0]?.id || "";
        const nextPreset = nextStore.presets.find((item) => item.id === nextId) || nextStore.presets[0];
        if (nextPreset) setEditing(clonePreset(nextPreset));
        return nextId;
      });
      if (modelResponse.ok) {
        const modelData = await modelResponse.json();
        setModels(modelData.models || []);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "加载失败");
    } finally {
      setBusy("");
    }
  }, [headers]);

  useEffect(() => { void load(); }, [load]);

  function selectPreset(preset: CanvasPromptPreset) {
    setSelectedId(preset.id);
    setEditing(clonePreset(preset));
    setTestResult(null);
    setNotice("");
  }

  async function runAction(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setNotice("");
    try {
      const response = await fetch("/api/admin/canvas-prompt-presets", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "操作失败");
      if (body.action === "test") {
        setTestResult(data);
        setNotice("测试完成：下方已显示结构化拆镜结果");
      } else {
        const nextStore = data.store as CanvasPromptPresetStore;
        setStore(nextStore);
        const next = nextStore.presets.find((item) => item.id === selectedId) || nextStore.presets.at(-1) || null;
        if (next) {
          setSelectedId(next.id);
          setEditing(clonePreset(next));
        }
        setNotice(label === "publish" ? "新版本已发布，画布将使用这个版本" : "已保存");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy("");
    }
  }

  if (!store || !editing) {
    return <div className="flex min-h-[420px] items-center justify-center text-sm text-[var(--muted-foreground)]"><LoaderCircle className="mr-2 animate-spin" size={18} />正在加载提示词方案</div>;
  }

  const dirty = JSON.stringify(editing) !== JSON.stringify(store.presets.find((item) => item.id === editing.id));
  const isDirectorPreset = editing.id === "anime_story";
  const visiblePresets = [...store.presets].sort((left, right) => {
    if (left.id === PREFERRED_PRESET_ID) return -1;
    if (right.id === PREFERRED_PRESET_ID) return 1;
    return 0;
  });
  const adapterPrompt = FIELD_CONFIG.map((field) => `【${field.label}】\n${editing.draft[field.key]}`).join("\n\n");
  const fullPrompt = isDirectorPreset && editing.draft.directorPrompt.trim()
    ? `${editing.draft.directorPrompt}\n\n## 平台适配补充规则\n${adapterPrompt}`
    : adapterPrompt;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">画布提示词中心</h2>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">只有管理员能修改。用户只能选择已启用、已发布的官方方案。</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm" onClick={() => runAction({ action: "duplicate", presetId: editing.id }, "duplicate")} disabled={Boolean(busy)}><Copy size={15} />复制方案</button>
          <button className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm" onClick={() => runAction({ action: "toggle", presetId: editing.id }, "toggle")} disabled={Boolean(busy)}><Power size={15} />{editing.enabled ? "停用" : "启用"}</button>
        </div>
      </div>

      {notice && <div className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]">{notice}</div>}

      <div className="grid min-h-[660px] grid-cols-1 gap-4 xl:grid-cols-[260px_minmax(0,1fr)_320px]">
        <aside className="border-r border-[var(--border)] pr-3">
          <div className="mb-2 text-xs font-semibold text-[var(--muted-foreground)]">官方方案</div>
          <div className="space-y-2">
            {visiblePresets.map((preset) => (
              <button key={preset.id} onClick={() => selectPreset(preset)} className={`w-full rounded-md border p-3 text-left transition-colors ${preset.id === selectedId ? "border-[var(--primary)] bg-[var(--accent)]" : "border-[var(--border)] bg-[var(--card)] hover:bg-[var(--accent)]"}`}>
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm text-[var(--foreground)]">{preset.name}</strong>
                  <span className={`h-2 w-2 rounded-full ${preset.enabled ? "bg-emerald-500" : "bg-zinc-500"}`} />
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-[var(--muted-foreground)]">{preset.summary}</p>
                <span className="mt-2 block text-[11px] text-[var(--muted-foreground)]">{preset.category} · v{preset.version}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-xs text-[var(--muted-foreground)]">方案名称<input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
            <label className="text-xs text-[var(--muted-foreground)]">分类<input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value })} /></label>
            <label className="text-xs text-[var(--muted-foreground)] md:col-span-2">用户看到的说明<input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={editing.summary} onChange={(event) => setEditing({ ...editing, summary: event.target.value })} /></label>
            <label className="text-xs text-[var(--muted-foreground)]">主模型<select className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={editing.primaryModel} onChange={(event) => setEditing({ ...editing, primaryModel: event.target.value })}><option value="">沿用平台默认模型</option>{models.map((model) => <option key={model.id} value={model.model_name}>{model.name || model.model_name}</option>)}</select></label>
            <label className="text-xs text-[var(--muted-foreground)]">备用模型<select className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={editing.fallbackModel} onChange={(event) => setEditing({ ...editing, fallbackModel: event.target.value })}><option value="">未设置</option>{models.map((model) => <option key={model.id} value={model.model_name}>{model.name || model.model_name}</option>)}</select></label>
          </div>

          {isDirectorPreset && (
            <label className="block rounded-md border border-[var(--primary)]/60 bg-[var(--card)] p-3">
              <span className="flex flex-wrap items-baseline justify-between gap-3">
                <strong className="text-sm text-[var(--foreground)]">动漫剧情导演完整提示词</strong>
                <small className="text-[11px] text-[var(--muted-foreground)]">后台可维护的智能体母体；画布拆解时优先使用已发布版本。</small>
              </span>
              <textarea
                rows={28}
                className="mt-2 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs leading-5 text-[var(--foreground)]"
                value={editing.draft.directorPrompt}
                onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, directorPrompt: event.target.value } })}
              />
            </label>
          )}

          <details className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3" open={!isDirectorPreset}>
            <summary className="cursor-pointer text-sm font-medium text-[var(--foreground)]">
              {isDirectorPreset ? "平台适配补充规则" : "提示词分段规则"}
            </summary>
            <div className="mt-3 space-y-4">
              {FIELD_CONFIG.map((field) => (
                <label key={field.key} className="block rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
                  <span className="flex items-baseline justify-between gap-3"><strong className="text-sm text-[var(--foreground)]">{field.label}</strong><small className="text-[11px] text-[var(--muted-foreground)]">{field.hint}</small></span>
                  <textarea rows={field.rows} className="mt-2 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm leading-6 text-[var(--foreground)]" value={editing.draft[field.key]} onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, [field.key]: event.target.value } })} />
                </label>
              ))}
            </div>
          </details>

          <details className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
            <summary className="cursor-pointer text-sm font-medium text-[var(--foreground)]">查看完整提示词</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-3 text-xs leading-5 text-[var(--secondary-foreground)]">{fullPrompt}</pre>
          </details>
        </main>

        <aside className="space-y-4 border-l border-[var(--border)] pl-3">
          <section className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]"><FlaskConical size={16} />发布前测试</div>
            <textarea rows={6} className="mt-3 w-full rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-xs leading-5 text-[var(--foreground)]" value={testScript} onChange={(event) => setTestScript(event.target.value)} />
            <button className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm" disabled={Boolean(busy)} onClick={() => runAction({ action: "test", preset: editing, script: testScript, style: "高质量3D动画", ratio: "16:9" }, "test")}><FlaskConical size={15} />测试草稿</button>
            {testResult && <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--background)] p-2 text-[11px] leading-5 text-[var(--secondary-foreground)]">{JSON.stringify(testResult, null, 2)}</pre>}
          </section>

          <section className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="text-sm font-semibold text-[var(--foreground)]">版本操作</div>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">当前线上版本 v{editing.version}。先保存草稿、测试，再发布。</p>
            <div className="mt-3 grid gap-2">
              <button className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50" disabled={!dirty || Boolean(busy)} onClick={() => runAction({ action: "save-draft", presetId: editing.id, patch: { name: editing.name, summary: editing.summary, category: editing.category, accent: editing.accent, primaryModel: editing.primaryModel, fallbackModel: editing.fallbackModel, draft: editing.draft } }, "save")}><Save size={15} />保存草稿</button>
              <button className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={dirty || Boolean(busy)} onClick={() => runAction({ action: "publish", presetId: editing.id }, "publish")}><Send size={15} />发布为 v{editing.version + 1}</button>
            </div>
          </section>

          <section className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]"><History size={16} />历史版本</div>
            <div className="mt-2 space-y-2">
              {editing.history.length === 0 && <p className="text-xs text-[var(--muted-foreground)]">发布下一版后，这里会保存旧版本。</p>}
              {editing.history.map((item) => (
                <div key={`${item.version}-${item.publishedAt}`} className="flex items-center justify-between rounded-md border border-[var(--border)] px-2 py-2">
                  <span className="text-xs text-[var(--secondary-foreground)]">v{item.version}</span>
                  <button title="恢复到草稿" onClick={() => runAction({ action: "rollback", presetId: editing.id, version: item.version }, "rollback")} className="rounded p-1 hover:bg-[var(--accent)]"><RotateCcw size={14} /></button>
                </div>
              ))}
            </div>
          </section>

          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)]"><CheckCircle2 className="mt-0.5 shrink-0 text-emerald-500" size={15} />旧项目绑定生成时的版本；发布新版本不会破坏已经完成的作品。</div>
        </aside>
      </div>
    </div>
  );
}
