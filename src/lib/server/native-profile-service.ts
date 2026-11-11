import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { AuthUser, getSupabase } from "../api-middleware";
import { NATIVE_CSRF_HEADER } from "../native-operations-contract";
import { isUserProfileAvatarPreset, isUserProfileAvatarReference, isLegacyUserProfileAvatarReference, isUserProfileAvatarStorageProvider, userProfileAvatarProxyUrl } from "../user-profile-avatar";
import { PublishingError, publishingFailure, readPublishingJson } from "./publishing-service";

type DB = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;
type ProfileContext = { origin: string; session: string | undefined };
type SelfHandler = (request: NextRequest) => Promise<Response>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
const updateSchema = z.object({
  name: z.string().trim().min(2).max(20).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)),
  avatar: z.string().max(2048).optional(),
}).strict();
const presetSchema = z.object({ presetUrl: z.string().refine(isUserProfileAvatarPreset) }).strict();
const dtoSchema = z.object({ id: z.string().uuid(), _id: z.string().uuid(), name: z.string().max(240), avatar: z.string().refine(value => value === "" || isUserProfileAvatarReference(value) || isLegacyUserProfileAvatarReference(value)) }).strict();
export interface NativeProfileDependencies { readSelf?: SelfHandler; updateSelf?: SelfHandler }
const defaultRead: SelfHandler = async request => (await import("../../app/api/auth/me/route")).GET(request);
const defaultUpdate: SelfHandler = async request => (await import("../../app/api/auth/me/route")).PUT(request);
function selfRequest(context: ProfileContext, method = "GET", value?: unknown) {
  if (!context.session || !/^[A-Za-z0-9._-]+$/.test(context.session)) throw new PublishingError("SESSION_EXPIRED", "请先登录主站", 401);
  return new NextRequest(new URL("/api/auth/me", context.origin), {
    method, headers: { Cookie: `auth_token=${context.session}`, ...(value ? { "Content-Type": "application/json" } : {}) },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
}
async function selfResult(response: Response, operation: "read" | "update") {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new PublishingError(response.status === 401 ? "SESSION_EXPIRED" : "NATIVE_PROFILE_SERVICE_UNAVAILABLE", response.status === 401 ? "请先登录主站" : operation === "read" ? "主站个人资料暂不可读取" : "主站个人资料保存失败", response.status);
  if (!value || typeof value !== "object") throw new PublishingError("NATIVE_PROFILE_RESPONSE_INVALID", "主站个人资料回执暂不可确认", 503);
  return object(value);
}

/** Fixed self-service handler only; no caller-selected endpoint or user ID. */
export async function readNativeProfile(user: AuthUser, context: ProfileContext, dependencies: NativeProfileDependencies = {}) {
  const payload = await selfResult(await (dependencies.readSelf ?? defaultRead)(selfRequest(context)), "read");
  const row = object(payload.user);
  if (row.id !== user.id) throw new PublishingError("NATIVE_PROFILE_OWNER_MISMATCH", "个人资料与当前主站会员不一致，请重新进入", 409);
  const avatar = isUserProfileAvatarReference(row.avatarUrl) || isLegacyUserProfileAvatarReference(row.avatarUrl, user.id) ? row.avatarUrl : "";
  const parsed = dtoSchema.safeParse({ id: user.id, _id: user.id, name: text(row.displayName) || text(row.username), avatar });
  if (!parsed.success) throw new PublishingError("NATIVE_PROFILE_RESPONSE_INVALID", "主站个人资料回执暂不可确认", 503);
  return parsed.data;
}

export async function updateNativeProfile(user: AuthUser, raw: unknown, context: ProfileContext, dependencies: NativeProfileDependencies = {}) {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) throw new PublishingError("NATIVE_PROFILE_INPUT_INVALID", "昵称须为2到20个字符，个人资料只接受昵称与当前头像引用", 400);
  if (parsed.data.avatar !== undefined && parsed.data.avatar !== "" && !isUserProfileAvatarReference(parsed.data.avatar) && !isLegacyUserProfileAvatarReference(parsed.data.avatar, user.id)) throw new PublishingError("NATIVE_PROFILE_AVATAR_INVALID", "头像须通过本站个人头像入口上传或选择", 400);
  const current = await readNativeProfile(user, context, dependencies);
  // Shape validation is never ownership. Only this owner's already saved
  // reference may accompany a nickname update; it is not written a second time.
  if (parsed.data.avatar !== undefined && parsed.data.avatar !== current.avatar) throw new PublishingError("NATIVE_PROFILE_AVATAR_CHANGED", "个人头像已变化，请刷新资料后保存昵称", 409);
  const result = await selfResult(await (dependencies.updateSelf ?? defaultUpdate)(selfRequest(context, "PUT", { display_name: parsed.data.name })), "update");
  if (result.success !== true) throw new PublishingError("NATIVE_PROFILE_RESPONSE_INVALID", "主站个人资料保存回执暂不可确认", 503);
  return readNativeProfile(user, context, dependencies);
}

/** The host session reads the same owner avatar table as /api/auth/me. */
export async function readNativeProfileAvatar(db: DB, user: AuthUser): Promise<string> {
  const result = await db.from("user_profile_avatars").select("user_id,avatar_url,storage_provider,storage_key,source").eq("user_id", user.id).maybeSingle();
  if (result.error) {
    if (["42P01", "PGRST205"].includes(String(object(result.error).code))) return "";
    throw new PublishingError("NATIVE_PROFILE_AVATAR_UNAVAILABLE", "主站个人头像暂不可读取", 503);
  }
  if (!result.data) return "";
  const row = object(result.data);
  if (row.user_id !== user.id) throw new PublishingError("NATIVE_PROFILE_OWNER_MISMATCH", "个人头像与当前会员不一致", 409);
  if (row.source === "preset") return isUserProfileAvatarPreset(row.avatar_url) ? row.avatar_url : "";
  if (row.source === "upload" && typeof row.storage_key === "string" && isUserProfileAvatarStorageProvider(row.storage_provider)) {
    const url = userProfileAvatarProxyUrl(row.storage_key, row.storage_provider);
    return isUserProfileAvatarReference(url) || row.avatar_url === url && isLegacyUserProfileAvatarReference(url, user.id) ? url : "";
  }
  return "";
}

export interface NativeProfileAvatarDependencies {
  authenticate(request: NextRequest, handler: (user: AuthUser, db: DB) => Promise<Response>): Promise<Response>;
  access(user: AuthUser): Promise<{ revision: unknown; checksum: string }>;
  csrf(owner: string, session: string, header: string, cookie: string, permission: string): Promise<boolean>;
  upload: SelfHandler;
  preset: SelfHandler;
}
const avatarDefaults: NativeProfileAvatarDependencies = {
  authenticate: async (request, handler) => (await import("../api-middleware")).withAuth(request, (user, db) => handler(user, db)),
  access: async user => (await import("./native-operations-service")).assertNativeAccess(user),
  csrf: async (...args) => (await import("./native-operations-service")).verifyNativeCsrf(...args),
  upload: async request => (await import("../../app/api/auth/avatar/route")).POST(request),
  preset: async request => (await import("../../app/api/auth/avatar/route")).PUT(request),
};
function sameOrigin(request: NextRequest) {
  let source: URL;
  try { source = new URL(request.headers.get("origin") ?? ""); } catch { throw new PublishingError("NATIVE_CSRF_REJECTED", "请求来源校验失败", 403); }
  const local = source.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(source.hostname);
  if (request.headers.get("sec-fetch-site") === "cross-site" || source.host.toLowerCase() !== (request.headers.get("host") ?? "").toLowerCase() || source.protocol !== "https:" && !local) throw new PublishingError("NATIVE_CSRF_REJECTED", "请求来源校验失败", 403);
}
/** Keeps the original file-size/MIME/sharp/storage/ownership checks intact. */
export function createNativeProfileAvatarHandler(overrides: Partial<NativeProfileAvatarDependencies> = {}) {
  const deps = { ...avatarDefaults, ...overrides };
  return async (request: NextRequest): Promise<Response> => {
    const session = request.cookies.get("auth_token")?.value;
    if (!session || request.headers.has("authorization")) return NextResponse.json({ code: "SESSION_EXPIRED", data: null, message: "请先登录主站" }, { status: 401, headers: privateHeaders });
    try {
      const response = await deps.authenticate(request, async user => {
        if (request.headers.get("x-native-actor-id") !== user.id) throw new PublishingError("NATIVE_ACTOR_CHANGED", "主站登录会员已变化，请重新打开工作台", 409);
        const permission = await deps.access(user);
        sameOrigin(request);
        if (!await deps.csrf(user.id, session, request.headers.get(NATIVE_CSRF_HEADER) ?? "", request.cookies.get("native_host_csrf")?.value ?? "", `${user.role}:${permission.revision}:${permission.checksum}`)) throw new PublishingError("NATIVE_CSRF_REJECTED", "页面验证已过期，请刷新后继续", 403);
        if (request.nextUrl.search) throw new PublishingError("NATIVE_PROFILE_INPUT_INVALID", "个人头像入口不接受查询参数", 400);
        let saved: Response;
        if (request.method === "POST") {
          if (!/^multipart\/form-data;\s*boundary=/i.test(request.headers.get("content-type") ?? "")) throw new PublishingError("NATIVE_PROFILE_INPUT_INVALID", "个人头像上传须使用文件表单", 400);
          saved = await deps.upload(request);
        } else if (request.method === "PUT") {
          if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) throw new PublishingError("NATIVE_PROFILE_INPUT_INVALID", "预设头像须使用JSON请求", 400);
          const parsed = presetSchema.safeParse(await readPublishingJson(request));
          if (!parsed.success) throw new PublishingError("NATIVE_PROFILE_AVATAR_INVALID", "请选择平台提供的预设头像", 400);
          saved = await deps.preset(new NextRequest(new URL("/api/auth/avatar", request.url), { method: "PUT", headers: { Cookie: `auth_token=${session}`, "Content-Type": "application/json" }, body: JSON.stringify(parsed.data) }));
        } else throw new PublishingError("NATIVE_PROFILE_METHOD_INVALID", "个人头像入口不支持此操作", 405);
        const payload = object(await saved.json().catch(() => null));
        if (!saved.ok) {
          const code = payload.code === "AVATAR_STORAGE_NOT_READY" ? "AVATAR_STORAGE_NOT_READY" : "NATIVE_PROFILE_AVATAR_FAILED";
          return NextResponse.json({ code, data: null, message: text(payload.error).slice(0, 300) || "个人头像保存失败" }, { status: saved.status, headers: privateHeaders });
        }
        if (payload.success !== true || !isUserProfileAvatarReference(payload.avatarUrl)) throw new PublishingError("NATIVE_PROFILE_RESPONSE_INVALID", "主站头像保存回执暂不可确认", 503);
        return NextResponse.json({ code: 0, data: { avatarUrl: payload.avatarUrl }, message: "" }, { headers: privateHeaders });
      });
      if ([401, 403, 503].includes(response.status)) {
        const body = object(await response.clone().json().catch(() => null));
        if (!("data" in body)) return NextResponse.json({ code: response.status === 401 ? "SESSION_EXPIRED" : "NATIVE_PROFILE_ACCESS_UNAVAILABLE", data: null, message: response.status === 401 ? "请先登录主站" : "主站个人资料访问权限暂不可确认" }, { status: response.status, headers: privateHeaders });
      }
      return response;
    } catch (error) {
      const failure = publishingFailure(error);
      return NextResponse.json({ code: failure.body.code, data: null, message: failure.body.error }, { status: failure.status, headers: privateHeaders });
    }
  };
}
