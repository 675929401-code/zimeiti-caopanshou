'use client';

import React from 'react';

interface Tab {
  id: string;
  label: string;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
}

export default function Tabs({ tabs, activeTab, onChange }: TabsProps) {
  return (
    <div className="flex border-b border-[var(--vs-border)]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`relative px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === tab.id
              ? 'text-[var(--vs-primary)]'
              : 'text-[var(--vs-text-muted)] hover:text-[var(--vs-text)]'
          }`}
        >
          {tab.label}
          {activeTab === tab.id && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--vs-primary)] rounded-full" />
          )}
        </button>
      ))}
    </div>
  );
}
