"use client";

import { useMemo, useState } from "react";
import { copyToClipboard } from "@/lib/utils";

export function SyncAdminTab({ token }: { token: string | null }) {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<Record<string, unknown> | null>(null);
  const [exportData, setExportData] = useState<string>("");
  const [showImportJson, setShowImportJson] = useState(false);
  const [importJson, setImportJson] = useState("");

  const authHeaders = useMemo(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }), [token]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/admin/sync/export", {
        method: "POST",
        headers: authHeaders,
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`导出失败: ${err.error}`);
        return;
      }
      const data = await res.json();
      const jsonStr = JSON.stringify(data, null, 2);
      setExportData(jsonStr);

      // 自动下载
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agent-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`导出异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    if (!importJson.trim()) {
      alert("请先粘贴导入数据");
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(importJson);
    } catch {
      alert("JSON 格式无效，请检查");
      return;
    }

    if (!confirm("安全合并将以时间戳为准更新管理配置，并保留本机服务端密钥。确定继续吗？")) return;

    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/admin/sync/import", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ data: parsed.data, mode: "merge" }),
      });
      const result = await res.json();
      setImportResult(result);
      if (!res.ok) {
        alert(`导入失败: ${result.error}`);
      }
    } catch (err) {
      alert(`导入异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setImportJson(text);
      setShowImportJson(true);
    };
    reader.readAsText(file);
  };

  const btnPrimary = "px-4 py-2 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 transition font-medium text-sm";
  const btnGhost = "px-4 py-2 rounded-lg border border-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--border)] transition font-medium text-sm";
  const cardCls = "rounded-xl border border-[var(--border)] bg-[var(--card)] p-5";

  return (
    <div className="space-y-5">
      {/* 说明区 */}
      <div className={cardCls}>
        <h3 className="text-base font-semibold text-[var(--card-foreground)] mb-3">数据同步说明</h3>
        <div className="text-sm text-[var(--muted-foreground)] space-y-2">
          <p>• <strong>本地预览</strong>和<strong>线上网站</strong>的数据是否独立，取决于各自的数据库连接配置；连接同一数据库时，后台修改会同时生效，导入前请确认目标。</p>
          <p>• <strong>导出</strong>：将本端的管理数据导出为 JSON 文件（智能体、分类、设置、模型、公告）</p>
          <p>• <strong>导入</strong>：将另一端的 JSON 数据导入到本端</p>
          <p>• <strong>合并模式</strong>：以 <code className="px-1 py-0.5 rounded bg-[var(--border)] text-xs">updated_at</code> 时间戳为准，较新的覆盖较旧的，两端独有的数据都会保留</p>
          <p>• 密钥和令牌不会导出；导入只允许安全合并，已有服务端密钥绑定会保留</p>
          <p>• 用户、积分、对话等业务数据不同步，只同步管理配置</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* 导出区 */}
        <div className={cardCls}>
          <h3 className="text-base font-semibold text-[var(--card-foreground)] mb-3 flex items-center gap-2">
            <svg className="w-5 h-5 text-[var(--primary)]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
            导出数据
          </h3>
          <p className="text-sm text-[var(--muted-foreground)] mb-4">导出本端所有管理配置数据，自动下载 JSON 文件</p>
          <button onClick={handleExport} disabled={exporting} className={btnPrimary}>
            {exporting ? "导出中..." : "导出并下载"}
          </button>
          {exportData && (
            <div className="mt-3">
              <button onClick={() => { copyToClipboard(exportData); }} className="text-xs text-[var(--primary)] hover:underline">
                复制 JSON 到剪贴板
              </button>
            </div>
          )}
        </div>

        {/* 导入区 */}
        <div className={cardCls}>
          <h3 className="text-base font-semibold text-[var(--card-foreground)] mb-3 flex items-center gap-2">
            <svg className="w-5 h-5 text-[var(--primary)]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
            导入数据
          </h3>
          <p className="text-sm text-[var(--muted-foreground)] mb-3">从另一端导出的 JSON 文件导入数据</p>

          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <label className={`cursor-pointer ${btnGhost}`}>
                选择文件
                <input type="file" accept=".json" onChange={handleFileUpload} className="hidden" />
              </label>
              <button onClick={() => setShowImportJson(!showImportJson)} className="text-sm text-[var(--primary)] hover:underline">
                {showImportJson ? "隐藏" : "粘贴 JSON"}
              </button>
            </div>

            {showImportJson && (
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder="粘贴另一端导出的 JSON 数据..."
                className="w-full h-40 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--card-foreground)] p-3 text-xs font-mono resize-y"
              />
            )}

            <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
              安全合并：保留本机服务端密钥，按更新时间导入管理配置。
            </div>

            <button onClick={handleImport} disabled={importing || !importJson.trim()} className={btnPrimary}>
              {importing ? "导入中..." : "开始导入"}
            </button>
          </div>
        </div>
      </div>

      {/* 导入结果 */}
      {importResult && (
        <div className={cardCls}>
          <h3 className="text-base font-semibold text-[var(--card-foreground)] mb-3">导入结果</h3>
          <div className="text-sm space-y-1">
            <p className="text-[var(--muted-foreground)]">
              模式：{importResult.mode === "merge" ? "合并" : "全量覆盖"} | 时间：{String(importResult.imported_at)}
            </p>
            <table className="w-full text-sm mt-2">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left py-2 px-2 text-[var(--muted-foreground)]">表名</th>
                  <th className="text-center py-2 px-2 text-green-500">新增</th>
                  <th className="text-center py-2 px-2 text-blue-500">更新</th>
                  <th className="text-center py-2 px-2 text-[var(--muted-foreground)]">跳过</th>
                  <th className="text-left py-2 px-2 text-red-500">错误</th>
                </tr>
              </thead>
              <tbody>
                {(importResult.results as Array<{ table: string; added: number; updated: number; skipped: number; errors: string[] }>).map((r) => (
                  <tr key={r.table} className="border-b border-[var(--border)]">
                    <td className="py-2 px-2 font-mono text-xs">{r.table}</td>
                    <td className="py-2 px-2 text-center text-green-500">{r.added || 0}</td>
                    <td className="py-2 px-2 text-center text-blue-500">{r.updated || 0}</td>
                    <td className="py-2 px-2 text-center text-[var(--muted-foreground)]">{r.skipped || 0}</td>
                    <td className="py-2 px-2 text-xs text-red-500">{r.errors?.join("; ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
