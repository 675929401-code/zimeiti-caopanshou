import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import VideoPage from "@/app/video/page";

export const metadata: Metadata = {
  title: "视频生成",
  description: "沿用主站真实视频模型、上传、任务轮询、历史记录、积分和结果访问链路。",
};

export default function CompatibleVideoPage() {
  return (
    <AppRouteShell>
      <VideoPage />
    </AppRouteShell>
  );
}
