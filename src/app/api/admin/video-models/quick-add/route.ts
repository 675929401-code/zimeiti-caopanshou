/**
 * 一句话添加视频模型（即见即所得）。
 * 输入一行非敏感文本：渠道地址 + 模型名（可选：售价）；密钥通过独立
 * password 字段只写提交，响应、日志和候选预览均不得回显。
 * 例：https://gaorui.cc/v1 grok-imagine-video-1.5 售价1.2
 * 流程：解析 → 免费契约校验(上游 /v1/models) → 官网价格接口取成本(如可用且数值合理) →
 *       要求管理员明确填写视频售价 → 生成版本化候选。
 * dryRun=true 时只做解析与校验，不落库。
 * 注意：本文件内中文字符一律使用 \\uXXXX 转义，避免 Windows 构建编码歧义。
 */
import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { validateSafeUrl } from "@/lib/safe-fetch";
import crypto from "node:crypto";
import { isPermanentlyRetiredModel } from "@/lib/model-retirement";
import { stageLegacyModelPoolUpsert } from "@/lib/server/platform-configuration-compatibility";

const HOST_RULES: Array<{ test: RegExp; provider: string; protocol: string; tag: string }> = [
  { test: /secure-skill/i, provider: "secure_skill_A", protocol: "newapi_video", tag: "\u6e20\u9053A" },
  { test: /gaorui/i, provider: "gaorui_video", protocol: "gaorui_video", tag: "\u9ad8\u7aef\u6e20\u9053C" },
  { test: /nat6/i, provider: "suanlicheng_video", protocol: "suanlicheng_video", tag: "\u6e20\u9053LC" },
  { test: /lconai/i, provider: "newapi_video", protocol: "newapi_video", tag: "\u6e20\u9053B" },
  { test: /autodl/i, provider: "autodl_comfyui_workflow", protocol: "autodl_comfyui_workflow", tag: "AutoDL" },
];

function parseLine(text: string) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) throw new Error("\u672a\u8bc6\u522b\u5230\u6e20\u9053\u5730\u5740\uff08\u9700 https:// \u5f00\u5934\uff09");
  const base = urlMatch[0].replace(/\/+$/, "").replace(/\/v1$/i, "");
  let rest = text.replace(urlMatch[0], " ");
  const priceMatch = rest.match(/(?:\u552e\u4ef7|\u4ef7\u683c|price)[\uff1a:=\s]*([0-9]+(?:\.[0-9]+)?)/i);
  const price = priceMatch ? Number(priceMatch[1]) : null;
  rest = rest.replace(/(?:\u552e\u4ef7|\u4ef7\u683c|price)[\uff1a:=\s]*[0-9]+(?:\.[0-9]+)?/gi, " ");
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const model = tokens.find((t) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t) && t.length >= 2);
  if (!model) throw new Error("\u672a\u8bc6\u522b\u5230\u6a21\u578b\u540d\uff08\u5b57\u6bcd\u6570\u5b57\u5f00\u5934\uff0c\u53ef\u542b . _ -\uff09");
  return { base, model, price, host: new URL(base).hostname };
}

function parseCredential(value: unknown) {
  const credential = String(value || "").trim();
  if (credential.length < 8 || credential.length > 4096 || /[\r\n\u0000]/u.test(credential)) {
    throw new Error("\u5bc6\u94a5\u672a\u586b\u5199\u6216\u683c\u5f0f\u65e0\u6548\uff1b\u8bf7\u4f7f\u7528\u72ec\u7acb\u5bc6\u7801\u6846\u63d0\u4ea4");
  }
  return credential;
}

