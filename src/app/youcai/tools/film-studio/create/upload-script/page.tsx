import type { Metadata } from "next";
import { YoucaiUploadScript } from "@/features/youcai-upload-script/youcai-upload-script";

export const metadata: Metadata = {
  title: "上传剧本",
  description: "上传已有剧本文件（TXT/MD/DOCX），AI自动转为平台标准格式。",
};

export default function FilmStudioUploadScriptPage() {
  return <YoucaiUploadScript />;
}
