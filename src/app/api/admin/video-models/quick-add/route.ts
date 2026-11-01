/** Parse non-sensitive model hints; all configuration writes use the detailed form. */
import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { isPermanentlyRetiredModel } from "@/lib/model-retirement";

function parseLine(text: string) {
  if (text.length > 2000 || /[\r\n\u0000]/u.test(text)
    || /\b(?:Bearer\s|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=])/iu.test(text)) {
    throw new Error("仅填写渠道地址、模型名和售价；密钥应在详细配置的专用字段中填写");
  }
  const urlMatch = text.match(/https?:\/\/[^\s]+/iu);
  if (!urlMatch) throw new Error("请填写 HTTPS 渠道地址和精确模型名");
  const url = new URL(urlMatch[0]);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("渠道地址须为不含账号、密码、查询参数或片段的 HTTPS 地址");
  }
  const base = url.origin + url.pathname.replace(/\/+$/u, "").replace(/\/v1$/iu, "");
  let rest = text.replace(urlMatch[0], " ");
  const priceMatch = rest.match(/(?:售价|价格|\bprice)[：:=\s]*([^\s]+)/iu);
  let price: number | null = null;
  if (priceMatch) {
    if (!/^\d+(?:\.\d+)?$/u.test(priceMatch[1])) throw new Error("售价须为明确的非负有限数值");
    price = Number(priceMatch[1]);
    if (!Number.isFinite(price) || price < 0) throw new Error("售价须为明确的非负有限数值");
    rest = rest.replace(priceMatch[0], " ");
  }
  const tokens = rest.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,159}$/u.test(tokens[0])) {
    throw new Error("请填写一个精确模型名；协议、计费单位和能力在详细配置中确认");
  }
  return { base, host: url.hostname, model: tokens[0], price };
}

export async function POST(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  const admin = token ? await verifyAdminToken(token) : null;
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  const parsedBody: unknown = await request.json().catch(() => null);
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown> : {};
  let parsed;
  try { parsed = parseLine(String(body.text || "").trim()); }
  catch (error) {
    return NextResponse.json({ code: "MODEL_HINT_INVALID", error: error instanceof Error ? error.message : "模型信息格式无效" }, { status: 400 });
  }
  if (isPermanentlyRetiredModel({ api_endpoint: parsed.base })) {
    return NextResponse.json({ error: "该渠道已永久退役，不能重新添加", code: "MODEL_PERMANENTLY_RETIRED" }, { status: 409 });
  }
  if (parsed.host === "autodl.art" || parsed.host.endsWith(".autodl.art")) {
    return NextResponse.json({ error: "AutoDL 由已审计的工作流目录管理，不支持此添加入口", code: "AUTODL_CATALOG_ONLY" }, { status: 409 });
  }
  // A name or domain cannot establish a protocol, price unit, capability or
  // activation state. Never probe a credential or create a binding here.
  return NextResponse.json({
    code: "DETAIL_CONFIGURATION_REQUIRED",
    requiresDetails: true,
    parsed,
    message: "已解析非敏感字段。请在详细添加中确认提供商、协议、成本、计费单位和能力，再保存待发布候选。",
  }, { status: 422, headers: { "Cache-Control": "no-store" } });
}