async function officialPrice(host: string, model: string): Promise<{ cost: number | null; note: string }> {
  try {
    const origin = new URL("https://" + host).origin;
    const res = await fetch(origin + "/api/pricing", { signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    const row = (j.data || []).find((m: { model_name: string }) => m.model_name === model);
    if (!row) return { cost: null, note: "\u5b98\u7f51\u4ef7\u683c\u63a5\u53e3\u65e0\u6b64\u6a21\u578b" };
    if (row.quota_type === 1 && typeof row.model_price === "number" && row.model_price > 0) {
      const cny = Math.round(row.model_price * 7.3 * 100) / 100;
      if (cny <= 2) return { cost: cny, note: "\u5b98\u7f51\u6309\u6b21\u4ef7 $x7.3" };
      return { cost: null, note: "\u5b98\u7f51\u5217\u8868\u4ef7\u6362\u7b97\u540e\u504f\u5927(\u53ef\u80fd\u4e3a\u7f8e\u5143\u53e3\u5f84)\uff0c\u5df2\u7559\u7a7a\u8bf7\u4eba\u5de5\u586b\u5199" };
    }
    return { cost: null, note: "\u5b98\u7f51\u4e3a\u6309\u91cf\u8ba1\u8d39\uff0c\u8bf7\u4eba\u5de5\u586b\u5199\u6210\u672c" };
  } catch {
    return { cost: null, note: "\u5b98\u7f51\u4ef7\u683c\u63a5\u53e3\u4e0d\u53ef\u8fbe" };
  }
}

export async function POST(req: NextRequest) {
  const token = getTokenFromHeaders(req.headers);
  const admin = token ? await verifyAdminToken(token) : null;
  if (!admin) return NextResponse.json({ error: "\u65e0\u6743\u9650" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const text = String(body.text || "").trim();
  const dryRun = body.dryRun === true;
  if (!text) return NextResponse.json({ error: "\u8bf7\u586b\u5199\u6e20\u9053\u5730\u5740\u3001\u6a21\u578b\u540d\uff08\u53ef\u5e26 \u552e\u4ef7N\uff09\uff0c\u5bc6\u94a5\u653e\u5165\u72ec\u7acb\u5bc6\u7801\u6846" }, { status: 400 });

  let parsed;
  try { parsed = parseLine(text); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "\u89e3\u6790\u5931\u8d25" }, { status: 400 }); }
  let key = "";
  try { key = parseCredential(body.credential); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "\u5bc6\u94a5\u683c\u5f0f\u65e0\u6548" }, { status: 400 }); }
  const { base, model, host } = parsed;
  if (isPermanentlyRetiredModel({ api_endpoint: base })) {
    return NextResponse.json({ error: "\u8be5\u6e20\u9053\u5df2\u6c38\u4e45\u9000\u5f79\uff0c\u4e0d\u80fd\u91cd\u65b0\u6dfb\u52a0", code: "MODEL_PERMANENTLY_RETIRED" }, { status: 409 });
  }
  if (/autodl/i.test(host)) {
    return NextResponse.json({ error: "AutoDL \u4ec5\u5141\u8bb8\u7531\u5ba1\u8ba1\u8fc7\u7684 H3 \u5de5\u4f5c\u6d41\u76ee\u5f55\u7ba1\u7406\uff0c\u4e0d\u652f\u6301\u4e00\u53e5\u8bdd\u6dfb\u52a0", code: "AUTODL_CATALOG_ONLY" }, { status: 409 });
  }
  try { await validateSafeUrl(base + "/v1/models", {}); } catch { return NextResponse.json({ error: "\u6e20\u9053\u5730\u5740\u4e0d\u5b89\u5168\u6216\u88ab\u62d2\u7edd" }, { status: 400 }); }

  // 免费契约校验：密钥有效 + 模型在清单中
  let listed = false;
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (res.ok) { const j = await res.json(); listed = ((j.data || []).some((m: { id: string }) => m.id === model)); }
  } catch { /* 网络错误按未列出处理 */ }
  if (!listed) return NextResponse.json({ error: `\u5951\u7ea6\u6821\u9a8c\u672a\u901a\u8fc7\uff1a\u5bc6\u94a5\u65e0\u6cd5\u5728 ${host} \u7684\u6a21\u578b\u6e05\u5355\u4e2d\u627e\u5230 ${model}\uff1b\u672a\u521b\u5efa\u4efb\u4f55\u6570\u636e` }, { status: 422 });

  const rule = HOST_RULES.find((r) => r.test.test(host)) || { provider: "newapi_video", protocol: "newapi_video", tag: host.replace(/\..*/, "") };
  const { cost, note } = await officialPrice(host, model);
  const costPrice = cost ?? 0;
  if (parsed.price == null) {
    return NextResponse.json({ error: "\u89c6\u9891\u552e\u4ef7\u4e0d\u6309\u7edf\u4e00\u767e\u5206\u6bd4\u81ea\u52a8\u63a8\u7b97\uff1b\u8bf7\u6309\u4ef7\u683c\u8868\u5728\u4e00\u53e5\u8bdd\u672b\u5c3e\u660e\u786e\u586b\u5199 \u552e\u4ef7N" }, { status: 422 });
  }
  const pricePerUse = parsed.price;

  const row = {
    id: `qa-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${crypto.randomBytes(3).toString("hex")}`,
    name: `${model} \u00b7 ${rule.tag}`,
    model_name: model,
    provider: rule.provider,
    api_endpoint: base + "/v1",
    api_key: key,
    protocol_type: rule.protocol,
    billing_mode: "per_use",
    cost_price: costPrice,
    price_per_use: pricePerUse,
    duration_seconds: 5,
    currency: "CNY",
    supports_image_input: true,
    is_active: true,
    is_hidden: false,
    admin_notes: `[quick-add ${new Date().toISOString()}] cost=${costPrice} (${note}); explicit_price=${pricePerUse}`,
  };

  if (dryRun) return NextResponse.json({
    success: true,
    dryRun: true,
    parsed: { base, host, model, price: parsed.price },
    plan: {
      id: row.id,
      name: row.name,
      model_name: row.model_name,
      provider: row.provider,
      api_endpoint: row.api_endpoint,
      credentialConfigured: true,
      protocol_type: row.protocol_type,
      cost_price: row.cost_price,
      price_per_use: row.price_per_use,
    },
    security: { plaintextCredentialReturned: false, credentialSuffixReturned: false },
  });

  const result = await stageLegacyModelPoolUpsert({
    actorId: admin.userId,
    table: "video_models",
    id: row.id,
    values: row,
    changeNote: `一句话新增视频模型 ${model}`,
  });
  return NextResponse.json({ success: true, staged: true, published: false, result, model: { id: row.id, name: row.name, cost: costPrice, price: pricePerUse }, note }, { status: 202 });
}
