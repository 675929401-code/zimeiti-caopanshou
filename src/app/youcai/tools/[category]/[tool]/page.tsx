import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppRouteShell } from "@/components/app-route-shell";
import {
  getOfficialToolAlias,
  OFFICIAL_TOOL_ALIAS_PARAMS,
} from "@/features/official-tool-aliases/official-tool-alias-map";
import { OfficialToolAliasPage } from "@/features/official-tool-aliases/official-tool-alias-page";

interface OfficialToolAliasRouteProps {
  params: Promise<{ category: string; tool: string }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return OFFICIAL_TOOL_ALIAS_PARAMS;
}

export async function generateMetadata({ params }: OfficialToolAliasRouteProps): Promise<Metadata> {
  const { category, tool } = await params;
  const definition = getOfficialToolAlias(category, tool);
  if (!definition) return { title: "工具不存在" };

  return {
    title: definition.title,
    description: definition.officialIntent,
  };
}

export default async function OfficialToolAliasRoute({ params }: OfficialToolAliasRouteProps) {
  const { category, tool } = await params;
  const definition = getOfficialToolAlias(category, tool);
  if (!definition) notFound();

  return (
    <AppRouteShell>
      <OfficialToolAliasPage definition={definition} />
    </AppRouteShell>
  );
}
