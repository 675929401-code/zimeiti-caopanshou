import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { UploadScriptWorkbench } from "@/features/upload-script/upload-script-workbench";

export const metadata: Metadata = {
  title: "上传剧本",
  description: "上传 TXT、MD 或 DOCX 剧本，标准化格式后进入影视创作工坊。",
};

export default function UploadScriptPage() {
  return (
    <AppRouteShell>
      <UploadScriptWorkbench />
    </AppRouteShell>
  );
}
