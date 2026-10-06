import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { OFFICIAL_INSPIRATION_ITEMS } from "@/features/official-inspiration/inspiration-data";

interface InspirationWorkspacePageProps {
  params: Promise<{ itemId: string }>;
}

export async function generateMetadata({ params }: InspirationWorkspacePageProps): Promise<Metadata> {
  const { itemId } = await params;
  const item = OFFICIAL_INSPIRATION_ITEMS.find((candidate) => candidate.id === itemId);
  if (!item) return { title: "灵感素材不存在" };
  return { title: `${item.title} | 漫剧画布`, description: item.summary };
}

export default async function InspirationWorkspacePage({ params }: InspirationWorkspacePageProps) {
  const { itemId } = await params;
  const item = OFFICIAL_INSPIRATION_ITEMS.find((candidate) => candidate.id === itemId);
  if (!item) notFound();
  redirect("/youcai/free-canvas");
}
