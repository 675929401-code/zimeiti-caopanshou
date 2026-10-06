"use client";

import { createContext, useContext, type ReactNode } from "react";

export type ToolboxTabId = "segment" | "text" | "video" | "format";

const ToolboxContext = createContext<{ activeTab: ToolboxTabId; onTabChange?: (tab: ToolboxTabId) => void } | null>(null);

export function ToolboxProvider({ activeTab, onTabChange, children }: { activeTab: ToolboxTabId; onTabChange?: (tab: ToolboxTabId) => void; children: ReactNode }) {
  return <ToolboxContext.Provider value={{ activeTab, onTabChange }}>{children}</ToolboxContext.Provider>;
}

export function useToolboxHost() {
  return useContext(ToolboxContext);
}
