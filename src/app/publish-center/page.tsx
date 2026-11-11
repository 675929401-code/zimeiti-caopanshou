import { PublishingStudio } from "@/features/publishing/studio/PublishingStudio";

export default async function PublishCenterPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const tab = (await searchParams).tab;
  return <PublishingStudio initialTab={typeof tab === "string" ? tab : "overview"} />;
}
