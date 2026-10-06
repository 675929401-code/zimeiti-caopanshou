export type GeneralScriptRequestHandler = (request: Request) => Promise<Response>;

export interface GeneralScriptRouteDependencies {
  readHistory: GeneralScriptRequestHandler;
  execute: GeneralScriptRequestHandler;
}

const PROFILE_BY_SURFACE = {
  general: "general-script",
  formal: "general-script",
} as const;

type GeneralScriptSurface = keyof typeof PROFILE_BY_SURFACE;

const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

function normalizeSurface(value: string | null): string {
  return value?.trim().toLowerCase() || "";
}

function isGeneralScriptSurface(value: string): value is GeneralScriptSurface {
  return Object.prototype.hasOwnProperty.call(PROFILE_BY_SURFACE, value);
}

function boundaryError(code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status: 400,
    headers: PRIVATE_NO_STORE_HEADERS,
  });
}

function invalidSurface(): Response {
  return boundaryError(
    "GENERAL_SCRIPT_SURFACE_INVALID",
    "该通用编剧入口只接受 general 或 formal 页面请求。",
  );
}

function forceGeneralScriptHistoryProfile(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.set("profile", "general-script");
  return new Request(url, request);
}

async function readProfileId(request: Request): Promise<string | null> {
  try {
    const body = await request.clone().json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const profile = (body as { profile?: unknown }).profile;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
    const profileId = (profile as { id?: unknown }).id;
    return typeof profileId === "string" ? profileId.trim() : null;
  } catch {
    return null;
  }
}

export function createGeneralScriptRouteBoundary(dependencies: GeneralScriptRouteDependencies) {
  return {
    GET: async (request: Request): Promise<Response> => {
      const surface = normalizeSurface(new URL(request.url).searchParams.get("surface"));
      if (!isGeneralScriptSurface(surface)) return invalidSurface();
      return dependencies.readHistory(forceGeneralScriptHistoryProfile(request));
    },
    POST: async (request: Request): Promise<Response> => {
      const surface = normalizeSurface(request.headers.get("x-general-script-surface"));
      if (!isGeneralScriptSurface(surface)) return invalidSurface();

      const profileId = await readProfileId(request);
      if (profileId !== PROFILE_BY_SURFACE[surface]) {
        return boundaryError(
          "GENERAL_SCRIPT_PROFILE_INVALID",
          "该通用编剧入口只接受 general-script 提示词配置。",
        );
      }

      return dependencies.execute(request);
    },
  };
}
