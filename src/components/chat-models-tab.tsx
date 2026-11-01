"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { modelMutationAttempt, type ModelMutationAttempt } from "./admin/model-mutation-request";
import { readModelCandidateReceipt } from "./admin/model-candidate-receipt";

interface ChatModel {
  id: string;
  model_name: string;
  display_name: string;
  icon_url: string;
  description: string;
  proxy_url: string;
  api_key?: string;
  api_key_configured?: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface Props {
  token: string | null;
}

export default function ChatModelsTab({ token }: Props) {
  const saveAttempt = useRef<ModelMutationAttempt | null>(null);
  const saveLock = useRef(false);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingModel, setEditingModel] = useState<ChatModel | null>(null);
  const [formData, setFormData] = useState({
    model_name: "",
    display_name: "",
    icon_url: "",
    description: "",
    proxy_url: "",
    api_key: "",
    sort_order: 0,
  });

  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const loadModels = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/chat-models", { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setModels(data.models || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { loadModels(); }, [loadModels]);

  const resetForm = () => {
    setFormData({
      model_name: "",
      display_name: "",
      icon_url: "",
      description: "",
      proxy_url: "",
      api_key: "",
      sort_order: 0,
    });
    setEditingModel(null);
    setShowForm(false);
  };

  const openAdd = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (model: ChatModel) => {
    setFormData({
      model_name: model.model_name,
      display_name: model.display_name,
      icon_url: model.icon_url || "",
      description: model.description || "",
      proxy_url: model.proxy_url || "",
      api_key: "",
      sort_order: model.sort_order,
    });
    setEditingModel(model);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (saveLock.current) return;
    if (!formData.model_name.trim() || !formData.display_name.trim()) {
      alert("模型名称和显示名称不能为空");
      return;
    }

    saveLock.current = true;
    try {
      const isEdit = !!editingModel;
      const url = "/api/admin/chat-models";
      const body = isEdit
        ? { id: editingModel!.id, ...formData }
        : formData;

      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", ...authHeaders,
          "Idempotency-Key": (saveAttempt.current = modelMutationAttempt(saveAttempt.current, isEdit ? "PUT" : "POST", body)).id },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const receipt = readModelCandidateReceipt(await res.json());
        saveAttempt.current = null;
        alert(`已保存为候选 ${receipt.id}，请在模型资源池管理版本中校验、预览并发布。`);
        resetForm();
        loadModels();
      } else {
        const data = await res.json();
        alert(data.error || "保存失败");
      }
    } catch {
      alert("保存结果待确认，请保留编辑内容并核对候选列表。再次提交相同内容将查询同一操作。");
    } finally {
      saveLock.current = false;
    }
  };

  const handleDelete = async (model: ChatModel) => {
    if (!confirm(`确认删除对话模型「${model.display_name}」？`)) return;
    try {
      const res = await fetch(`/api/admin/chat-models?id=${model.id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (res.ok) {
        loadModels();
      } else {
        const data = await res.json();
        alert(data.error || "删除失败");
      }
    } catch {
      alert("网络错误");
    }
  };

  return (
    <div className="space-y-4">
      {/* 标题区 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <span>💬</span> 对话模型管理
          </h3>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            管理对话界面可选的模型列表。管理员在对话时可通过模型切换器选择不同模型。模型不会显示在应用广场。
          </p>
        </div>
        <button
          onClick={openAdd}
          className="px-4 py-2 rounded-lg bg-[var(--primary)] text-white font-medium hover:opacity-90 transition flex items-center gap-1.5"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 4v16m8-8H4" />
          </svg>
          添加对话模型
        </button>
      </div>

      {/* 统计 */}
      <div className="flex items-center gap-4">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-center">
          <div className="text-lg font-bold text-[var(--foreground)]">{models.length}</div>
          <div className="text-xs text-[var(--muted-foreground)]">可用模型</div>
        </div>
        <p className="text-sm text-[var(--muted-foreground)]">保存后的模型会直接进入对话模型目录。</p>
      </div>

      {/* 说明 */}
      <div className="rounded-xl p-4 border border-blue-200 bg-blue-50/30">
        <p className="text-xs font-bold text-blue-600 mb-2">💡 对话模型说明</p>
        <div className="text-xs text-[var(--muted-foreground)] space-y-1">
          <p>• 对话模型供管理员在对话界面切换使用，不影响普通用户的体验</p>
          <p>• 模型名称(model_name)是发送给API的实际标识符，如 glm-5.2、claude-sonnet-4-6</p>
          <p>• 显示名称(display_name)是用户看到的友好名称，如 GLM-5.1、Claude Sonnet 4.6</p>
          <p>• 代理地址(proxy_url)和API密钥(api_key)可选，留空则使用全局配置</p>
          <p>• 对话模型不会出现在应用广场，仅作为对话时的模型选项</p>
        </div>
      </div>

      {/* 模型列表 */}
      {loading ? (
        <div className="text-center py-12 text-[var(--muted-foreground)]">
          <svg className="animate-spin w-6 h-6 mx-auto mb-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          加载中...
        </div>
      ) : models.length === 0 ? (
        <div className="text-center py-12 text-[var(--muted-foreground)]">
          <span className="text-4xl block mb-3">💬</span>
          <p className="text-lg font-medium">暂无对话模型</p>
          <p className="text-sm mt-1">点击「添加对话模型」添加你的第一个模型</p>
        </div>
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <div
              key={m.id}
              className="rounded-xl border border-[var(--border)] p-4 flex items-center gap-4 transition-all hover:border-[var(--primary)]/30"
            >
              {/* 状态灯 */}
              <div className="w-2.5 h-2.5 rounded-full shrink-0 bg-green-500" />

              {/* 模型信息 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-[var(--foreground)]">{m.display_name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 font-medium">
                    💬 对话
                  </span>
                  {m.proxy_url && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 font-medium">
                      自定义代理
                    </span>
                  )}
                </div>
                <div className="text-xs text-[var(--muted-foreground)] mt-1">
                  <span className="font-mono">{m.model_name}</span>
                  {m.description && <span className="ml-2">· {m.description}</span>}
                </div>
                {m.proxy_url && (
                  <div className="text-xs text-[var(--muted-foreground)] mt-0.5">
                    代理: {m.proxy_url}
                  </div>
                )}
              </div>

              {/* 排序 */}
              <div className="text-xs text-[var(--muted-foreground)] w-8 text-center shrink-0">
                #{m.sort_order}
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => openEdit(m)}
                  className="px-3 py-1.5 text-xs rounded-lg border hover:bg-[var(--muted)]/50 transition"
                >
                  编辑
                </button>
                <button
                  onClick={() => handleDelete(m)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-red-300 text-red-500 hover:bg-red-50 transition"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 添加/编辑表单 */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={resetForm}>
          <div
            className="bg-[var(--card)] rounded-2xl shadow-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold mb-4">
              {editingModel ? "编辑对话模型" : "添加对话模型"}
            </h3>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">
                    模型名称 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={formData.model_name}
                    onChange={(e) => setFormData({ ...formData, model_name: e.target.value })}
                    placeholder="如: glm-5.2"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--primary)] transition font-mono"
                  />
                  <p className="text-[10px] text-[var(--muted-foreground)] mt-1">发送给API的实际标识符</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">
                    显示名称 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={formData.display_name}
                    onChange={(e) => setFormData({ ...formData, display_name: e.target.value })}
                    placeholder="如: GLM-5.1"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--primary)] transition"
                  />
                  <p className="text-[10px] text-[var(--muted-foreground)] mt-1">用户看到的友好名称</p>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">描述</label>
                <input
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="模型简要描述"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--primary)] transition"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">图标URL</label>
                <input
                  value={formData.icon_url}
                  onChange={(e) => setFormData({ ...formData, icon_url: e.target.value })}
                  placeholder="可选，模型图标地址"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--primary)] transition"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">代理地址</label>
                <input
                  value={formData.proxy_url}
                  onChange={(e) => setFormData({ ...formData, proxy_url: e.target.value })}
                  placeholder="可选，覆盖全局API地址"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--primary)] transition"
                />
                <p className="text-[10px] text-[var(--muted-foreground)] mt-1">留空则使用全局LLM_API_BASE_URL配置</p>
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">API密钥</label>
                <input
                  value={formData.api_key}
                  onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                  placeholder={editingModel?.api_key_configured ? "已配置；留空保留原密钥" : "可选，覆盖全局API密钥"}
                  type="password"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--primary)] transition"
                />
                <p className="text-[10px] text-[var(--muted-foreground)] mt-1">{editingModel?.api_key_configured ? "原密钥不会返回浏览器；输入新值才会替换" : "留空则使用全局LLM_API_KEY配置"}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">排序</label>
                  <input
                    value={formData.sort_order}
                    onChange={(e) => setFormData({ ...formData, sort_order: parseInt(e.target.value) || 0 })}
                    type="number"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--primary)] transition"
                  />
                </div>
                <div className="flex items-end pb-2 text-sm text-[var(--muted-foreground)]">保存后自动启用</div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                onClick={resetForm}
                className="px-4 py-2 rounded-lg border border-[var(--border)] text-sm hover:bg-[var(--muted)]/50 transition"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                className="px-4 py-2 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 transition"
              >
                {editingModel ? "保存" : "添加"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
