"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  createAgentPresetFieldId,
  normalizeAgentPresetFields,
  toAgentPresetEnvelope,
} from "@/lib/agent-preset-schema";

export interface PresetTemplateField {
  id?: string;
  type: "input" | "select" | "textarea";
  title: string;
  placeholder: string;
  order?: number;
  options?: string[]; // for select type
  // 扩展字段：从完整格式 JSON 粘贴时保留，避免丢失
  required?: boolean;
  contentPrefix?: string;
  sendLabel?: boolean;
  sendText?: string;
  description?: string;
  defaultValue?: string;
}

interface PresetTemplateEditorProps {
  value: PresetTemplateField[];
  onChange: (fields: PresetTemplateField[]) => void;
}

/**
 * Normalizes a raw JSON value into PresetTemplateField[].
 * Accepts AIWeb format ({type:"input"/"select", title, placeholder, options})
 * and our full format ({type:"text"/"select"/"textarea", label, ...}).
 * Extra fields are silently ignored.
 */
function normalizeJsonToFields(parsed: unknown): PresetTemplateField[] {
  return normalizeAgentPresetFields(parsed).map((field) => ({
    id: field.id,
    type: field.type === "text" ? "input" : field.type,
    title: field.label,
    placeholder: field.placeholder,
    order: field.order,
    options: field.options,
    required: field.required,
    contentPrefix: field.contentPrefix,
    sendLabel: field.sendLabel,
    sendText: field.sendText,
    description: field.description,
    defaultValue: field.defaultValue,
  }));
}

