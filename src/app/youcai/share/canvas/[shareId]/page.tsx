import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CanvasShareShowcase } from "@/features/official-inspiration/canvas-share-showcase";
import { getCanvasShareShowcase } from "@/features/official-inspiration/canvas-showcase-data";

interface ShareCanvasPageProps {
  params: Promise<{ shareId: string }>;
}

export async function generateMetadata({ params }: ShareCanvasPageProps): Promise<Metadata> {
  const { shareId } = await params;
  const showcase = getCanvasShareShowcase(shareId);
  if (!showcase) return { title: "画布不存在" };
  return {
    title: `${showcase.title} | 只读画布`,
    description: showcase.description,
  };
}

export default async function ShareCanvasPage({ params }: ShareCanvasPageProps) {
  const { shareId } = await params;
  const showcase = getCanvasShareShowcase(shareId);
  if (!showcase) notFound();

  return <CanvasShareShowcase showcase={showcase} />;
}
