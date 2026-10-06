import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiSkillsPage } from "@/features/youcai-skills/youcai-skills-page";

export const metadata: Metadata = {
  title: "Skill 专家",
  description: "发现、安装和调用漫剧工作台创作 Skill，把专业方法装进创作 Agent。",
};

export default function SkillsPage() {
  return (
    <AppRouteShell>
      <YoucaiSkillsPage />
    </AppRouteShell>
  );
}
