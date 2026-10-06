import type { Metadata } from "next";
import { AppScopedLink } from "@/components/app-scoped-link";
import { YoucaiFilmStudioPortal } from "@/features/youcai-film-studio/youcai-film-studio-portal";

export const metadata: Metadata = {
  title: "影视创作工坊",
  description: "从剧本到成片，全流程一站式创作。",
};

export default function FilmStudioPage() {
  return (
    <>
      <AppScopedLink
        aria-label="返回创作中心"
        className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-4 py-2 text-sm font-semibold text-slate-700 shadow-lg backdrop-blur transition hover:border-violet-300 hover:text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
        data-testid="film-studio-return-link"
        href="/tools"
      >
        <span aria-hidden="true">←</span>
        返回创作中心
      </AppScopedLink>
      <YoucaiFilmStudioPortal />
    </>
  );
}
