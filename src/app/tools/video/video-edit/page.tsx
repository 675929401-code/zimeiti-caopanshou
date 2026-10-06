import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { LocalVideoEditor } from "@/features/local-video-tools/local-video-editor";

export const metadata: Metadata = { title: "在线视频编辑器 | 自媒体操盘手", description: "主站本地 FFmpeg 视频裁剪、拼接、静音、提取音频与音视频合成。" };

export default function VideoEditPage(){ return <AppRouteShell><LocalVideoEditor/></AppRouteShell>; }
