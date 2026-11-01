"use client";

import { useState } from "react";
import type { PresetField } from "@/types/coze";
import { ChevronDown, X, Send } from "lucide-react";
import { resolveAgentAvatarUrl } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import styles from "./agent-intake.module.css";

interface PresetDialogProps {
  agentId?: string;
  agentName: string;
  agentIconUrl: string;
  fields: PresetField[];
  onStart: (values: Record<string, string>) => void;
  onSkip: () => void;
  onClose: () => void;
}

/** 高能版时长只显示秒数；选项 value 与发送内容仍保留接收卡原值。 */
function getDisplayText(opt: string, fieldId: string, agentId?: string): string {
  if (agentId === "agent-1786843330392-emdjv2" && (fieldId === "segment_duration" || fieldId === "target_duration_seconds")) {
    return opt.match(/^\s*(\d+)\s*秒(?:版)?(?:\s*[：:].*)?\s*$/u)?.[1]?.concat("秒") ?? opt;
  }
  return opt;
}

/** 多行内容与字段标题分行，避免第 1 段挤在标题后、后续段落另起一行。 */
export function formatPresetFieldValue(field: PresetField, rawValue: string, includeLabel: boolean): string {
  let userValue = rawValue.trim();
  if (!userValue) return "";

  // 转义行首的编号，保留逐行纯文本排版，避免 Markdown 自动转换为有序列表。
  if (field.type === "textarea") {
    userValue = userValue.replace(/^(\d+)\. /gm, "$1\\. ");
  }

  if (field.contentPrefix) {
    const separator = field.type === "textarea" && !field.contentPrefix.endsWith("\n") ? "\n" : "";
    return `${field.contentPrefix}${separator}${userValue}`;
  }

  if (!includeLabel) return userValue;

  const label = field.sendText || field.label;
  const separator = field.type === "textarea" ? "\n" : "";
  return `${label}：${separator}${userValue}`;
}

/** 让“例如：”独占一行，使第 1、2 段从同一列开始。 */
export function formatTextareaPlaceholder(placeholder: string): string {
  return placeholder.replace(/(例如[：:])\s*(?=\d+\.)/, "$1\n");
}

/**
 * 两列接收卡中，textarea 始终占满一行。电影叙事卡的三个普通字段
 * 需要两项并排、末项满行；限定到该卡，避免改变其他智能体的既有布局。
 */
const CINEMATIC_STORY_DIRECTOR_AGENT_ID = "agent-1786633444187-594spj";
const BALANCED_ODD_FIELD_AGENT_IDS = new Set([CINEMATIC_STORY_DIRECTOR_AGENT_ID]);

export function getPresetFieldGridClass(fields: PresetField[], index: number, agentId?: string): string {
  const field = fields[index];
  if (!field) return "";
  if (field.type === "textarea") return "col-span-2";
  if (!agentId || !BALANCED_ODD_FIELD_AGENT_IDS.has(agentId)) return "";

  let groupStart = index;
  while (groupStart > 0 && fields[groupStart - 1]?.type !== "textarea") groupStart -= 1;

  let groupEnd = index;
  while (groupEnd < fields.length - 1 && fields[groupEnd + 1]?.type !== "textarea") groupEnd += 1;

  const groupLength = groupEnd - groupStart + 1;
  return groupLength % 2 === 1 && index === groupEnd ? "col-span-2" : "";
}

