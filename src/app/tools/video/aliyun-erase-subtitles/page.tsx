import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { SubtitleRemoverWorkbench } from "@/features/local-video-tools/subtitle-remover-workbench";

export const metadata: Metadata = { title: "视频去字幕 | 自媒体操盘手", description: "使用主站本地 FFmpeg 处理固定位置硬字幕，并明确展示非自动 OCR 边界。" };

export default function SubtitleRemoverPage(){return <AppRouteShell><SubtitleRemoverWorkbench/></AppRouteShell>;}
