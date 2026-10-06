import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
  padding?: boolean;
}

export default function Card({ children, className = '', hover = false, onClick, padding = true }: CardProps) {
  return (
    <div
      className={`bg-[var(--vs-surface)] rounded-2xl border border-[var(--vs-border)] shadow-sm ${
        hover ? 'hover:shadow-md hover:-translate-y-0.5 cursor-pointer' : ''
      } transition-all duration-200 ${padding ? 'p-6' : ''} ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
