import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PopupStyleLab } from "@/components/demo/popup-style-lab";

export const metadata: Metadata = {
  title: "弹窗风格选择 Demo｜自媒体操盘手",
  description: "五套公告与权益弹窗的本地视觉方案，不连接业务数据。",
};

export default async function PopupStylesDemoPage() {
  const rawHost = (await headers()).get("host")?.trim().toLowerCase() || "";
  const host = rawHost.startsWith("[")
    ? rawHost.slice(0, rawHost.indexOf("]") + 1)
    : rawHost.split(":")[0];

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") notFound();

  return <PopupStyleLab />;
}
