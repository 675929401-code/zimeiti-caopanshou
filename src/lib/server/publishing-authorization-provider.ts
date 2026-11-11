import "server-only";
import { z } from "zod";
import { isPublishingSafeHttps } from "../publishing-contract";
import { PublishingAuthorizationPlatformSchema, type PublishingAuthorizationPlatform } from "../publishing-authorization-contract";
import { publishingProviderPayloadHash, type PublishingProviderGrant } from "./publishing-provider";

const ident = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/);
const plain = z.string().max(240).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
const avatar = z.string().max(2048).refine(isPublishingSafeHttps);
const account = z.object({ accountId: ident, platform: PublishingAuthorizationPlatformSchema, platformUid: plain.min(1), account: plain.optional(), displayName: plain, avatarUrl: avatar.optional() }).strip();
const choice = account.omit({ accountId: true }).extend({ parentPlatformUid: plain.optional() }).strip();
const instructions = z.object({ "zh-CN": z.string().max(2000), "en-US": z.string().max(2000) }).strip();
export const PublishingAuthorizationProviderStatusSchema = z.object({ sessionId: ident, status: z.enum(["pending", "completed", "failed"]), requiresSelection: z.boolean(), errorCode: z.number().int().optional(), accountId: ident.optional(), accountIds: z.array(ident).max(100).optional(), accounts: z.array(account).max(100).optional(), selectableAccounts: z.array(choice).max(100).optional() }).strip().superRefine((v, ctx) => {
  const ids = v.accountIds ?? v.accounts?.map(a => a.accountId);
  if (ids && (new Set(ids).size !== ids.length || v.accountId !== undefined && v.accountId !== ids[0] || v.accounts !== undefined && (v.accounts.length !== ids.length || v.accounts.some(a => !ids.includes(a.accountId)) || v.accounts[0]?.accountId !== ids[0]))) ctx.addIssue({ code: "custom", message: "官方账号身份集合不一致" });
  if (v.status === "completed" && v.requiresSelection || v.status === "failed" && v.requiresSelection) ctx.addIssue({ code: "custom", message: "官方授权状态不一致" });
});
export type PublishingAuthorizationProviderStatus = z.infer<typeof PublishingAuthorizationProviderStatusSchema>;
export type AuthorizationGrant = Pick<PublishingProviderGrant, "ownerId" | "operationId" | "kind" | "subject" | "payloadHash">;
export class PublishingAuthorizationProviderError extends Error {
  constructor(readonly code: "AUTH_PROVIDER_UNAVAILABLE" | "AUTH_PROVIDER_PROTOCOL_INVALID" | "AUTH_PROVIDER_OUTCOME_UNKNOWN" | "AUTH_PROVIDER_SCOPE_INVALID" | "AUTH_PROVIDER_GRANT_REJECTED") { super(code); }
}
function fail(code: PublishingAuthorizationProviderError["code"]): never { throw new PublishingAuthorizationProviderError(code); }
/** Fixed upstream 47e5a6fa entry points. This policy is separate from public media URLs. */
export function isPublishingAuthorizationUrl(value: string, platform: PublishingAuthorizationPlatform, sessionId: string): boolean {
  try {
    const rawPath = value.match(/^https:\/\/[^/?#]+([^?#]*)/)?.[1];
    if (rawPath === undefined || /%|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath) || value.length > 16384 || /[\\\s\u0000-\u001f\u007f]/.test(value) || /%(?:00|0a|0d)/i.test(value)) return false;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname.includes("%") || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== sessionId) return false;
    if ([...url.searchParams.keys()].some(k => /cookie|token|secret|password|credential|authorization|api.?key|signature|(?:code|pkce).?verifier/i.test(k) || /^(?:code|headers|continuation)$/i.test(k))) return false;
    if (url.searchParams.has("response_type") && url.searchParams.get("response_type") !== "code") return false;
    const entries: Record<PublishingAuthorizationPlatform, readonly [string, string | RegExp]> = {
      linkedin: ["www.linkedin.com", "/oauth/v2/authorization"], threads: ["threads.net", "/oauth/authorize"], instagram: ["www.instagram.com", "/oauth/authorize"],
      KWAI: ["open.kuaishou.com", "/oauth2/authorize"], pinterest: ["www.pinterest.com", "/oauth/"], wxGzh: ["open.weixin.qq.com", "/connect/oauth2/authorize"],
      bilibili: ["account.bilibili.com", "/pc/account-pc/auth/oauth"], facebook: ["www.facebook.com", /^\/v[1-9][0-9]?\.[0-9]{1,2}\/dialog\/oauth$/],
      youtube: ["accounts.google.com", "/o/oauth2/v2/auth"], tiktok: ["www.tiktok.com", "/v2/auth/authorize"], twitter: ["x.com", "/i/oauth2/authorize"],
    };
    const [host, path] = entries[platform];
    const authority = value.slice(8).split(/[/?#]/, 1)[0].toLowerCase();
    return (authority === host || authority === `${host}:443`) && url.hostname === host && (typeof path === "string" ? url.pathname === path : path.test(url.pathname)) && (platform === "wxGzh" ? url.hash === "#wechat_redirect" : url.hash === "");
  } catch { return false; }
}
export interface PublishingAuthorizationProviderOptions {
  environment: "domestic" | "international"; apiKey: string; ownerId: string;
  sessionIds?: ReadonlySet<string>; accountIds?: ReadonlySet<string>; fetch?: typeof fetch;
  consumeGrant: (grant: AuthorizationGrant) => Promise<boolean>;
}
export interface PublishingAuthorizationProviderClient {
  capabilities(): Promise<Array<{ platform: PublishingAuthorizationPlatform; status: string; authType: string }>>;
  start(platform: PublishingAuthorizationPlatform, localSessionId: string, operationId: string): Promise<{ sessionId: string; url: string; expiresAt: string; instructions?: z.infer<typeof instructions> }>;
  status(platform: PublishingAuthorizationPlatform, providerSessionId: string): Promise<PublishingAuthorizationProviderStatus>;
  select(providerSessionId: string, accounts: Array<{ platformUid: string; account?: string }>, operationId: string, cookie: string): Promise<void>;
  readAccount(id: string): Promise<{ id: string; platform: PublishingAuthorizationPlatform; platformUid: string; account?: string; displayName: string; avatarUrl?: string }>;
  takeCookie(sessionId: string): string | undefined;
}
export class PublishingAuthorizationProvider implements PublishingAuthorizationProviderClient {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly cookies = new Map<string, string>();
  private readonly consumed = new Set<string>();
  constructor(private readonly options: PublishingAuthorizationProviderOptions) { this.origin = options.environment === "international" ? "https://aitoearn.ai" : "https://aitoearn.cn"; this.fetcher = options.fetch ?? fetch; }
  private scope(kind: "sessionIds" | "accountIds", id: string) { if (!ident.safeParse(id).success || !this.options[kind]?.has(id)) fail("AUTH_PROVIDER_SCOPE_INVALID"); }
  private async grant(operationId: string, subject: string, body: unknown) {
    if (!this.options.apiKey || !this.options.ownerId || !ident.safeParse(operationId).success || this.consumed.has(operationId)) fail("AUTH_PROVIDER_GRANT_REJECTED");
    this.consumed.add(operationId);
    if (!await this.options.consumeGrant({ ownerId: this.options.ownerId, operationId, kind: "authorization", subject, payloadHash: publishingProviderPayloadHash(body) })) fail("AUTH_PROVIDER_GRANT_REJECTED");
  }
  private async request(path: string, mutation = false, body?: unknown, cookie?: string, discardHtml = false): Promise<{ data: unknown; cookie?: string }> {
    if (!this.options.apiKey) fail("AUTH_PROVIDER_GRANT_REJECTED");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await this.fetcher(`${this.origin}/api/v2/channels${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", signal: controller.signal, headers: { "X-Api-Key": this.options.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok || Number(response.headers.get("content-length") || 0) > 2 * 1024 ** 2) fail(mutation ? "AUTH_PROVIDER_OUTCOME_UNKNOWN" : "AUTH_PROVIDER_UNAVAILABLE");
      const reader = response.body?.getReader(); if (!reader) fail(mutation ? "AUTH_PROVIDER_OUTCOME_UNKNOWN" : "AUTH_PROVIDER_PROTOCOL_INVALID");
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 ** 2) { await reader.cancel(); fail(mutation ? "AUTH_PROVIDER_OUTCOME_UNKNOWN" : "AUTH_PROVIDER_PROTOCOL_INVALID"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
      if (discardHtml) return { data: undefined };
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const envelope = z.object({ code: z.literal(0), data: z.unknown() }).strip().safeParse(raw); if (!envelope.success) fail(mutation ? "AUTH_PROVIDER_OUTCOME_UNKNOWN" : "AUTH_PROVIDER_PROTOCOL_INVALID");
      const cookies = response.headers.getSetCookie();
      const continuation = cookies.map(v => v.split(";", 1)[0]).find(v => /^_cas=[^;\r\n]{1,2048}$/.test(v));
      return { data: envelope.data.data, ...(continuation ? { cookie: continuation } : {}) };
    } catch (error) { if (error instanceof PublishingAuthorizationProviderError) throw error; return fail(mutation ? "AUTH_PROVIDER_OUTCOME_UNKNOWN" : "AUTH_PROVIDER_UNAVAILABLE"); } finally { clearTimeout(timer); }
  }
  async capabilities() {
    const response = await this.request("/platforms");
    const parsed = z.array(z.object({ platform: z.string(), status: z.string(), authType: z.string() }).strip()).max(100).safeParse(response.data); if (!parsed.success) fail("AUTH_PROVIDER_PROTOCOL_INVALID");
    return parsed.data.flatMap(v => { const p = PublishingAuthorizationPlatformSchema.safeParse(v.platform); return p.success ? [{ ...v, platform: p.data }] : []; });
  }
  async start(platform: PublishingAuthorizationPlatform, localSessionId: string, operationId: string) {
    const body = { type: platform, correlationId: localSessionId, callbackUrl: null };
    await this.grant(operationId, localSessionId, body);
    const response = await this.request(`/accounts/auth/${encodeURIComponent(platform)}`, true);
    const parsed = z.object({ sessionId: ident, url: z.string().max(16384), expiresAt: z.union([z.string().datetime({ offset: true }), z.number().finite()]), authInstructions: instructions.optional() }).strip().safeParse(response.data);
    if (!parsed.success || !isPublishingAuthorizationUrl(parsed.data.url, platform, parsed.data.sessionId)) fail("AUTH_PROVIDER_OUTCOME_UNKNOWN");
    const time = typeof parsed.data.expiresAt === "number" ? parsed.data.expiresAt < 1e12 ? parsed.data.expiresAt * 1000 : parsed.data.expiresAt : Date.parse(parsed.data.expiresAt);
    if (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 30 * 60000) fail("AUTH_PROVIDER_OUTCOME_UNKNOWN");
    if (response.cookie) this.cookies.set(parsed.data.sessionId, response.cookie);
    return { sessionId: parsed.data.sessionId, url: parsed.data.url, expiresAt: new Date(time).toISOString(), ...(parsed.data.authInstructions ? { instructions: parsed.data.authInstructions } : {}) };
  }
  async status(platform: PublishingAuthorizationPlatform, providerSessionId: string) {
    this.scope("sessionIds", providerSessionId);
    const response = await this.request(`/accounts/auth/${encodeURIComponent(platform)}/status/${encodeURIComponent(providerSessionId)}`);
    const result = PublishingAuthorizationProviderStatusSchema.safeParse(response.data);
    if (!result.success || result.data.sessionId !== providerSessionId || [...(result.data.accounts ?? []), ...(result.data.selectableAccounts ?? [])].some(v => v.platform !== platform)) fail("AUTH_PROVIDER_PROTOCOL_INVALID");
    return result.data;
  }
  async select(providerSessionId: string, accounts: Array<{ platformUid: string; account?: string }>, operationId: string, cookie: string) {
    this.scope("sessionIds", providerSessionId);
    const parsed = z.array(z.object({ platformUid: plain.min(1), account: plain.optional() }).strict()).min(1).max(100).safeParse(accounts);
    if (!parsed.success || !/^_cas=[^;\r\n]{1,2048}$/.test(cookie)) fail("AUTH_PROVIDER_SCOPE_INVALID");
    const body = { accounts: parsed.data };
    await this.grant(operationId, `${providerSessionId}:selection`, body);
    await this.request("/accounts/auth/selections", true, body, cookie, true);
  }
  async readAccount(id: string) {
    this.scope("accountIds", id);
    const response = await this.request(`/accounts/${encodeURIComponent(id)}`);
    const result = z.object({ id: ident, type: PublishingAuthorizationPlatformSchema, uid: plain.min(1), account: plain.optional(), nickname: plain, avatar: avatar.optional() }).strip().safeParse(response.data);
    if (!result.success || result.data.id !== id) fail("AUTH_PROVIDER_PROTOCOL_INVALID");
    return { id, platform: result.data.type, platformUid: result.data.uid, displayName: result.data.nickname, ...(result.data.account ? { account: result.data.account } : {}), ...(result.data.avatar ? { avatarUrl: result.data.avatar } : {}) };
  }
  takeCookie(sessionId: string) { const value = this.cookies.get(sessionId); this.cookies.delete(sessionId); return value; }
}