export function PresetTemplateEditor({ value, onChange }: PresetTemplateEditorProps) {
  const [mode, setMode] = useState<"template" | "json">("template");

  const addField = useCallback((type: "input" | "select" | "textarea") => {
    const newField: PresetTemplateField = {
      id: createAgentPresetFieldId(),
      type,
      title: "",
      placeholder: "",
      ...(type === "select" ? { options: [""] } : {}),
    };
    onChange([...value, newField]);
  }, [value, onChange]);

  const removeField = useCallback((index: number) => {
    onChange(value.filter((_, i) => i !== index));
  }, [value, onChange]);

  const updateField = useCallback((index: number, updates: Partial<PresetTemplateField>) => {
    const next = [...value];
    next[index] = { ...next[index], ...updates };
    onChange(next);
  }, [value, onChange]);

  const addOption = useCallback((fieldIndex: number) => {
    const next = [...value];
    const field = next[fieldIndex];
    if (field.type === "select") {
      field.options = [...(field.options || []), ""];
    }
    onChange(next);
  }, [value, onChange]);

  const removeOption = useCallback((fieldIndex: number, optionIndex: number) => {
    const next = [...value];
    const field = next[fieldIndex];
    if (field.type === "select") {
      field.options = (field.options || []).filter((_, i) => i !== optionIndex);
    }
    onChange(next);
  }, [value, onChange]);

  const updateOption = useCallback((fieldIndex: number, optionIndex: number, text: string) => {
    const next = [...value];
    const field = next[fieldIndex];
    if (field.type === "select" && field.options) {
      field.options[optionIndex] = text;
    }
    onChange(next);
  }, [value, onChange]);

  // Move field up/down
  const moveField = useCallback((index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= value.length) return;
    const next = [...value];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onChange(next);
  }, [value, onChange]);

  // JSON mode
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  // 用于标记是否是内部切换导致的 jsonText 变化，避免循环
  const isInternalUpdateRef = useRef(false);

  // JSON 模式下自动同步到父组件：当 jsonText 变化且当前处于 JSON 模式时，尝试解析并同步
  useEffect(() => {
    if (mode !== "json" || isInternalUpdateRef.current) {
      isInternalUpdateRef.current = false;
      return;
    }
    if (!jsonText.trim()) {
      // 空内容：清空父组件字段
      onChange([]);
      return;
    }
    try {
      const parsed = JSON.parse(jsonText);
      const fields = normalizeJsonToFields(parsed);
      // 只有解析成功且字段非空才同步（空数组也可能是用户正在输入中）
      if (fields.length > 0) {
        onChange(fields);
        setJsonError("");
      }
    } catch {
      // JSON 格式暂时不完整，不报错，等用户输完再校验
    }
  }, [jsonText, mode, onChange]);

  const switchToJson = useCallback(() => {
    isInternalUpdateRef.current = true;
    setJsonText(JSON.stringify(toAgentPresetEnvelope(value.map((field, index) => ({
      ...field,
      label: field.title,
      type: field.type === "input" ? "text" : field.type,
      order: field.order ?? index,
    }))), null, 2));
    setJsonError("");
    setMode("json");
  }, [value]);

  const switchToTemplate = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      // Normalize — supports legacy arrays, AIWeb format and versioned envelopes
      const fields = normalizeJsonToFields(parsed);
      const hasInputFields = Array.isArray(parsed)
        ? parsed.length > 0
        : !!parsed && typeof parsed === "object" && Array.isArray((parsed as { fields?: unknown[] }).fields);
      if (fields.length === 0 && hasInputFields) {
        setJsonError("未找到有效字段，请确保每个字段包含 title（或 label）");
        return;
      }
      onChange(fields);
      setMode("template");
      setJsonError("");
    } catch {
      setJsonError("JSON 格式错误，请检查语法");
    }
  }, [jsonText, onChange]);

  const inputCls =
    "w-full text-sm px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/30 outline-none transition-colors";

  return (
    <div>
      {/* Mode toggle */}
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => {
            if (mode === "json") switchToTemplate();
            else setMode("template");
          }}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
            mode === "template"
              ? "bg-[var(--primary)] text-white"
              : "bg-[var(--background)] text-[var(--muted-foreground)] border border-[var(--border)] hover:border-[var(--primary)]"
          }`}
        >
          可视化编辑
        </button>
        <button
          type="button"
          onClick={() => {
            if (mode === "template") switchToJson();
            else setMode("json");
          }}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
            mode === "json"
              ? "bg-[var(--primary)] text-white"
              : "bg-[var(--background)] text-[var(--muted-foreground)] border border-[var(--border)] hover:border-[var(--primary)]"
          }`}
        >
          JSON 模式
        </button>
        <span className="text-[10px] text-[var(--muted-foreground)] ml-1">
          支持直接粘贴 AIWeb / 其他平台 JSON
        </span>
      </div>

      {mode === "template" ? (
        /* ========= Visual Template Editor ========= */
        <div className="space-y-3">
          {value.length === 0 && (
            <div className="text-center py-6 text-xs text-[var(--muted-foreground)] border-2 border-dashed border-[var(--border)] rounded-lg">
              暂无字段，点击下方按钮添加，或切换到「JSON 模式」粘贴代码
            </div>
          )}
          {value.map((field, index) => (
            <div
              key={index}
              className="relative p-3 rounded-lg border border-[var(--border)] bg-[var(--background)] space-y-2"
            >
              {/* Header: type tabs + actions */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <span className="text-xs font-mono text-[var(--muted-foreground)] mr-2">
                    {index + 1}.
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      updateField(index, {
                        type: "input",
                        options: undefined,
                      })
                    }
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      field.type === "input"
                        ? "bg-blue-500 text-white"
                        : "bg-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--border)]/80"
                    }`}
                  >
                    输入框
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateField(index, {
                        type: "textarea",
                        options: undefined,
                      })
                    }
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      field.type === "textarea"
                        ? "bg-purple-500 text-white"
                        : "bg-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--border)]/80"
                    }`}
                  >
                    长文本
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateField(index, {
                        type: "select",
                        options: field.options || [""],
                      })
                    }
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      field.type === "select"
                        ? "bg-green-500 text-white"
                        : "bg-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--border)]/80"
                    }`}
                  >
                    下拉框
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveField(index, -1)}
                    disabled={index === 0}
                    className="p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-30 transition-colors"
                    title="上移"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveField(index, 1)}
                    disabled={index === value.length - 1}
                    className="p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-30 transition-colors"
                    title="下移"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeField(index)}
                    className="p-1 text-red-400 hover:text-red-600 transition-colors"
                    title="删除字段"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Field config */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-[var(--muted-foreground)] mb-0.5 block">
                    字段名称 <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={field.title}
                    onChange={(e) => updateField(index, { title: e.target.value })}
                    className={inputCls}
                    placeholder="例如: 您的姓名"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-[var(--muted-foreground)] mb-0.5 block">
                    提示文字
                  </label>
                  <input
                    value={field.placeholder}
                    onChange={(e) => updateField(index, { placeholder: e.target.value })}
                    className={inputCls}
                    placeholder="例如: 请输入您的姓名"
                  />
                </div>
              </div>

              {/* Dropdown options (select type only) */}
              {field.type === "select" && (
                <div>
                  <label className="text-[10px] text-[var(--muted-foreground)] mb-1 block">
                    下拉选项
                  </label>
                  <div className="space-y-1.5">
                    {(field.options || []).map((opt, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <input
                          value={opt}
                          onChange={(e) => updateOption(index, oi, e.target.value)}
                          className={inputCls}
                          placeholder="选项内容"
                        />
                        <button
                          type="button"
                          onClick={() => removeOption(index, oi)}
                          className="p-1.5 text-red-400 hover:text-red-600 flex-shrink-0 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addOption(index)}
                      className="text-xs text-green-600 hover:text-green-700 flex items-center gap-1 transition-colors"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      添加选项
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Add buttons */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => addField("input")}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-600 hover:bg-blue-500/20 transition-colors"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加输入框
            </button>
            <button
              type="button"
              onClick={() => addField("textarea")}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-600 hover:bg-purple-500/20 transition-colors"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加长文本
            </button>
            <button
              type="button"
              onClick={() => addField("select")}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/30 text-green-600 hover:bg-green-500/20 transition-colors"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加下拉框
            </button>
          </div>
        </div>
      ) : (
        /* ========= JSON Mode ========= */
        <div className="space-y-2">
          <div className="p-2.5 rounded-lg bg-blue-500/5 border border-blue-500/20">
            <p className="text-[10px] text-blue-600 leading-relaxed">
              <strong>兼容格式说明：</strong>支持直接粘贴 AIWeb 或其他平台的 JSON 代码。
              识别 <code className="px-1 py-0.5 bg-blue-500/10 rounded text-[9px]">type: input / select / text / textarea</code>，
              <code className="px-1 py-0.5 bg-blue-500/10 rounded text-[9px]">title</code> 或 <code className="px-1 py-0.5 bg-blue-500/10 rounded text-[9px]">label</code> 均可作为字段名称，
              其余字段自动忽略。粘贴后点击「可视化编辑」即可预览效果。
            </p>
          </div>
          <textarea
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value);
              setJsonError("");
            }}
            className="w-full min-h-[200px] p-3 rounded-lg border border-[var(--border)] bg-[var(--background)] font-mono text-xs leading-relaxed resize-y focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/30 outline-none"
            placeholder={`AIWeb 格式示例：\n[\n  {\n    "type": "input",\n    "title": "课程主题",\n    "placeholder": "请输入课程主题"\n  },\n  {\n    "type": "select",\n    "title": "课程形式",\n    "placeholder": "请选择",\n    "options": ["线上课程", "线下课程"]\n  }\n]\n\n也支持我们的完整格式：\n[\n  {\n    "type": "text",\n    "label": "课程主题",\n    "placeholder": "请输入课程主题",\n    "sendLabel": true\n  }\n]`}
          />
          {jsonError && (
            <p className="text-xs text-red-500">{jsonError}</p>
          )}
          <p className="text-[10px] text-[var(--muted-foreground)]">
            点击「可视化编辑」按钮解析 JSON 并预览，点击「JSON 模式」按钮切换回当前视图
          </p>
        </div>
      )}
    </div>
  );
}
