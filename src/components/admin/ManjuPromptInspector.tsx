"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Copy,
  ExternalLink,
  FileCode2,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";

interface PromptEditTarget {
  type: "admin_route" | "source_file";
  label: string;
  value: string;
}

interface PromptRecord {
  id: string;
  name: string;
  source: string;
  version: string;
  hash: string;
  editable: boolean;
  runtime_authoritative: boolean;
  content: string;
  kind: "manga_base" | "manga_effective" | "manju_prompt_policy";
  edit_target: PromptEditTarget;
  runtime_effect: string;
  release_id?: string | null;
  enabled?: boolean;
}

interface PromptSourceStatus {
  id: string;
  name: string;
  state: "ready" | "fallback" | "unavailable";
  count: number;
  message: string;
}

interface PromptRegistryResponse {
  ok?: boolean;
  state?: "ready" | "degraded";
  registry_version?: string;
  generated_at?: string;
  prompts?: PromptRecord[];
  sources?: PromptSourceStatus[];
  code?: string;
  error?: string;
}

interface Props {
  token: string | null;
}

const KIND_LABELS: Record<PromptRecord["kind"], string> = {
  manga_base: "代码回退基线",
  manga_effective: "当前实际生效",
  manju_prompt_policy: "已发布 prompt 域",
};

function shortHash(hash: string): string {
  if (!hash) return "未计算";
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}

function formattedTime(value: string | undefined): string {
  if (!value) return "时间未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("COPY_FAILED");
}

