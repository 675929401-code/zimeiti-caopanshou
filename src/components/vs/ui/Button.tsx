'use client';

import React from 'react';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: React.ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-[var(--vs-primary)] text-white hover:bg-[var(--vs-primary-hover)] shadow-sm',
  secondary: 'bg-[var(--vs-surface)] text-[var(--vs-text)] hover:bg-[var(--vs-surface-hover)] border border-[var(--vs-border)]',
  outline: 'border-2 border-[var(--vs-border)] text-[var(--vs-text-muted)] hover:border-[var(--vs-primary)] hover:text-[var(--vs-primary)]',
  ghost: 'text-[var(--vs-text-muted)] hover:text-[var(--vs-primary)] hover:bg-[var(--vs-surface)]',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  );
}
