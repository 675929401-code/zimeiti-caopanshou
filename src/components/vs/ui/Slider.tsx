'use client';

import React from 'react';

interface SliderProps {
  label?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
}

export default function Slider({ label, min, max, step = 1, value, onChange, suffix = '' }: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        {label && <span className="text-sm font-medium text-[var(--vs-text)]">{label}</span>}
        <span className="text-sm text-[var(--vs-text-muted)] tabular-nums">
          {value}{suffix}
        </span>
      </div>
      <input
        type="range"
        aria-label={label || '数值调整'}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-2 rounded-full appearance-none cursor-pointer accent-[var(--vs-primary)]"
        style={{
          background: `linear-gradient(to right, var(--vs-primary) ${pct}%, var(--vs-border) ${pct}%)`,
        }}
      />
      <div className="flex justify-between text-xs text-[var(--vs-text-muted)]">
        <span>{min}{suffix}</span>
        <span>{max}{suffix}</span>
      </div>
    </div>
  );
}
