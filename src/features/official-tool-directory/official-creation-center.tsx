"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import { useState } from "react";
import { storeYoucaiAgentPrefill } from "@/lib/youcai-agent-prefill";
import {
  Bot,
  Clapperboard,
  FileText,
  ImageIcon,
  Music2,
  Palette,
  Video,
} from "lucide-react";
import styles from "./official-tool-directory.module.css";

const CREATION_ENTRIES = [
  {
    title: "文本创作",
    description: "AI剧本创作、短剧脚本、影视分镜、叙事构思",
    href: "/tools/text",
    Icon: FileText,
    accent: "linear-gradient(135deg, #2563eb, #13b8df)",
  },
  {
    title: "视觉创作",
    description: "概念设计、角色原画、场景绘制、视觉分镜",
    href: "/tools/image",
    Icon: ImageIcon,
    accent: "linear-gradient(135deg, #9239e8, #ec43c5)",
  },
  {
    title: "音频创作",
    description: "配音合成、音效设计、背景音乐、角色语音",
    href: "/tools/audio",
    Icon: Music2,
    accent: "linear-gradient(135deg, #f97316, #fa3e48)",
  },
  {
    title: "视频创作",
    description: "AI视频生成、动态分镜、影像合成、特效制作",
    href: "/tools/video",
    Icon: Video,
    accent: "linear-gradient(135deg, #089981, #22c7b7)",
  },
  {
    title: "影视工坊",
    description: "从剧本到项目，继续管理角色、场景、道具与分镜",
    href: "/tools/film-studio",
    Icon: Clapperboard,
    accent: "linear-gradient(135deg, #4f46e5, #9b4ef4)",
  },
  {
    title: "分镜工作台",
    description: "统一组织脚本、镜头、分镜图、视频提示词与生成进度",
    href: "/storyboard-workbench?legacy=creation-center-canvas",
    Icon: Palette,
    accent: "linear-gradient(135deg, #e5a900, #ff8b28)",
  },
] as const;

export function OfficialCreationCenter() {
  const router = useAppScopedRouter();
  const [agentPrompt, setAgentPrompt] = useState("");

  function openAgent() {
    const prompt = agentPrompt.trim();
    if (prompt) storeYoucaiAgentPrefill(prompt);
    router.push("/tools/text/text-chat");
  }

  return (
    <div className={styles.creationCenter}>
      <section className={styles.centerBanner} aria-label="AI创作中心横幅" />

      <header className={styles.centerHeading}>
        <Clapperboard size={36} strokeWidth={1.8} aria-hidden="true" />
        <h1>AI创作中心</h1>
        <p>直接描述创意，或选择专业分类开始创作</p>
      </header>

      <section className={styles.agentPanel} aria-labelledby="creation-agent-title">
        <div className={styles.agentHeader}>
          <span className={styles.agentIcon}><Bot size={25} /></span>
          <div>
            <h2 id="creation-agent-title">说出灵感，让创意成为作品</h2>
            <p>描述你的想法，Agent 会识别任务类型，并把图片、音乐或视频需求带入对应工作台继续完成。</p>
          </div>
          <span className={styles.comingPill}>微信</span>
        </div>
        <form className={styles.agentComposer} onSubmit={(event) => { event.preventDefault(); openAgent(); }}>
          <textarea
            aria-label="创作中心 Agent 需求"
            onChange={(event) => setAgentPrompt(event.target.value)}
            placeholder="例如：为国风茶饮品牌创作一张夏日海报，再配一段轻快的古筝音乐"
            rows={3}
            value={agentPrompt}
          />
          <button type="submit" disabled={!agentPrompt.trim()}>开始创作 ↑</button>
        </form>
      </section>

      <section className={styles.entryGrid} aria-label="创作分类">
        {CREATION_ENTRIES.map(({ title, description, href, Icon, accent }) => (
          <Link className={styles.entryCard} href={href} key={title} style={{ background: accent }}>
            <span><Icon size={27} strokeWidth={1.8} /></span>
            <div><h3>{title}</h3><p>{description}</p></div>
          </Link>
        ))}
      </section>
    </div>
  );
}
