import { publishedPreviewRequestAllowed, publishedPreviewService, PublishedPreviewUnavailable } from "@/lib/server/published-configuration-preview";
import { renderPublishedPage, renderPublishedUnavailable } from "@/lib/server/published-configuration-view.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private,no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export async function GET(request: Request) {
  if (!publishedPreviewRequestAllowed(request)) return Response.json({ code: "FORMAL_PREVIEW_LOCAL_ONLY" }, { status: 404, headers });
  const query = new URL(request.url).search;
  if (query !== "" && query !== "?format=json") return Response.json({ code: "PUBLISHED_PREVIEW_QUERY_REJECTED" }, { status: 400, headers });
  try {
    const state = await publishedPreviewService.refresh();
    if (query) return Response.json(state, { headers });
    return new Response(renderPublishedPage(state.snapshot, "/published-preview?format=json", state), {
      headers: { ...headers, "Content-Type": "text/html;charset=utf-8" },
    });
  } catch (error) {
    const cacheState = error instanceof PublishedPreviewUnavailable ? error.cacheState : "corrupt";
    if (query) return Response.json({ code: "PUBLISHED_SOURCE_UNAVAILABLE", cacheState, lastSuccessfulAt: null }, { status: 503, headers });
    return new Response(renderPublishedUnavailable(cacheState), { status: 503, headers: { ...headers, "Content-Type": "text/html;charset=utf-8" } });
  }
}
