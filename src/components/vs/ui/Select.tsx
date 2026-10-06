'use client';

import React from 'react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

export default function Select({ label, error, options, className = '', id, ...props }: SelectProps) {
  const selectId = id || label?.replace(/\s/g, '-').toLowerCase();
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={selectId} className="block text-sm font-medium text-[var(--vs-text)]">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`w-full rounded-xl border border-[var(--vs-border)] bg-[var(--vs-surface)] px-4 py-2.5 text-sm text-[var(--vs-text)] transition-colors focus:border-[var(--vs-primary)] focus:ring-2 focus:ring-[var(--vs-primary)]/20 focus:outline-none ${className}`}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
