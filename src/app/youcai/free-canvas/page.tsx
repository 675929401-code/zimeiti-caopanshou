import { FreeCanvasShell } from "@/components/free-canvas-shell";

interface YoucaiFreeCanvasPageProps {
  searchParams: Promise<{ showcase?: string | string[] }>;
}

export default async function YoucaiFreeCanvasPage({ searchParams }: YoucaiFreeCanvasPageProps) {
  const { showcase } = await searchParams;
  const expectedShowcaseId = typeof showcase === "string" ? showcase : undefined;
  return <FreeCanvasShell expectedShowcaseId={expectedShowcaseId} />;
}