export function PresetDialog({ agentId, agentName, agentIconUrl, fields, onStart, onSkip, onClose }: PresetDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    fields
      .filter((field) => typeof field.defaultValue === "string" && field.defaultValue.trim())
      .map((field) => [field.id, field.defaultValue!.trim()]),
  ));
  const [sendLabel, setSendLabel] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    fields.forEach(f => {
      init[f.id] = f.sendLabel ?? !f.contentPrefix;
    });
    return init;
  });

  // 按 order 排序字段
  const sortedFields = [...fields].sort((a, b) => a.order - b.order);

  const handleChange = (fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleStart = () => {
    // 检查必填字段
    const missing = sortedFields.filter(
      (f) => f.required && !values[f.id]?.trim()
    );
    if (missing.length > 0) {
      const firstMissing = missing[0];
      const el = document.getElementById(`preset-${firstMissing.id}`);
      el?.focus();
      el?.classList.add("ring-2", "ring-[var(--destructive)]");
      setTimeout(() => el?.classList.remove("ring-2", "ring-[var(--destructive)]"), 2000);
      return;
    }

    // 构建发送值：根据sendLabel开关决定是否带上标签
    const sendValues: Record<string, string> = {};
    sortedFields.forEach(f => {
      const formattedValue = formatPresetFieldValue(f, values[f.id] || "", sendLabel[f.id]);
      if (formattedValue) sendValues[f.id] = formattedValue;
    });

    onStart(sendValues);
  };

  // 渲染单个字段
  const renderField = (field: PresetField) => {
    const isSelect = field.type === "select" || (field.type === "text" && field.options && field.options.length > 0);
    const isTextarea = field.type === "textarea";
    const isClearableMovieBreed = agentId === CINEMATIC_STORY_DIRECTOR_AGENT_ID
      && field.id === "dog_breed"
      && !field.required;
    // 动画风格的选择器只保留清晰的操作提示；长说明放进 title，避免把两列弹窗标签挤变形。
    const displayLabel = field.id === "animation_style" ? "选择动画风格" : field.label;

    return (
      <div key={field.id} className="w-full">
        {/* 标签行 */}
        <div className="flex items-center mb-1.5 min-w-0">
          <label
            htmlFor={`preset-${field.id}`}
            className="flex min-w-0 items-center gap-1 text-[13px] font-medium text-[var(--foreground)]"
            title={field.description || undefined}
          >
            <span className="shrink-0">{displayLabel}</span>
            {field.required && <span className="text-[var(--destructive)] text-[11px]">*</span>}
          </label>
        </div>

        {/* 文本输入 */}
        {!isSelect && !isTextarea && (
          <input
            id={`preset-${field.id}`}
            type="text"
            value={values[field.id] || ""}
            onChange={(e) => handleChange(field.id, e.target.value)}
            placeholder={field.placeholder}
            className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[13px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] placeholder:opacity-60 focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/30 transition-all"
          />
        )}

        {/* 多行文本输入 */}
        {isTextarea && (
          <textarea
            id={`preset-${field.id}`}
            value={values[field.id] || ""}
            onChange={(e) => handleChange(field.id, e.target.value)}
            placeholder={formatTextareaPlaceholder(field.placeholder)}
            rows={5}
            className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[13px] text-[var(--foreground)] text-left placeholder:text-[var(--muted-foreground)] placeholder:opacity-60 focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/30 transition-all resize-y min-h-[80px] whitespace-pre-wrap"
          />
        )}

        {/* 下拉选择 */}
        {isSelect && (
          <div className="relative group">
            <select
              id={`preset-${field.id}`}
              value={values[field.id] || ""}
              onChange={(e) => handleChange(field.id, e.target.value)}
              className="w-full px-3 py-2 pr-8 bg-[var(--background)] border border-[var(--border)] rounded-lg text-[13px] text-[var(--foreground)] appearance-none focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/30 transition-all cursor-pointer"
            >
              <option value="" hidden={!isClearableMovieBreed}>
                {field.placeholder || "请选择"}
              </option>
              {field.options.map((opt, idx) => (
                <option key={idx} value={opt} className="bg-[var(--card)] text-[var(--foreground)]">
                  {getDisplayText(opt, field.id, agentId)}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--primary)] pointer-events-none opacity-80 group-hover:opacity-100 transition-opacity" />
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className={`${styles.surface} flex max-h-[88dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl`}
        data-testid="agent-preset-intake"
        aria-describedby={undefined}
        showCloseButton={false}
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-[var(--border)] bg-[var(--secondary)]/50">
          <img
            src={resolveAgentAvatarUrl(agentId, agentName, agentIconUrl)}
            alt={agentName}
            className="w-9 h-9 rounded-xl object-cover border border-[var(--border)] shrink-0"
          />
          <div className="flex-1 min-w-0">
            <DialogTitle className="truncate">{agentName}</DialogTitle>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭接收卡"
            className="p-1.5 rounded-lg hover:bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 字段区域 - 2列网格；textarea 与奇数分组的末项跨2列 */}
        <div className="min-h-0 px-5 py-4 max-h-[60vh] overflow-y-auto chat-scroll">
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            {sortedFields.map((field, index) => (
              <div key={field.id} className={getPresetFieldGridClass(sortedFields, index, agentId)}>
                {renderField(field)}
              </div>
            ))}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-3 px-5 py-3.5 border-t border-[var(--border)] bg-[var(--secondary)]/30">
          <button
            onClick={onSkip}
            className="px-4 py-2 text-[13px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--accent)] transition-colors"
          >
            跳过
          </button>
          <button
            onClick={handleStart}
            className="px-5 py-2 text-[13px] font-medium text-[var(--primary-foreground)] bg-[var(--primary)] hover:opacity-90 rounded-lg transition-opacity shadow-lg shadow-[var(--primary)]/20 flex items-center gap-1.5"
          >
            <Send className="w-3.5 h-3.5" />
            开始
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
