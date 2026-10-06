import { HelpCenterClient } from "../help-center-client";

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <HelpCenterClient initialSlug={slug} />;
}
