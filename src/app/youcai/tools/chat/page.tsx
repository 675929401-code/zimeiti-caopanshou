import { redirect } from "next/navigation";

// Fallback for environments that do not load next.config redirects. The
// production redirect is declared in next.config.ts so it runs before layouts
// can flush a streamed HTML response.
export const dynamic = "force-dynamic";

export default function AgentCompatibilityRoute() {
  redirect("/youcai/tools/text/text-chat");
}
