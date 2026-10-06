import { readStudioConfig } from "@/lib/studio-config";
import { createDefaultStudioConfig, type StudioRuntimeConfig } from "@/lib/studio-config-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

function publicConfig(config: StudioRuntimeConfig) {
  return Response.json({
    ok: true,
    config: {
      version: config.version,
      defaults: config.defaults,
      health: config.health,
      brainTemplateId: config.brainTemplateId,
      promptTemplates: config.promptTemplates.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
      updatedAt: config.updatedAt,
    },
  }, { headers: NO_STORE_HEADERS });
}

export async function GET() {
  try {
    return publicConfig(await readStudioConfig());
  } catch (error) {
    console.error("[bridge-runtime-config] falling back to default studio config", error instanceof Error ? error.message : error);
    const fallback = createDefaultStudioConfig();
    return Response.json({
      ok: true,
      mode: "safe_default",
      warning: "Studio runtime config is unavailable; safe defaults are active.",
      config: {
        version: fallback.version,
        defaults: fallback.defaults,
        health: fallback.health,
        brainTemplateId: fallback.brainTemplateId,
        promptTemplates: fallback.promptTemplates.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
        updatedAt: fallback.updatedAt,
      },
    }, { headers: NO_STORE_HEADERS });
  }
}
