import type { Metadata } from "next";
import {
  FilmStudioProjectWorkbench,
  type FilmStudioProjectStep,
} from "@/features/film-studio-project/film-studio-project-workbench";

export const metadata: Metadata = {
  title: "影视项目工作台",
  description: "查看并编辑已保存的影视项目剧本与素材档案。",
};

interface FilmStudioProjectPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ step?: string | string[] }>;
}

const PROJECT_STEPS = new Set<FilmStudioProjectStep>([
  "script",
  "character",
  "scene",
  "prop",
  "storyboard",
  "final",
]);

function readInitialStep(value: string | string[] | undefined): FilmStudioProjectStep {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && PROJECT_STEPS.has(candidate as FilmStudioProjectStep)
    ? candidate as FilmStudioProjectStep
    : "script";
}

export default async function FilmStudioProjectPage({
  params,
  searchParams,
}: FilmStudioProjectPageProps) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);

  return (
    <FilmStudioProjectWorkbench
      projectId={projectId}
      initialStep={readInitialStep(query.step)}
    />
  );
}


