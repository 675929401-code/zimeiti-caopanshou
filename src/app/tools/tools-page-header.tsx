"use client";

import { Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { BrandContactButton } from "@/components/brand-contact-panel";
import { SubPageHeader } from "@/components/sub-page-header";
import { UserThemeSwitcher } from "@/components/user-theme-switcher";

export function ToolsPageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <SubPageHeader
      title={title}
      icon={<Wrench aria-hidden="true" className="h-5 w-5 text-[var(--primary)]" />}
      rightSlot={<>
        {children}
        <UserThemeSwitcher />
        <BrandContactButton>联系与反馈</BrandContactButton>
      </>}
    />
  );
}
