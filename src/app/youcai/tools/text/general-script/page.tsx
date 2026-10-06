import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiGeneralScript } from "@/features/youcai-general-script/youcai-general-script";

export const metadata: Metadata = {
  title: "通用短剧创作",
  description: "需求驱动原创或素材驱动改编，支持童话、小说等多种剧本类型。",
};

export default function GeneralScriptPage() {
  return (
    <AppRouteShell>
      <YoucaiGeneralScript />
    </AppRouteShell>
  );
}

