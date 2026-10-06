"use client";

import {
  getVideoStyleByPromptValue,
  getVideoStylesByCategory,
  VIDEO_STYLE_CATEGORIES,
} from "@/lib/short-drama/video-style-presets";
import styles from "./video-style-picker.module.css";

const CUSTOM_STYLE_VALUE = "__custom_video_style__";

export function VideoStylePicker({
  value,
  onChange,
  id,
  disabled = false,
  rootClassName,
  selectClassName,
  inputClassName,
  ariaLabel = "视觉风格预设",
  customPlaceholder = "输入自定义视觉风格",
  maxLength = 120,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly rootClassName?: string;
  readonly selectClassName?: string;
  readonly inputClassName?: string;
  readonly ariaLabel?: string;
  readonly customPlaceholder?: string;
  readonly maxLength?: number;
}) {
  const preset = getVideoStyleByPromptValue(value);
  const selection = preset ? preset.promptValue : value.trim() ? CUSTOM_STYLE_VALUE : "";
  const showCustom = selection === CUSTOM_STYLE_VALUE;

  return (
    <div
      className={[styles.root, rootClassName].filter(Boolean).join(" ")}
      data-testid="video-style-picker"
      data-style-kind={preset ? preset.category : showCustom ? "custom" : "empty"}
    >
      <select
        id={id}
        className={selectClassName}
        aria-label={ariaLabel}
        disabled={disabled}
        value={selection}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM_STYLE_VALUE) {
            if (preset) onChange("");
            return;
          }
          onChange(next);
        }}
      >
        <option value="">请选择视觉风格</option>
        {VIDEO_STYLE_CATEGORIES.map((category) => (
          <optgroup key={category.id} label={category.label}>
            {getVideoStylesByCategory(category.id).map((style) => (
              <option key={style.id} value={style.promptValue}>{style.label}</option>
            ))}
          </optgroup>
        ))}
        <option value={CUSTOM_STYLE_VALUE}>自定义风格…</option>
      </select>
      {showCustom && (
        <input
          className={inputClassName}
          aria-label="自定义视觉风格"
          disabled={disabled}
          maxLength={maxLength}
          value={value}
          placeholder={customPlaceholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {preset && <span className={styles.description}>{preset.promptValue}</span>}
    </div>
  );
}
