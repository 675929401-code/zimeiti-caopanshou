import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { LocalVideoEditor } from "@/features/local-video-tools/local-video-editor";

export const metadata: Metadata = { title: "在线视频编辑器", description: "支持视频裁剪、拼接、静音、提取音频与音视频合成。" };

export default function VideoEditPage(){ return <AppRouteShell><LocalVideoEditor/></AppRouteShell>; }
