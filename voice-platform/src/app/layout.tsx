import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import GlobalTaskBar from "@/components/GlobalTaskBar";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "智音工坊 - AI智能配音工作台",
  description: "一站式AI语音合成、声音复刻、声音设计平台。300+精品音色，专业配音触手可及。",
  keywords: "AI配音, 语音合成, 声音复刻, 声音克隆, TTS, 智能配音",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen flex flex-col bg-vp-background text-vp-foreground">
        <Header />
        <GlobalTaskBar />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
