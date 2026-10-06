import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiUploadScript } from "@/features/youcai-upload-script/youcai-upload-script";

export const metadata: Metadata = {
  title: "上传剧本",
  description: "上传已有剧本文件（TXT/MD/DOCX），AI自动转为平台标准格式。",
};

export default function UploadScriptPage() {
  return (
    <AppRouteShell>
      <YoucaiUploadScript />
    </AppRouteShell>
  );
}
