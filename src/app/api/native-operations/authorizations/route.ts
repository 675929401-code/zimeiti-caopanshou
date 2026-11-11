import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { NATIVE_CSRF_HEADER } from "@/lib/native-operations-contract";
import { PublishingAuthorizationActionSchema, PublishingAuthorizationQuerySchema } from "@/lib/publishing-authorization-contract";
import { assertNativeAccess, NATIVE_CSRF_COOKIE, verifyNativeCsrf } from "@/lib/server/native-operations-service";
import { PublishingError, publishingFailure, readPublishingJson } from "@/lib/server/publishing-service";
import { mutatePublishingAuthorization, PublishingAuthorizationError, readPublishingAuthorization } from "@/lib/server/publishing-authorization-service";
import { publishingAuthCookieName } from "@/lib/server/publishing-auth-continuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
const loopback = (host: string) => ["127.0.0.1", "localhost", "[::1]"].includes(host);
function requireSameOrigin(request: NextRequest) {
  let source: URL;
  try { source = new URL(request.headers.get("origin") ?? ""); } catch { throw new PublishingError("NATIVE_CSRF_REJECTED", "请求来源校验失败", 403); }
  if (request.headers.get("sec-fetch-site") === "cross-site" || source.host.toLowerCase() !== (request.headers.get("host") ?? "").toLowerCase() || source.protocol !== "https:" && !(source.protocol === "http:" && loopback(source.hostname))) throw new PublishingError("NATIVE_CSRF_REJECTED", "请求来源校验失败", 403);
}
async function handle(request: NextRequest) {
  const session = request.cookies.get("auth_token")?.value;
  if (!session || request.headers.has("authorization")) return NextResponse.json({ code: "SESSION_EXPIRED", data: null, message: "请先登录主站" }, { status: 401, headers });
  try {
    const response = await withAuth(request, async (user, db) => {
      if (request.headers.get("x-native-actor-id") !== user.id) throw new PublishingError("NATIVE_ACTOR_CHANGED", "主站登录会员已变化，请重新打开工作台", 409);
      const permission = await assertNativeAccess(user);
      if (request.method === "POST") {
        requireSameOrigin(request);
        if (!verifyNativeCsrf(user.id, session, request.headers.get(NATIVE_CSRF_HEADER) ?? "", request.cookies.get(NATIVE_CSRF_COOKIE)?.value ?? "", `${user.role}:${permission.revision}:${permission.checksum}`)) throw new PublishingError("NATIVE_CSRF_REJECTED", "页面验证已过期，请刷新后继续", 403);
        if (new URL(request.url).search || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) throw new PublishingError("PUBLISH_AUTH_INPUT_INVALID", "授权写入只接受 JSON 请求", 400);
      }
      const cookies = { get: (name: string) => request.cookies.get(name)?.value };
      let result;
      if (request.method === "GET") {
        const search = new URL(request.url).searchParams;
        if (new Set(search.keys()).size !== [...search.keys()].length) throw new PublishingError("PUBLISH_AUTH_INPUT_INVALID", "查询参数不能重复", 400);
        const parsed = PublishingAuthorizationQuerySchema.safeParse(Object.fromEntries(search));
        if (!parsed.success) throw new PublishingError("PUBLISH_AUTH_INPUT_INVALID", "查询参数不符合合同", 400);
        result = await readPublishingAuthorization(user, db, parsed.data, cookies);
      } else {
        const parsed = PublishingAuthorizationActionSchema.safeParse(await readPublishingJson(request));
        if (!parsed.success) throw new PublishingError("PUBLISH_AUTH_INPUT_INVALID", "授权参数不符合合同", 400);
        result = await mutatePublishingAuthorization(user, db, parsed.data, cookies);
      }
      const out = NextResponse.json({ code: 0, data: result.data, message: "" }, { headers });
      if (result.continuation) {
        const c = result.continuation, url = new URL(request.url);
        out.cookies.set(publishingAuthCookieName(c.sessionId), c.value, { httpOnly: true, secure: !(url.protocol === "http:" && loopback(url.hostname)), sameSite: "strict", path: "/api/native-operations", expires: new Date(c.expiresAt) });
      }
      return out;
    });
    if ([401, 403, 503].includes(response.status)) {
      const body = await response.clone().json().catch(() => null);
      if (body && typeof body === "object" && !("data" in body)) return NextResponse.json({ code: response.status === 401 ? "SESSION_EXPIRED" : body.code ?? "NATIVE_SERVICE_UNAVAILABLE", data: null, message: body.error ?? "主站登录状态暂不可确认" }, { status: response.status, headers });
    }
    return response;
  } catch (error) {
    const failure = publishingFailure(error);
    return NextResponse.json({ code: failure.body.code, data: null, message: failure.body.error, ...(failure.body.outcome ? { outcome: failure.body.outcome, retryable: false } : {}), ...(error instanceof PublishingAuthorizationError && error.operationId ? { operationId: error.operationId } : {}) }, { status: failure.status, headers });
  }
}
export const GET = handle;
export const POST = handle;
