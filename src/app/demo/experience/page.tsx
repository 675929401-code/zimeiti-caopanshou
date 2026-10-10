import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ExperienceFlowDemo } from "@/components/demo/experience-flow-demo";

export default async function ExperienceDemoPage() {
  const rawHost = (await headers()).get("host")?.trim().toLowerCase() || "";
  const host = rawHost.startsWith("[")
    ? rawHost.slice(0, rawHost.indexOf("]") + 1)
    : rawHost.split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") notFound();
  return <ExperienceFlowDemo />;
}
