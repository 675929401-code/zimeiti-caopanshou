import { NextRequest, NextResponse } from "next/server";

import { getTokenFromHeaders, verifyToken, type JWTPayload } from "@/lib/auth";
import { buildPublicHelpCatalog, createSeedHelpCatalog } from "@/lib/help-center-domain";
import { loadHelpCatalog } from "@/lib/help-center-store";
import { getSupabaseClient, isSupabaseAvailable } from "@/storage/database/supabase-client";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

async function getViewer(request: Request): Promise<JWTPayload | null> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  try {
    return await verifyToken(token);
  } catch {
    return null;
  }
}

function privateHelpResponse(response: NextResponse) {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(key, value);
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const rawPreview = new URL(request.url).searchParams.get("preview")?.trim() || "";
    const previewSlug = /^[a-z0-9][a-z0-9-]{2,79}$/.test(rawPreview) ? rawPreview : "";

    if (rawPreview && !previewSlug) {
      return NextResponse.json({ error: "预览地址无效" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    let viewer: JWTPayload | null;
    if (previewSlug) {
      const authorization = await authorizeAdminCapability(request, "platform.settings.manage", {
        operation: "help_draft_preview",
        requireStepUp: false,
      });
      if (!authorization.ok) return privateHelpResponse(authorization.response);
      viewer = authorization.actor;
    } else {
      viewer = await getViewer(request);
    }

    let catalog = createSeedHelpCatalog();
    if (isSupabaseAvailable()) {
      const loaded = await loadHelpCatalog(getSupabaseClient());
      catalog = loaded.catalog;
      if (loaded.error) console.warn("[help] using verified seed catalog:", loaded.error);
    }

    const payload = buildPublicHelpCatalog(
      catalog,
      { authenticated: Boolean(viewer), admin: viewer?.role === "admin" },
      previewSlug,
      new Date(),
    );
    return NextResponse.json(payload, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[help] public catalog failed:", error);
    return NextResponse.json({ error: "学习中心暂时不可用" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
