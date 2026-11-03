"use client";

import { useEffect, useRef, useState } from "react";
import type { FormalCatalogPreview } from "@/lib/server/formal-catalog-preview";

type Section = { status: string; sha256?: string | null; identity?: { releaseVersion: number } | null };
type Identity = {
  observedAt: string;
  configurationSource: Section;
  agents: Section;
  categories: Section;
  membershipPackages: Section & { items?: { key: string; name: string; version: number; agentNavigationKeys: string[] }[] };
  modelPoolRelease: Section;
  workspaceModelRelease: Section;
};

type Result = { mode: "public"; data: FormalCatalogPreview } | { mode: "private"; data: Identity };

const sectionNames = {
  configurationSource: "读取来源", agents: "智能体配置", categories: "分类", membershipPackages: "会员套餐模板",
  modelPoolRelease: "模型池发布", workspaceModelRelease: "工作台模型发布",
} as const;

function publicGroupName(key: string) {
  if (key === "bip:loop") return "商业 IP";
  if (key === "task:获客转化") return "运营增长";
  return key.replace(/^task:/, "");
}

function PublicDifferences({ data }: { data: FormalCatalogPreview }) {
  const { local, official, diff } = data;
  const groups = [...new Set([...Object.keys(local.groupCounts), ...Object.keys(official.groupCounts)])].sort();
  const names = new Map([...local.agents, ...official.agents].map(agent => [agent.id, agent.name]));
  const entries = [
    ...diff.onlyLocal.map(id => ({ id, reason: "仅本地" })),
    ...diff.onlyOfficial.map(id => ({ id, reason: "仅正式" })),
    ...diff.changed.map(({ id, fields }) => ({ id, reason: fields.join("、") })),
  ];
  return <div className="mt-3 space-y-2" data-testid="public-catalog-comparison">
    <p className="font-medium text-[var(--foreground)]">本地 {local.count} 个 · 正式 {official.count} 个</p>
    <p>{groups.map(key => `${publicGroupName(key)} ${local.groupCounts[key] || 0} / ${official.groupCounts[key] || 0}`).join("　")}</p>
    <p>公开目录采集于 {new Date(data.capturedAt).toLocaleString("zh-CN")}。分类数量按本地 / 正式排列。</p>
    <p>{diff.same ? "已核公开字段一致。" : `仅本地 ${diff.onlyLocal.length} 个， 仅正式 ${diff.onlyOfficial.length} 个，共有但字段不同 ${diff.changed.length} 个。`}</p>
    {!diff.same && (diff.categories.onlyLocal.length + diff.categories.onlyOfficial.length + diff.categories.changed.length) > 0 &&
      <p>分类定义差异 · 仅本地 {diff.categories.onlyLocal.join("、") || "无"}，仅正式 {diff.categories.onlyOfficial.join("、") || "无"}，字段不同 {diff.categories.changed.map(row => row.id).join("、") || "无"}</p>}
    <details>
      <summary className="cursor-pointer font-medium text-[var(--foreground)]">浏览正式公开目录（{official.count}）</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        {groups.filter(key => official.groupCounts[key]).map(key => <div key={key} className="mb-2">
          <h4 className="font-medium">{publicGroupName(key)}</h4>
          <p>{official.agents.filter(agent => agent.displayCategory === key).map(agent => agent.name + (agent.isActive ? "" : "（停用）")).join("、")}</p>
        </div>)}
      </div>
    </details>
    {entries.length > 0 && <details>
      <summary className="cursor-pointer font-medium text-[var(--foreground)]">按智能体查看差异</summary>
      <ul className="mt-2 max-h-64 space-y-1 overflow-auto">
        {entries.map(({ id, reason }) => <li key={id}>{names.get(id) || id} · {reason} <code className="text-xs">{id}</code></li>)}
      </ul>
    </details>}
  </div>;
}

export function ConfigurationReadbackPanel({ localPreview, token, sensitiveUnlocked }: { localPreview: boolean; token?: string | null; sensitiveUnlocked: boolean }) {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setResult(null);
    setError("");
    setLoading(false);
    return () => active.current?.abort();
  }, [token, sensitiveUnlocked, localPreview]);

  async function read(mode: Result["mode"]) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      const endpoint = mode === "public" ? "formal-catalog-preview" : "configuration-identity";
      const response = await fetch(`/api/admin/${endpoint}`, {
        cache: "no-store", credentials: "same-origin", signal: controller.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok || data.ok === false) {
        throw new Error(response.status === 403 || response.status === 401
          ? "请确认当前所有者会话及安全验证状态后重试。"
          : "本次配置读取失败，请稍后重新核对。");
      }
      if (mode === "public" && data.local && data.official && data.diff) {
        setResult({ mode, data });
      } else if (mode === "private" && data.schemaVersion === "configuration-identity.v1" && Object.keys(sectionNames).every(key => data[key]?.status)) {
        setResult({ mode, data });
      } else {
        throw new Error("当前服务返回的配置格式与预览不匹配。");
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const buttonStyle = "rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--foreground)] hover:bg-[var(--accent)] disabled:opacity-50";
  return <section aria-label="配置核对" className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-sm text-[var(--muted-foreground)]">
    <h3 className="font-semibold text-[var(--foreground)]">配置核对</h3>
    <div className="mt-2 flex flex-wrap gap-2">
      {localPreview && <button type="button" className={buttonStyle} disabled={loading} onClick={() => read("public")}>核对本地与正式公开目录</button>}
      <button type="button" className={buttonStyle} disabled={loading || !sensitiveUnlocked} onClick={() => read("private")}>读取本端配置摘要</button>
    </div>
    {!sensitiveUnlocked && <p className="mt-2">完成后台安全验证后可查看本端私有配置摘要。</p>}
    {loading && <p role="status" className="mt-2">正在读取当前配置…</p>}
    {error && <p role="alert" className="mt-2">{error}</p>}
    {result?.mode === "public" && <PublicDifferences data={result.data}/>}
    {sensitiveUnlocked && result?.mode === "private" && <div className="mt-3 space-y-1">
      <p>本端读取时间 {new Date(result.data.observedAt).toLocaleString("zh-CN")}</p>
      {(Object.keys(sectionNames) as (keyof typeof sectionNames)[]).map(key => {
        const section = result.data[key];
        return <p key={key}>{sectionNames[key]} · {section.status === "verified" ? "已读取" : section.status === "missing" ? "未发布或缺失" : "不可读取"}
          {section.identity && ` · v${section.identity.releaseVersion}`}
          {section.sha256 && <code className="ml-2 break-all text-xs" title={section.sha256}>{section.sha256.slice(0, 16)}</code>}
        </p>;
      })}
      {result.data.membershipPackages.items && <details><summary className="cursor-pointer">生效套餐及智能体权益</summary>
        <ul className="mt-1 space-y-1">{result.data.membershipPackages.items.map(plan =>
          <li key={`${plan.key}-${plan.version}`}>{plan.name} v{plan.version} · {plan.agentNavigationKeys.map(publicGroupName).join("、") || "无智能体分类授权"}</li>)}</ul>
      </details>}
    </div>}
  </section>;
}
