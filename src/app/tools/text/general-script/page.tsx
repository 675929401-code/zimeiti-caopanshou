import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { GeneralScriptOfficial } from "@/features/general-script-official/general-script-official";

export const metadata: Metadata = {
  title: "通用短剧创作",
  description: "需求驱动原创或素材驱动改编，并保存为影视工坊真实项目。",
};

export default function GeneralScriptPage() {
  return (
    <AppRouteShell>
      <GeneralScriptOfficial />
    </AppRouteShell>
  );
}
