import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { SubtitleRemoverWorkbench } from "@/features/local-video-tools/subtitle-remover-workbench";

export const metadata: Metadata = { title: "视频去字幕", description: "使用 FFmpeg 处理固定位置硬字幕。" };

export default function SubtitleRemoverPage(){return <AppRouteShell><SubtitleRemoverWorkbench/></AppRouteShell>;}
