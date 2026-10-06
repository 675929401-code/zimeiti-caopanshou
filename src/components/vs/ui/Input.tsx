'use client';

import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export default function Input({ label, error, className = '', id, ...props }: InputProps) {
  const inputId = id || label?.replace(/\s/g, '-').toLowerCase();
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-[var(--vs-text)]">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`w-full rounded-xl border border-[var(--vs-border)] bg-[var(--vs-surface)] px-4 py-2.5 text-sm text-[var(--vs-text)] placeholder-[var(--vs-text-muted)] transition-colors focus:border-[var(--vs-primary)] focus:ring-2 focus:ring-[var(--vs-primary)]/20 focus:outline-none disabled:bg-[var(--vs-bg-secondary)] disabled:text-[var(--vs-text-muted)] ${
          error ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20' : ''
        } ${className}`}
        {...props}
      />
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
