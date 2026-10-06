import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { DramaScriptWorkbench } from "@/features/drama-script/drama-script-workbench";

export const metadata: Metadata = {
  title: "爽剧剧本创作",
  description: "基于爽点模型的三步结构化爽剧编剧入口。",
};

export default function DramaScriptPage() {
  return (
    <AppRouteShell>
      <DramaScriptWorkbench />
    </AppRouteShell>
  );
}