export function ManjuPromptInspector({ token }: Props) {
  const [data, setData] = useState<PromptRegistryResponse | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      if (!token) throw new Error("管理员会话缺失，请重新登录后再试。");
      const response = await fetch("/api/admin/manju-workbench/prompts", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const body = await response.json().catch(() => ({})) as PromptRegistryResponse;
      if (!response.ok) throw new Error(body.error || "提示词事实源读取失败");
      setData({
        ...body,
        prompts: Array.isArray(body.prompts) ? body.prompts : [],
        sources: Array.isArray(body.sources) ? body.sources : [],
      });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setData(null);
      setError(reason instanceof Error ? reason.message : "提示词事实源读取失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const prompts = data?.prompts || [];
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visiblePrompts = useMemo(() => {
    if (!normalizedQuery) return prompts;
    return prompts.filter((prompt) => [
      prompt.name,
      prompt.id,
      prompt.source,
      prompt.version,
      prompt.release_id || "",
      prompt.content,
    ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));
  }, [normalizedQuery, prompts]);

  const authoritativeCount = prompts.filter((prompt) => prompt.runtime_authoritative).length;
  const editableCount = prompts.filter((prompt) => prompt.editable).length;
  const effectiveMangaPrompt = prompts.find((prompt) => prompt.kind === "manga_effective" && prompt.runtime_authoritative);
  const mangaFallbackBase = prompts.find((prompt) => prompt.kind === "manga_base");
  const publishedPromptDomain = prompts.find((prompt) => prompt.kind === "manju_prompt_policy");

  async function handleCopy(prompt: PromptRecord) {
    try {
      await copyText(prompt.content);
      setCopiedId(prompt.id);
      window.setTimeout(() => setCopiedId((current) => current === prompt.id ? "" : current), 1800);
    } catch {
      setError("复制失败，请展开提示词后手动选择复制。");
    }
  }

  return (
    <section
      className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4"
      data-admin-section="manju-prompt-inspector"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
            <ShieldCheck size={18} className="text-emerald-500" />
            漫剧提示词事实源检查器
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--muted-foreground)]">
            只读对照漫剧工作台自己的创作 Agent 提示词：当前实际生效内容、代码回退基线、已发布 Manju prompt 域。这里不会混入主站智能体卡片、Skill 应用广场或通用画布方案，也不会保存、发布或调用模型。
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] disabled:opacity-50"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          {loading ? "读取中" : "刷新事实源"}
        </button>
      </header>

      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)]">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
        <span>
          铁律：主站 Agent、Skill 应用广场和通用画布方案不属于漫剧工作台提示词事实源。本检查器本身永远只读；真正修改请回到“漫剧配置中心”的 prompt 域保存草稿、发布和回滚。
        </span>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600" role="alert">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" />
          <div><strong>提示词读取未完成</strong><p className="mt-1 text-xs leading-5">{error}</p></div>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="flex min-h-32 items-center justify-center text-sm text-[var(--muted-foreground)]" role="status">
          <LoaderCircle size={18} className="mr-2 animate-spin" />正在核对漫剧提示词代码基线、已发布配置域与当前实际生效内容…
        </div>
      ) : null}

      {data ? (
        <>
          {data.state === "degraded" ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)]" role="status">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
              有事实源处于回退或不可用状态。下方会逐项标明，不能把当前列表当成完整生产配置。
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700" role="status">
              <CheckCircle2 size={16} />全部提示词事实源均已读取。
            </div>
          )}

          <section className="grid grid-cols-1 gap-3 xl:grid-cols-3" aria-label="漫剧提示词实际生效对照">
            <article className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                <CheckCircle2 size={16} className="text-emerald-500" />漫剧 Agent 当前实际生效提示词
              </div>
              {effectiveMangaPrompt ? (
                <div className="mt-2 space-y-1 text-xs leading-5 text-[var(--secondary-foreground)]">
                  <p><span className="text-[var(--muted-foreground)]">来源：</span>{effectiveMangaPrompt.source}</p>
                  <p><span className="text-[var(--muted-foreground)]">版本：</span>{effectiveMangaPrompt.version}</p>
                  <p><span className="text-[var(--muted-foreground)]">发布 ID：</span>{effectiveMangaPrompt.release_id || "无（代码回退）"}</p>
                  <p><span className="text-[var(--muted-foreground)]">哈希：</span><code>{shortHash(effectiveMangaPrompt.hash)}</code></p>
                  <p>{effectiveMangaPrompt.runtime_effect}</p>
                </div>
              ) : <p className="mt-2 text-xs text-red-600">没有读取到服务端已校验的实际生效提示词。</p>}
            </article>
            <article className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                <FileCode2 size={16} className="text-amber-500" />代码回退基线
              </div>
              {mangaFallbackBase ? (
                <div className="mt-2 space-y-1 text-xs leading-5 text-[var(--secondary-foreground)]">
                  <p><span className="text-[var(--muted-foreground)]">来源：</span>{mangaFallbackBase.source}</p>
                  <p><span className="text-[var(--muted-foreground)]">版本：</span>{mangaFallbackBase.version}</p>
                  <p><span className="text-[var(--muted-foreground)]">哈希：</span><code>{shortHash(mangaFallbackBase.hash)}</code></p>
                  <p>{mangaFallbackBase.runtime_effect}</p>
                </div>
              ) : <p className="mt-2 text-xs text-red-600">没有读取到受审代码回退基线。</p>}
            </article>
            <article className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                <FileCode2 size={16} className="text-blue-500" />当前已发布 Manju prompt 域
              </div>
              {publishedPromptDomain ? (
                <div className="mt-2 space-y-1 text-xs leading-5 text-[var(--secondary-foreground)]">
                  <p><span className="text-[var(--muted-foreground)]">来源：</span>{publishedPromptDomain.source}</p>
                  <p><span className="text-[var(--muted-foreground)]">版本：</span>{publishedPromptDomain.version}</p>
                  <p><span className="text-[var(--muted-foreground)]">实际作用：</span>{publishedPromptDomain.runtime_effect}</p>
                </div>
              ) : <p className="mt-2 text-xs text-amber-700">没有读取到 production/prompt 活动版本。</p>}
            </article>
          </section>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
              <small className="text-[var(--muted-foreground)]">提示词记录</small>
              <strong className="mt-1 block text-lg text-[var(--foreground)]">{prompts.length}</strong>
            </article>
            <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
              <small className="text-[var(--muted-foreground)]">运行权威</small>
              <strong className="mt-1 block text-lg text-[var(--foreground)]">{authoritativeCount}</strong>
            </article>
            <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
              <small className="text-[var(--muted-foreground)]">有后台编辑落点</small>
              <strong className="mt-1 block text-lg text-[var(--foreground)]">{editableCount}</strong>
            </article>
            <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
              <small className="text-[var(--muted-foreground)]">快照时间</small>
              <strong className="mt-1 block text-xs leading-5 text-[var(--foreground)]">{formattedTime(data.generated_at)}</strong>
            </article>
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4" aria-label="提示词事实源状态">
            {(data.sources || []).map((source) => (
              <article key={source.id} className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm text-[var(--foreground)]">{source.name}</strong>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                    source.state === "ready"
                      ? "bg-emerald-500/10 text-emerald-600"
                      : source.state === "fallback"
                        ? "bg-amber-500/10 text-amber-600"
                        : "bg-red-500/10 text-red-600"
                  }`}>
                    {source.state === "ready" ? "已读取" : source.state === "fallback" ? "回退版本" : "不可用"}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">{source.message}</p>
                <small className="mt-2 block text-[var(--muted-foreground)]">{source.count} 条</small>
              </article>
            ))}
          </div>

          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、ID、来源、版本或提示词正文"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-2 pl-10 pr-3 text-sm text-[var(--foreground)]"
            />
          </label>

          <div className="space-y-3">
            {visiblePrompts.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted-foreground)]">
                没有匹配的提示词记录。
              </div>
            ) : null}

            {visiblePrompts.map((prompt) => (
              <details key={prompt.id} className="group rounded-md border border-[var(--border)] bg-[var(--background)]">
                <summary className="flex cursor-pointer list-none items-start gap-3 p-3 marker:content-none">
                  <ChevronRight size={17} className="mt-0.5 shrink-0 text-[var(--muted-foreground)] transition-transform group-open:rotate-90" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-[var(--foreground)]">{prompt.name}</strong>
                      <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] text-[var(--secondary-foreground)]">{KIND_LABELS[prompt.kind]}</span>
                      {prompt.runtime_authoritative ? <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600">运行权威</span> : null}
                      {prompt.enabled === false ? <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-[10px] text-zinc-500">当前停用</span> : null}
                    </div>
                    <p className="mt-1 break-all text-xs text-[var(--muted-foreground)]">{prompt.id} · {prompt.source}</p>
                  </div>
                  <div className="hidden shrink-0 text-right text-[11px] text-[var(--muted-foreground)] sm:block">
                    <div>v{prompt.version}</div>
                    <div title={prompt.hash}>sha256 {shortHash(prompt.hash)}</div>
                  </div>
                </summary>

                <div className="space-y-3 border-t border-[var(--border)] p-3">
                  <dl className="grid grid-cols-1 gap-2 text-xs text-[var(--secondary-foreground)] md:grid-cols-2 xl:grid-cols-4">
                    <div><dt className="text-[var(--muted-foreground)]">版本</dt><dd className="mt-1 break-all">{prompt.version}</dd></div>
                    {prompt.release_id ? <div><dt className="text-[var(--muted-foreground)]">发布 ID</dt><dd className="mt-1 break-all font-mono">{prompt.release_id}</dd></div> : null}
                    <div><dt className="text-[var(--muted-foreground)]">SHA-256</dt><dd className="mt-1 break-all font-mono">{prompt.hash}</dd></div>
                    <div><dt className="text-[var(--muted-foreground)]">编辑属性</dt><dd className="mt-1">{prompt.editable ? "已有明确管理入口" : "源码评审后发布"}</dd></div>
                    <div><dt className="text-[var(--muted-foreground)]">正文长度</dt><dd className="mt-1">{prompt.content.length.toLocaleString("zh-CN")} 字符</dd></div>
                  </dl>

                  <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-2 text-xs leading-5 text-[var(--secondary-foreground)]">
                    <strong className="text-[var(--foreground)]">实际生效说明：</strong>{prompt.runtime_effect}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] p-2 text-xs">
                    <div className="flex min-w-0 items-center gap-2 text-[var(--secondary-foreground)]">
                      {prompt.edit_target.type === "admin_route" ? <ExternalLink size={14} /> : <FileCode2 size={14} />}
                      <span>{prompt.edit_target.label}：</span>
                      {prompt.edit_target.type === "admin_route" ? (
                        <a className="font-medium text-[var(--primary)] hover:underline" href={prompt.edit_target.value}>{prompt.edit_target.value}</a>
                      ) : (
                        <code className="break-all text-[var(--foreground)]">{prompt.edit_target.value}</code>
                      )}
                    </div>
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--foreground)]"
                      onClick={() => void handleCopy(prompt)}
                    >
                      {copiedId === prompt.id ? <ClipboardCheck size={14} className="text-emerald-500" /> : <Copy size={14} />}
                      {copiedId === prompt.id ? "已复制" : "复制全文"}
                    </button>
                  </div>

                  <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--card)] p-3 font-mono text-xs leading-5 text-[var(--secondary-foreground)]">{prompt.content}</pre>
                </div>
              </details>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
