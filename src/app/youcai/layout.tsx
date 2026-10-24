import { ManjuPersistentLayout } from "@/components/manju-persistent-layout";
import { FeatureComingSoonGate } from "@/components/feature-coming-soon-gate";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  MANJU_WORKBENCH_BRAND,
  MANJU_WORKBENCH_DEFAULT_TITLE,
  MANJU_WORKBENCH_TITLE_TEMPLATE,
} from "@/lib/manju-workbench-brand";

export const metadata: Metadata = {
  applicationName: MANJU_WORKBENCH_BRAND,
  title: {
    default: MANJU_WORKBENCH_DEFAULT_TITLE,
    template: MANJU_WORKBENCH_TITLE_TEMPLATE,
  },
};

export default function ManjuWorkbenchLayout({ children }: { children: ReactNode }) {
  return (
    <FeatureComingSoonGate title="漫剧创作">
      <ManjuPersistentLayout>{children}</ManjuPersistentLayout>
    </FeatureComingSoonGate>
  );
}

