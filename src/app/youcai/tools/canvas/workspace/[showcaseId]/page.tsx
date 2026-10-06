import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCanvasShareShowcase } from "@/features/official-inspiration/canvas-showcase-data";
import { CanvasShowcaseEditorEntry } from "@/features/official-inspiration/canvas-share-showcase";

interface CanvasWorkspacePageProps {
  params: Promise<{ showcaseId: string }>;
}

export async function generateMetadata({ params }: CanvasWorkspacePageProps): Promise<Metadata> {
  const { showcaseId } = await params;
  const showcase = getCanvasShareShowcase(showcaseId);
  if (!showcase) return { title: "画布不存在" };
  return { title: `${showcase.title} | 漫剧画布`, description: showcase.description };
}

export default async function CanvasWorkspacePage({ params }: CanvasWorkspacePageProps) {
  const { showcaseId } = await params;
  const showcase = getCanvasShareShowcase(showcaseId);
  if (!showcase) notFound();
  return <CanvasShowcaseEditorEntry showcase={showcase} />;
}
